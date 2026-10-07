import type { Session, User } from 'better-auth'
import { APIError, requireOrgRole } from 'better-auth/api'
import { hasPermission } from 'better-auth/plugins/organization'
import type { ManagementScope } from '../management/types.js'

export type ManagementAction = 'create' | 'read' | 'update' | 'delete'
export interface ScopeAuthorization {
  scope: ManagementScope
  action: ManagementAction
  user: User
  session: Session
}
export type ScopePolicy = (input: ScopeAuthorization) => boolean | Promise<boolean>
type EndpointContext = Parameters<typeof hasPermission>[1]

const organizationMembership = requireOrgRole({
  orgIdParam: 'organizationId',
  orgIdSource: 'body',
})

/** User and organization scopes always use BA identity checks, never the host override. */
export async function authorizeManagement(
  ctx: EndpointContext,
  requestedScope: ManagementScope | undefined,
  action: ManagementAction,
  policy?: ScopePolicy,
): Promise<ManagementScope> {
  const session = ctx.context.session
  if (!session) throw new APIError('UNAUTHORIZED')
  const scope =
    requestedScope === undefined ? { type: 'user', id: session.user.id } : requestedScope
  if (scope?.type === 'user') {
    if (scope.id !== session.user.id) throw new APIError('FORBIDDEN')
    return scope
  }
  if (scope?.type === 'organization') {
    const plugin = ctx.context.getPlugin('organization')
    if (!plugin)
      throw new APIError('FORBIDDEN', {
        message: 'Organization management requires the organization plugin.',
      })
    // BA's generic middleware type has no body schema, although this middleware
    // explicitly reads the configured body field at runtime.
    const { verifiedMember } = await organizationMembership({
      ...ctx,
      body: { organizationId: scope.id },
      returnHeaders: false,
    } as unknown as Parameters<typeof organizationMembership>[0])
    const member = verifiedMember as { role: string; organizationId: string; userId: string }
    // Numeric coercion or case-insensitive collations must not create alternate
    // namespaces for the same owner, bypassing limits and deletion cleanup.
    if (member.organizationId !== scope.id || member.userId !== session.user.id)
      throw new APIError('FORBIDDEN')
    if (
      !(await hasPermission(
        {
          organizationId: scope.id,
          role: member.role,
          options: plugin.options,
          permissions: { webhookEndpoint: [action] },
          allowCreatorAllPermissions: true,
        },
        ctx,
      ))
    )
      throw new APIError('FORBIDDEN')
    return scope
  }
  if (!policy || !(await policy({ scope, action, user: session.user, session: session.session }))) {
    throw new APIError('FORBIDDEN')
  }
  return scope
}
