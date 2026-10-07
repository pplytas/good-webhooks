import { resolveConfig } from './config.js'
import { WebhookError } from './errors.js'
import { toJson } from './json.js'
import { createStore } from './store.js'
import { APPLICATION_SCOPE, scopeKey } from './scope.js'
import { createWorker } from './worker.js'
import type {
  DeliveryOptions,
  DeliveryQuery,
  EventDefinitions,
  PublishInput,
  PublishOptions,
  Scope,
} from './types.js'

export type { DeliveryOptions } from './types.js'
export type { EndpointSource, EndpointResolution, ManagementScope } from './management/types.js'

/** PostgreSQL publication and delivery, backed by any compatible endpoint source. */
export function createDelivery<const E extends EventDefinitions>(options: DeliveryOptions<E>) {
  const config = resolveConfig(options)
  const definitions = Object.fromEntries(Object.entries(options.events)) as E
  const store = createStore(config)
  const worker = createWorker(config)

  function bind(key: string) {
    return {
      async publish(input: PublishInput<E>, publication?: PublishOptions) {
        if (!input || !Object.hasOwn(definitions, input.type))
          throw new WebhookError('INVALID_INPUT', 'Unknown event type.')
        const { type, data, idempotencyKey } = input
        const transaction = publication?.transaction
        const result = await definitions[type]!['~standard'].validate(data)
        if (result.issues)
          throw new WebhookError('INVALID_INPUT', `Payload does not match event type ${type}.`)
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
      deliverySettings: {
        get: (id: string) => store.getEndpointDeliveryOptions(key, id),
        set: (id: string, settings: { maxInFlight: number }) =>
          store.setEndpointDeliveryOptions(key, id, settings),
      },
    }
  }

  return {
    ...bind(APPLICATION_SCOPE),
    /** Check delivery schema compatibility. Does not apply migrations. */
    check: () => store.checkSchema(),
    /** Worker execution and pruning cover every scope in the configured delivery database and schema. */
    worker,
    /** Selecting a scope does not authorize access. */
    forScope: (scope: Scope) => bind(scopeKey(scope)),
  }
}

export type DeliveryEngine<E extends EventDefinitions> = ReturnType<typeof createDelivery<E>>
