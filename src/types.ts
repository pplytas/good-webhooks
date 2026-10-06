import type { StandardSchemaV1 } from '@standard-schema/spec'

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type EventDefinitions = Record<string, StandardSchemaV1>
export type EventName<E extends EventDefinitions> = Extract<keyof E, string>
export type PublishInput<E extends EventDefinitions> = {
  [K in EventName<E>]: { type: K; data: StandardSchemaV1.InferInput<E[K]>; idempotencyKey?: string }
}[EventName<E>]

/** A trusted ownership scope established by your application, never by an untrusted request body. */
export interface TenantContext {
  id: string
}

export interface QueryResult<R> {
  rows: R[]
  rowCount: number | null
}
/** PostgreSQL query executor. node-postgres PoolClient satisfies this interface. */
export interface SqlClient {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>
}
export interface DatabaseClient extends SqlClient {
  release(): void
}
export interface Database extends SqlClient {
  connect(): Promise<DatabaseClient>
}
export interface PublishOptions {
  transaction?: SqlClient
}

export interface WebhookOptions<E extends EventDefinitions> {
  database: Database
  events: E
  encryptionKey: string | Uint8Array
  retry?: { delaysMs?: readonly number[]; maxAgeMs?: number }
  delivery?: {
    timeoutMs?: number
    concurrency?: number
    leaseMs?: number
    maxResponseBytes?: number
    pollIntervalMs?: number
  }
  retentionMs?: number
  /** Development only: permits HTTP and loopback addresses. Other private addresses remain forbidden. */
  allowLocalhost?: boolean
}
export interface ResolvedConfig {
  database: Database
  encryptionKey: Uint8Array
  retryDelaysMs: readonly number[]
  maxAgeMs: number
  timeoutMs: number
  concurrency: number
  leaseMs: number
  maxResponseBytes: number
  pollIntervalMs: number
  retentionMs: number
  allowLocalhost: boolean
}

export type EndpointStatus = 'active' | 'paused' | 'deleted'
export interface Endpoint {
  id: string
  tenantId: string
  url: string
  description: string | null
  eventTypes: string[]
  status: EndpointStatus
  maxInFlight: number
  createdAt: Date
  updatedAt: Date
}
export interface CreateEndpointInput {
  url: string
  description?: string
  eventTypes: readonly string[]
  maxInFlight?: number
}
export interface UpdateEndpointInput {
  url?: string
  description?: string | null
  eventTypes?: readonly string[]
  maxInFlight?: number
}
export interface EndpointWithSecret {
  endpoint: Endpoint
  secret: string
}
export type DeliveryStatus = 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'cancelled'
export interface Delivery {
  id: string
  tenantId: string
  endpointId: string
  eventId: string
  status: DeliveryStatus
  attemptCount: number
  nextAttemptAt: Date
  createdAt: Date
  replayOf: string | null
  lastError: string | null
  lastStatus: number | null
}
export interface Attempt {
  number: number
  startedAt: Date
  finishedAt: Date | null
  outcome: 'started' | 'succeeded' | 'retry' | 'failed' | 'abandoned'
  responseStatus: number | null
  responseBody: string | null
  error: string | null
}
export interface DeliveryDetail extends Delivery {
  attempts: Attempt[]
}
export interface DeliveryQuery {
  endpointId?: string
  status?: DeliveryStatus
  limit?: number
  before?: string
}
export interface Page<T> {
  items: T[]
  nextCursor: string | null
}
export interface PublishResult {
  eventId: string
  deliveryCount: number
  duplicate: boolean
}
export interface WorkerResult {
  claimed: number
  succeeded: number
  retried: number
  failed: number
  stale: number
}

/** Persisted claim. Internal to the worker, never part of a customer's management DTO. */
export interface ClaimedDelivery {
  id: string
  tenantId: string
  endpointId: string
  eventId: string
  token: string
  body: string
  url: string
  secret: string
  previousSecret: string | null
  attemptCount: number
  createdAt: Date
  eventCreatedAt: Date
}
