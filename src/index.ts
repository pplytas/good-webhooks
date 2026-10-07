import { createDelivery } from './delivery.js'
import { createPostgresManagement } from './management/postgres.js'
import { WebhookError } from './errors.js'
import { scopeKey } from './scope.js'
import type { ManagementScope } from './management/types.js'
import type {
  CreateEndpointInput,
  EventDefinitions,
  EventName,
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

export { createDelivery } from './delivery.js'
export type { DeliveryEngine } from './delivery.js'
export type { DeliveryOptions } from './types.js'
export type {
  EndpointManagement,
  EndpointSource,
  EndpointResolution,
  ManagementScope,
} from './management/types.js'

/** Compose management and delivery without opening connections or starting workers. */
export function createWebhooks<const E extends EventDefinitions>(options: WebhookOptions<E>) {
  if (!options || !options.events || typeof options.events !== 'object')
    throw new WebhookError('INVALID_CONFIG', 'Define events with Standard Schema validators.')
  const standalone = options.management
    ? undefined
    : createPostgresManagement({
        database: options.database,
        eventTypes: Object.keys(options.events),
        encryptionKey: options.encryptionKey!,
        ...(options.schema === undefined ? {} : { schema: options.schema }),
        ...(options.allowLocalhost === undefined ? {} : { allowLocalhost: options.allowLocalhost }),
      })
  const management = options.management ?? standalone!
  const delivery = createDelivery({ ...options, source: management.source })

  function endpoints(scope: ManagementScope) {
    return {
      create: (input: EndpointInput<E>) => management.create(scope, input),
      list: () => management.list(scope),
      get: (id: string) => management.get(scope, id),
      update: (id: string, patch: EndpointPatch<E>) => management.update(scope, id, patch),
      pause: (id: string) => management.pause(scope, id),
      resume: (id: string) => management.resume(scope, id),
      remove: (id: string) => management.remove(scope, id),
      rotateSecret: (id: string, options?: { graceMs?: number }) =>
        management.rotateSecret(scope, id, options),
    }
  }
  return {
    ...delivery,
    endpoints: endpoints(null),
    async check() {
      await standalone?.check()
      await delivery.check()
    },
    forScope(scope: Scope) {
      const snapshot = { type: scope?.type, id: scope?.id }
      scopeKey(snapshot)
      Object.freeze(snapshot)
      return { ...delivery.forScope(snapshot), endpoints: endpoints(snapshot) }
    },
  }
}

export type Webhooks<E extends EventDefinitions> = ReturnType<typeof createWebhooks<E>>
/** Operations bound to one scope. The host must authorize access before providing this client. */
export type WebhookClient<E extends EventDefinitions> = ReturnType<Webhooks<E>['forScope']>
