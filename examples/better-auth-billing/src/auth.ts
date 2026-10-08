import { betterAuth } from 'better-auth'
import { goodWebhooks } from 'good-webhooks/better-auth'
import type { Pool } from 'pg'
import { config } from './config.ts'
import { eventTypes } from './event-types.ts'
export function authOptions(database: Pool) {
  return {
    database,
    baseURL: config.appOrigin,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.appOrigin],
    emailAndPassword: { enabled: true },
    plugins: [goodWebhooks({ eventTypes, allowLocalhost: true })],
  }
}
export function createAuth(database: Pool) {
  return betterAuth(authOptions(database))
}
