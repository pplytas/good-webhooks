import { DatabaseSync } from 'node:sqlite'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { createAccessControl } from 'better-auth/plugins/access'
import { organization } from 'better-auth/plugins/organization'
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access'
import { goodWebhooks } from 'good-webhooks/better-auth'

export const eventTypes = ['invoice.created', 'invoice.paid'] as const

export interface ExampleAuthOptions {
  /** App and worker must use the same persistent file, not separate in-memory databases. */
  managementFilename: string
  baseURL: string
  secret: string
  secrets?: BetterAuthOptions['secrets']
}

/** Call explicitly from the app or worker bootstrap. Migrations remain a separate host step. */
export function createExampleAuth(options: ExampleAuthOptions) {
  const database = new DatabaseSync(options.managementFilename)
  const ac = createAccessControl({
    ...defaultStatements,
    webhookEndpoint: ['create', 'read', 'update', 'delete'] as const,
  })
  const auth = betterAuth({
    database,
    baseURL: options.baseURL,
    secret: options.secret,
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    emailAndPassword: { enabled: true },
    plugins: [
      organization({
        ac,
        roles: {
          owner: ac.newRole(ownerAc.statements),
          // This application explicitly grants endpoint management to admins.
          admin: ac.newRole({
            ...adminAc.statements,
            webhookEndpoint: ['create', 'read', 'update', 'delete'],
          }),
          member: ac.newRole(memberAc.statements),
        },
      }),
      goodWebhooks({ eventTypes }),
    ],
  })
  return { auth, database }
}

export type ExampleAuth = ReturnType<typeof createExampleAuth>['auth']
