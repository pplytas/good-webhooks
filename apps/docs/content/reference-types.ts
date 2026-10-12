import type { DeliveryOptions, EventDefinitions } from 'good-webhooks'
import type { verifyWebhook } from 'good-webhooks/verify'

export type VerifyOptions = Parameters<typeof verifyWebhook>[0]
export type DeliveryConfiguration = DeliveryOptions<EventDefinitions>
export type DeliverySettings = NonNullable<DeliveryConfiguration['delivery']>
export type { PostgresMigrationOptions, PostgresUpgradeOptions } from 'good-webhooks/migrations'
