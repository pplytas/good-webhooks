import type { Auth } from 'better-auth'
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import { WebhookError } from '../errors.js'
import { createManagement } from '../management/index.js'
import type { EndpointManagement } from '../management/types.js'
import { createBetterAuthRepository } from './store.js'

export type AuthContext = Awaited<Auth['$context']>

export function managementForContext(
  context: AuthContext,
  options: { eventTypes: readonly string[]; allowLocalhost?: boolean },
): EndpointManagement {
  return createManagement({
    repository: createBetterAuthRepository(context.adapter),
    eventTypes: options.eventTypes,
    ...(options.allowLocalhost === undefined ? {} : { allowLocalhost: options.allowLocalhost }),
    cipher: {
      encrypt: (data) => symmetricEncrypt({ key: context.secretConfig, data }),
      decrypt: (data) => symmetricDecrypt({ key: context.secretConfig, data }),
    },
    async scopeExists(scope) {
      if (scope?.type !== 'user' && scope?.type !== 'organization') return true
      if (scope.type === 'organization' && !context.hasPlugin('organization')) return false
      // Do not convert an adapter error to a missing owner.
      const owner = await context.adapter.findOne<{ id: string }>({
        model: scope.type,
        where: [{ field: 'id', value: scope.id }],
      })
      return owner !== null && owner.id === scope.id
    },
  })
}

/** Trusted capability for backend code or a worker. No listener or user session is needed. */
export async function createBetterAuthManagement(auth: {
  $context: Promise<object>
}): Promise<EndpointManagement> {
  const context = await auth.$context
  const management = (context as AuthContext & { goodWebhooksManagement?: EndpointManagement })
    .goodWebhooksManagement
  if (!management)
    throw new WebhookError(
      'INVALID_CONFIG',
      'Install the goodWebhooks plugin before creating its management provider.',
    )
  return management
}
