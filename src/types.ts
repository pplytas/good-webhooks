import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { EndpointManagement, EndpointSource } from './management/types.js'

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type EventDefinitions = Record<string, StandardSchemaV1>
export type EventName<E extends EventDefinitions> = Extract<keyof E, string>
export type PublishInput<E extends EventDefinitions> = {
  [K in EventName<E>]: { type: K; data: StandardSchemaV1.InferInput<E[K]>; idempotencyKey?: string }
}[EventName<E>]

/** An application-defined namespace and identifier. Selecting a scope does not authorize access. */
export interface Scope {
  readonly type: string
  readonly id: string
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

export interface DeliveryOptions<E extends EventDefinitions> {
  database: Database
  events: E
  source: EndpointSource
  retry?: { delaysMs?: readonly number[]; maxAgeMs?: number }
  delivery?: {
    timeoutMs?: number
    concurrency?: number
    leaseMs?: number
    maxResponseBytes?: number
  }
  retentionMs?: number
  /** Development only: permits HTTP and loopback addresses. Other private addresses remain forbidden. */
  allowLocalhost?: boolean
}
export interface WebhookOptions<E extends EventDefinitions> extends Omit<
  DeliveryOptions<E>,
  'source'
> {
  /** Required when using the built-in PostgreSQL management provider. */
  encryptionKey?: string | Uint8Array
  /** Share an existing management provider, including Better Auth management. */
  management?: EndpointManagement
}
export interface ResolvedConfig {
  database: Database
  source: EndpointSource
  retryDelaysMs: readonly number[]
  maxAgeMs: number
  timeoutMs: number
  concurrency: number
  leaseMs: number
  maxResponseBytes: number
  retentionMs: number
  allowLocalhost: boolean
}

export type EndpointStatus = 'active' | 'paused' | 'deleted'
export interface Endpoint {
  id: string
  url: string
  description: string | null
  eventTypes: string[]
  status: EndpointStatus
  createdAt: Date
  updatedAt: Date
}
export interface CreateEndpointInput {
  url: string
  description?: string
  eventTypes: readonly string[]
}
export interface UpdateEndpointInput {
  url?: string
  description?: string | null
  eventTypes?: readonly string[]
}
export interface EndpointWithSecret {
  endpoint: Endpoint
  secret: string
}
export type DeliveryStatus = 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'cancelled'
export interface Delivery {
  id: string
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
  eventId?: string
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
  scopeKey: string
  endpointId: string
  eventId: string
  token: string
  body: string
  url: string
  secrets: readonly string[]
  attemptCount: number
  createdAt: Date
  eventCreatedAt: Date
}
