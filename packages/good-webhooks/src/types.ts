import type { StandardSchemaV1 } from '@standard-schema/spec'
import type {
  AutomaticPauseReason,
  EndpointLimit,
  EndpointManagement,
  EndpointSource,
} from './management/types.js'

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
  /** PostgreSQL schema containing the webhook-prefixed delivery tables. Defaults to public. */
  schema?: string
  events: E
  source: EndpointSource
  retry?: {
    delaysMs?: readonly number[]
    maxAgeMs?: number
    /** Wait at least as long as a 429 or 503 response's Retry-After header asks. Defaults to true. */
    respectRetryAfter?: boolean
  }
  delivery?: {
    timeoutMs?: number
    concurrency?: number
    leaseMs?: number
    maxResponseBytes?: number
  }
  retentionMs?: number
  /** Development only: permits HTTP and loopback addresses. Other private addresses remain forbidden. */
  allowLocalhost?: boolean
  /**
   * Automatically pause endpoints that keep failing or answer HTTP 410. On by default; false turns it off.
   * Running a worker requires an endpoint source with pause(), which the built-in providers have.
   */
  endpointHealth?: false | EndpointHealthOptions
  /** Best-effort callbacks the worker awaits after recording each outcome. Queue slow work instead. */
  hooks?: DeliveryHooks
}
export interface EndpointHealthOptions {
  /** Pause after every attempt has failed for this long. Defaults to five days. */
  pauseAfterMs?: number
  /** Pause as soon as an endpoint answers HTTP 410 Gone. Defaults to true. */
  pauseOnGone?: boolean
}
export interface AttemptEvent {
  scope: Scope | null
  endpointId: string
  deliveryId: string
  eventId: string
  eventType: string
  /** Attempt number within the delivery, starting at 1. */
  attempt: number
  outcome: Exclude<Attempt['outcome'], 'started'>
  responseStatus: number | null
  error: string | null
  durationMs: number
}
export interface EndpointPausedEvent {
  scope: Scope | null
  endpointId: string
  reason: AutomaticPauseReason
}
export interface DeliveryHooks {
  /** Called after each attempt's outcome is recorded. */
  onAttempt?: (event: AttemptEvent) => void | Promise<void>
  /** Called after the worker pauses an endpoint. Manual pauses do not call it. */
  onEndpointPaused?: (event: EndpointPausedEvent) => void | Promise<void>
}
export interface WebhookOptions<E extends EventDefinitions> extends Omit<
  DeliveryOptions<E>,
  'source'
> {
  /** Required when using the built-in PostgreSQL management provider. */
  encryptionKey?: string | Uint8Array
  /** Share an existing management provider, including Better Auth management. */
  management?: EndpointManagement
  /** Built-in PostgreSQL management only: most nondeleted endpoints per scope, from 0 to 1000. */
  maxEndpoints?: EndpointLimit
}
export interface ResolvedConfig {
  database: Database
  schema: string
  source: EndpointSource
  retryDelaysMs: readonly number[]
  maxAgeMs: number
  respectRetryAfter: boolean
  timeoutMs: number
  concurrency: number
  leaseMs: number
  maxResponseBytes: number
  retentionMs: number
  allowLocalhost: boolean
  endpointHealth: Required<EndpointHealthOptions> | null
  hooks: DeliveryHooks
}

export type EndpointStatus = 'active' | 'paused' | 'deleted'
/** Who paused an endpoint: its owner, or the worker after sustained failure or an HTTP 410 answer. */
export type PauseReason = 'owner' | 'failing' | 'gone'
export interface Endpoint {
  id: string
  url: string
  description: string | null
  eventTypes: string[]
  status: EndpointStatus
  /** Set while paused. null when active, deleted, or paused before schema version 5. */
  pauseReason?: PauseReason | null
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
/** The receiver's answer to one test event. Receiver failures are results, not errors. */
export interface TestEventResult {
  eventId: string
  /** A 2xx response with no transport error. */
  ok: boolean
  responseStatus: number | null
  /** The first 4 KiB of the response body. */
  responseBody: string
  durationMs: number
  /** Same values as `Attempt.error`, for example `timeout` or `Receiver returned HTTP 404`. */
  error: string | null
}
export type DeliveryStatus = 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'cancelled'
export interface Delivery {
  id: string
  endpointId: string
  eventId: string
  eventType: string
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
  eventType: string
  token: string
  body: string
  url: string
  secrets: readonly string[]
  /** Endpoint revision the attempt was prepared with, or null when the source reports none. */
  revision: string | null
  attemptCount: number
  createdAt: Date
  eventCreatedAt: Date
}
