import { resolveConfig } from './config.js'
import { WebhookError } from './errors.js'
import { toJson } from './json.js'
import { createStore } from './store.js'
import { APPLICATION_SCOPE, scopeKey } from './scope.js'
import { createWorker } from './worker.js'
import type {
  CreateEndpointInput,
  DeliveryQuery,
  EventDefinitions,
  EventName,
  PublishInput,
  PublishOptions,
  Scope,
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
  Scope,
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

  function bind(key: string) {
    return {
      endpoints: {
        create: async (input: EndpointInput<E>) => {
          eventTypes(input?.eventTypes, true)
          return store.createEndpoint(key, input)
        },
        list: () => store.listEndpoints(key),
        get: (id: string) => store.getEndpoint(key, id),
        update: async (id: string, patch: EndpointPatch<E>) => {
          if (!patch || typeof patch !== 'object')
            throw new WebhookError('INVALID_INPUT', 'An endpoint patch is required.')
          eventTypes(patch.eventTypes)
          return store.updateEndpoint(key, id, patch)
        },
        pause: (id: string) => store.pauseEndpoint(key, id),
        resume: (id: string) => store.resumeEndpoint(key, id),
        remove: (id: string) => store.removeEndpoint(key, id),
        rotateSecret: (id: string, rotation?: { graceMs?: number }) =>
          store.rotateSecret(key, id, rotation),
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
          key,
          {
            type,
            data: toJson(result.value),
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          },
          transaction === undefined ? undefined : { transaction },
        )
      },
      deliveries: {
        list: (query?: DeliveryQuery) => store.listDeliveries(key, query),
        get: (id: string) => store.getDelivery(key, id),
        replay: (id: string) => store.replay(key, id),
      },
    }
  }

  return {
    ...bind(APPLICATION_SCOPE),
    /** Check schema compatibility after applying migrations. Does not apply DDL. */
    check: () => store.checkSchema(),
    /** Worker execution and pruning cover all scopes in the configured database. */
    worker,
    /** Select an isolated scope after the host has authenticated and authorized the caller. */
    forScope: (scope: Scope) => bind(scopeKey(scope)),
  }
}

export type Webhooks<E extends EventDefinitions> = ReturnType<typeof createWebhooks<E>>
/** Operations bound to one scope, suitable for passing into application request handlers. */
export type WebhookClient<E extends EventDefinitions> = ReturnType<Webhooks<E>['forScope']>
