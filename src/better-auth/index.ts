import type { BetterAuthPlugin } from 'better-auth'
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  sensitiveSessionMiddleware,
} from 'better-auth/api'
import * as z from 'zod'
import { WebhookError } from '../errors.js'
import type { EndpointManagement, ManagedEndpoint, ManagementScope } from '../management/types.js'
import { authorizeManagement, type ManagementAction, type ScopePolicy } from './authorization.js'
import { managementForContext, type AuthContext } from './provider.js'
import { createBetterAuthManagementSchema } from './schema.js'

export { createBetterAuthManagement } from './provider.js'
export type { ManagementAction, ScopeAuthorization, ScopePolicy } from './authorization.js'

export interface GoodWebhooksOptions<EventTypes extends readonly string[] = readonly string[]> {
  eventTypes: EventTypes
  /** Development only: allow HTTP localhost destinations. */
  allowLocalhost?: boolean
  schema?: Parameters<typeof createBetterAuthManagementSchema>[0]
  /** Required for application and custom scopes. User/org scopes always use native BA authorization. */
  authorizeScope?: ScopePolicy
}

export type WebhookEndpointDTO<EventType extends string = string> = Omit<
  ManagedEndpoint,
  'createdAt' | 'updatedAt' | 'eventTypes'
> & {
  createdAt: string
  updatedAt: string
  eventTypes: EventType[]
}

function toDTO<EventType extends string>(endpoint: ManagedEndpoint): WebhookEndpointDTO<EventType> {
  return {
    ...endpoint,
    eventTypes: endpoint.eventTypes as EventType[],
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
  }
}

function mapError(error: unknown): never {
  if (!(error instanceof WebhookError)) throw error
  const status =
    error.code === 'NOT_FOUND'
      ? 'NOT_FOUND'
      : error.code === 'INVALID_STATE'
        ? 'CONFLICT'
        : error.code === 'INVALID_INPUT' || error.code === 'UNSAFE_URL'
          ? 'BAD_REQUEST'
          : 'INTERNAL_SERVER_ERROR'
  throw new APIError(status, {
    code: error.code,
    message: status === 'INTERNAL_SERVER_ERROR' ? 'Webhook management failed.' : error.message,
  })
}

/** Authenticated endpoint management. Does not publish events or start delivery workers. */
export function goodWebhooks<const EventTypes extends readonly string[]>(
  options: GoodWebhooksOptions<EventTypes>,
) {
  type EventType = EventTypes[number]
  const providerOptions = {
    eventTypes: [...options.eventTypes],
    ...(options.allowLocalhost === undefined ? {} : { allowLocalhost: options.allowLocalhost }),
  }
  const authorizeScope = options.authorizeScope
  const eventType = z.custom<EventType>(
    (value) => typeof value === 'string' && providerOptions.eventTypes.includes(value),
    'Unknown webhook event type',
  )
  const scope = z
    .object({ type: z.string().min(1).max(64), id: z.string().min(1).max(200) })
    .strict()
    .nullable()
    .optional()
  const base = z.object({ scope }).strict()
  const target = base.extend({ id: z.string().min(1) })
  const config = {
    url: z.string(),
    description: z.string().optional(),
    eventTypes: z.array(eventType).min(1).max(100),
  }
  const createBody = base.extend(config)
  const updateBody = target.extend({
    url: config.url.optional(),
    description: z.string().nullable().optional(),
    eventTypes: config.eventTypes.optional(),
  })

  function route<
    Path extends string,
    Body extends z.ZodType<{ scope?: ManagementScope | undefined }>,
    Result,
  >(
    path: Path,
    body: Body,
    action: ManagementAction,
    run: (
      management: EndpointManagement,
      scope: ManagementScope,
      body: z.output<Body>,
    ) => Promise<Result>,
  ) {
    return createAuthEndpoint(
      path,
      {
        method: 'POST',
        body,
        use: [sensitiveSessionMiddleware],
        metadata: { noStore: true },
      },
      async (ctx) => {
        const input = ctx.body as z.output<Body>
        const resolvedScope = await authorizeManagement(ctx, input.scope, action, authorizeScope)
        try {
          return await run(managementForContext(ctx.context, providerOptions), resolvedScope, input)
        } catch (error) {
          return mapError(error)
        }
      },
    )
  }

  return {
    id: 'good-webhooks',
    options,
    schema: createBetterAuthManagementSchema(options.schema),
    init(context: AuthContext) {
      const management = managementForContext(context, providerOptions)
      return {
        context: { goodWebhooksManagement: management },
        options: {
          databaseHooks: {
            user: {
              delete: {
                after: async (user: { id: string }) => {
                  await management.removeScope({ type: 'user', id: user.id })
                },
              },
            },
          },
        },
      }
    },
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path === '/organization/delete',
          handler: createAuthMiddleware(async (ctx) => {
            const organizationId = ctx.body?.organizationId
            if (typeof organizationId !== 'string') return
            const owner = await ctx.context.adapter.findOne({
              model: 'organization',
              where: [{ field: 'id', value: organizationId }],
            })
            if (!owner)
              await managementForContext(ctx.context, providerOptions).removeScope({
                type: 'organization',
                id: organizationId,
              })
          }),
        },
      ],
    },
    endpoints: {
      createWebhookEndpoint: route(
        '/good-webhooks/create',
        createBody,
        'create',
        async (management, scope, body) => {
          const result = await management.create(scope, {
            url: body.url,
            eventTypes: body.eventTypes,
            ...(body.description === undefined ? {} : { description: body.description }),
          })
          return { endpoint: toDTO<EventType>(result.endpoint), secret: result.secret }
        },
      ),
      listWebhookEndpoints: route('/good-webhooks/list', base, 'read', async (management, scope) =>
        (await management.list(scope)).map(toDTO<EventType>),
      ),
      getWebhookEndpoint: route(
        '/good-webhooks/get',
        target,
        'read',
        async (management, scope, body) => toDTO<EventType>(await management.get(scope, body.id)),
      ),
      updateWebhookEndpoint: route(
        '/good-webhooks/update',
        updateBody,
        'update',
        async (management, scope, body) =>
          toDTO<EventType>(
            await management.update(scope, body.id, {
              ...(body.url === undefined ? {} : { url: body.url }),
              ...(body.description === undefined ? {} : { description: body.description }),
              ...(body.eventTypes === undefined ? {} : { eventTypes: body.eventTypes }),
            }),
          ),
      ),
      pauseWebhookEndpoint: route(
        '/good-webhooks/pause',
        target,
        'update',
        async (management, scope, body) => toDTO<EventType>(await management.pause(scope, body.id)),
      ),
      resumeWebhookEndpoint: route(
        '/good-webhooks/resume',
        target,
        'update',
        async (management, scope, body) =>
          toDTO<EventType>(await management.resume(scope, body.id)),
      ),
      removeWebhookEndpoint: route(
        '/good-webhooks/remove',
        target,
        'delete',
        async (management, scope, body) =>
          toDTO<EventType>(await management.remove(scope, body.id)),
      ),
      rotateWebhookEndpointSecret: route(
        '/good-webhooks/rotate-secret',
        target.extend({ graceMs: z.number().int().min(0).max(86_400_000).optional() }),
        'update',
        async (management, scope, body) => {
          const result = await management.rotateSecret(
            scope,
            body.id,
            body.graceMs === undefined ? undefined : { graceMs: body.graceMs },
          )
          return { endpoint: toDTO<EventType>(result.endpoint), secret: result.secret }
        },
      ),
    },
  } satisfies BetterAuthPlugin
}
