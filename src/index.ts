import { resolveConfig } from './config.js'
import { WebhookError } from './errors.js'
import { toJson } from './json.js'
import { createStore } from './store.js'
import { createWorker } from './worker.js'
import type {
  CreateEndpointInput,
  DeliveryQuery,
  EventDefinitions,
  EventName,
  PublishInput,
  PublishOptions,
  TenantContext,
  UpdateEndpointInput,
  WebhookOptions,
} from './types.js'

export { WebhookError } from './errors.js'
export type { WebhookErrorCode } from './errors.js'
export { generateEncryptionKey, verifyWebhook } from './crypto.js'
export type {
  Attempt,
  Database,
  DatabaseClient,
  Delivery,
  DeliveryDetail,
  DeliveryQuery,
  DeliveryStatus,
  Endpoint,
  EndpointStatus,
  EndpointWithSecret,
  EventDefinitions,
  EventName,
  JsonValue,
  Page,
  PublishInput,
  PublishOptions,
  PublishResult,
  SqlClient,
  TenantContext,
  WebhookOptions,
  WorkerResult,
} from './types.js'
export type EndpointInput<E extends EventDefinitions> = Omit<CreateEndpointInput, 'eventTypes'> & {
  eventTypes: readonly EventName<E>[]
}
export type EndpointPatch<E extends EventDefinitions> = Omit<UpdateEndpointInput, 'eventTypes'> & {
  eventTypes?: readonly EventName<E>[]
}

/** Configure the library without connecting, changing the schema, or starting a background loop. */
export function createWebhooks<const E extends EventDefinitions>(options: WebhookOptions<E>) {
  const config = resolveConfig(options)
  const definitions = Object.fromEntries(Object.entries(options.events)) as E
  const store = createStore(config)
  const worker = createWorker(config)

  function eventTypes(types: readonly string[] | undefined, required = false): void {
    if (types === undefined && !required) return
    if (
      !Array.isArray(types) ||
      types.length === 0 ||
      types.some((type) => !Object.hasOwn(definitions, type))
    ) {
      throw new WebhookError(
        'INVALID_INPUT',
        'eventTypes must be a non-empty list of configured event names.',
      )
    }
  }

  return {
    /** Check schema compatibility after applying migrations. Does not apply DDL. */
    check: () => store.checkSchema(),
    worker,
    /** Authentication and permission checks happen in the host before it supplies this scope. */
    forTenant(context: TenantContext) {
      if (
        !context ||
        typeof context.id !== 'string' ||
        context.id.trim().length === 0 ||
        context.id.length > 200
      ) {
        throw new WebhookError(
          'INVALID_INPUT',
          'A trusted tenant id of 1 to 200 characters is required.',
        )
      }
      const tenantId = context.id
      return {
        endpoints: {
          create: async (input: EndpointInput<E>) => {
            eventTypes(input?.eventTypes, true)
            return store.createEndpoint(tenantId, input)
          },
          list: () => store.listEndpoints(tenantId),
          get: (id: string) => store.getEndpoint(tenantId, id),
          update: async (id: string, patch: EndpointPatch<E>) => {
            if (!patch || typeof patch !== 'object')
              throw new WebhookError('INVALID_INPUT', 'An endpoint patch is required.')
            eventTypes(patch.eventTypes)
            return store.updateEndpoint(tenantId, id, patch)
          },
          pause: (id: string) => store.pauseEndpoint(tenantId, id),
          resume: (id: string) => store.resumeEndpoint(tenantId, id),
          remove: (id: string) => store.removeEndpoint(tenantId, id),
          rotateSecret: (id: string, rotation?: { graceMs?: number }) =>
            store.rotateSecret(tenantId, id, rotation),
        },
        async publish(input: PublishInput<E>, publication?: PublishOptions) {
          if (!input || !Object.hasOwn(definitions, input.type))
            throw new WebhookError('INVALID_INPUT', 'Unknown event type.')
          const { type, data, idempotencyKey } = input
          const transaction = publication?.transaction
          const result = await definitions[type]!['~standard'].validate(data)
          if (result.issues) {
            // Validators can echo sensitive payloads in issue messages. Keep the public error bounded and generic.
            throw new WebhookError('INVALID_INPUT', `Payload does not match event type ${type}.`)
          }
          return store.publish(
            tenantId,
            {
              type,
              data: toJson(result.value),
              ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
            },
            transaction === undefined ? undefined : { transaction },
          )
        },
        deliveries: {
          list: (query?: DeliveryQuery) => store.listDeliveries(tenantId, query),
          get: (id: string) => store.getDelivery(tenantId, id),
          replay: (id: string) => store.replay(tenantId, id),
        },
      }
    },
  }
}

export type Webhooks<E extends EventDefinitions> = ReturnType<typeof createWebhooks<E>>
