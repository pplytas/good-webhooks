import { randomInt, randomUUID } from 'node:crypto'
import { signWebhook } from './crypto.js'
import { scopeFromKey } from './scope.js'
import { postgresTables } from './postgres-schema.js'
import type { EndpointResolution } from './management/types.js'
import type { ClaimedDelivery, DatabaseClient, ResolvedConfig } from './types.js'

export interface DeliveryOutcome {
  status: number | null
  responseBody: string
  error: string | null
  retryable: boolean
  abandoned?: boolean
}
export type Completion = 'succeeded' | 'retried' | 'failed' | 'stale'

type DeliveryRow = {
  id: string
  scope_key: string
  endpoint_id: string
  event_id: string
  attempt_count: number
  created_at: Date
  body: string
  event_created_at: Date
}
type EndpointState = { scope_key: string; endpoint_id: string; max_in_flight: number }
type Reservation = DeliveryRow & { token: string }
type Resolution = { reservation: Reservation } & (
  { endpoint: EndpointResolution; error?: never } | { error: unknown; endpoint?: never }
)

/** Lock delivery-owned endpoint state before deliveries. Never hold a transaction during provider or HTTP calls. */
export function createWorkerStore(config: ResolvedConfig) {
  const tables = postgresTables(config.schema)
  async function transaction<T>(operation: (client: DatabaseClient) => Promise<T>): Promise<T> {
    const client = await config.database.connect()
    try {
      await client.query('BEGIN')
      const value = await operation(client)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  function retryAt(attemptCount: number, createdAt: Date, now: Date): Date | null {
    const delay = config.retryDelaysMs[attemptCount - 1]
    if (delay === undefined || now.getTime() - createdAt.getTime() >= config.maxAgeMs) return null
    // A bounded 0-20% delay avoids synchronized retries without retrying early.
    const jitter = delay > 0 ? randomInt(Math.min(Math.floor(delay / 5), 2 ** 48 - 2) + 1) : 0
    const next = new Date(now.getTime() + delay + jitter)
    return next.getTime() <= createdAt.getTime() + config.maxAgeMs ? next : null
  }

  function exhausted(
    delivery: Pick<DeliveryRow, 'attempt_count' | 'created_at'>,
    now: Date,
  ): boolean {
    return (
      delivery.attempt_count >= config.retryDelaysMs.length + 1 ||
      now.getTime() - delivery.created_at.getTime() >= config.maxAgeMs
    )
  }

  async function recoverExpired(): Promise<void> {
    await transaction(async (client) => {
      const endpoints = await client.query<EndpointState>(`
        SELECT s.scope_key,s.endpoint_id,s.max_in_flight FROM ${tables.endpointState} s
        WHERE EXISTS (SELECT 1 FROM ${tables.deliveries} d
          WHERE d.scope_key=s.scope_key AND d.endpoint_id=s.endpoint_id
          AND d.status='in_flight' AND d.lease_expires_at <= now())
        ORDER BY s.scope_key,s.endpoint_id LIMIT 100 FOR NO KEY UPDATE OF s SKIP LOCKED`)
      for (const endpoint of endpoints.rows) {
        const expired = await client.query<
          Pick<DeliveryRow, 'id' | 'attempt_count' | 'created_at'> & {
            now: Date
            preparing: boolean
          }
        >(
          `SELECT id::text,attempt_count,created_at,preparing,clock_timestamp() AS now
          FROM ${tables.deliveries} WHERE scope_key=$1 AND endpoint_id=$2
          AND status='in_flight' AND lease_expires_at <= now()
          ORDER BY id FOR UPDATE SKIP LOCKED`,
          [endpoint.scope_key, endpoint.endpoint_id],
        )
        for (const delivery of expired.rows) {
          // Provider lookup reservations have not sent anything or consumed an attempt.
          const next = delivery.preparing
            ? exhausted(delivery, delivery.now)
              ? null
              : delivery.now
            : retryAt(delivery.attempt_count, delivery.created_at, delivery.now)
          const error = delivery.preparing
            ? 'Endpoint lookup lease expired before sending'
            : 'Worker lease expired; receiver outcome is unknown'
          if (!delivery.preparing) {
            await client.query(
              `UPDATE ${tables.attempts} SET outcome='abandoned',finished_at=clock_timestamp(),error=$3
              WHERE delivery_id=$1 AND number=$2 AND outcome='started'`,
              [delivery.id, delivery.attempt_count, error],
            )
          }
          await client.query(
            `UPDATE ${tables.deliveries} SET status=$2,preparing=false,claim_token=NULL,lease_expires_at=NULL,
            next_attempt_at=COALESCE($3,next_attempt_at),last_status=NULL,last_error=$4 WHERE id=$1`,
            [delivery.id, next ? 'pending' : 'failed', next, error],
          )
        }
      }
    })
  }

  async function reserve(signal?: AbortSignal): Promise<Reservation[]> {
    return transaction(async (client) => {
      const endpoints = await client.query<EndpointState>(
        `SELECT s.scope_key,s.endpoint_id,s.max_in_flight FROM ${tables.endpointState} s
        JOIN LATERAL (SELECT min(d.next_attempt_at) AS due FROM ${tables.deliveries} d
          WHERE d.scope_key=s.scope_key AND d.endpoint_id=s.endpoint_id
          AND d.status='pending' AND d.next_attempt_at <= now()) pending ON pending.due IS NOT NULL
        WHERE (SELECT count(*) FROM ${tables.deliveries} active
          WHERE active.scope_key=s.scope_key AND active.endpoint_id=s.endpoint_id
          AND active.status='in_flight') < s.max_in_flight
        ORDER BY pending.due,s.scope_key,s.endpoint_id LIMIT $1 FOR NO KEY UPDATE OF s SKIP LOCKED`,
        [config.concurrency],
      )
      const reservations: Reservation[] = []
      for (const endpoint of endpoints.rows) {
        if (signal?.aborted || reservations.length >= config.concurrency) break
        const count = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${tables.deliveries}
          WHERE scope_key=$1 AND endpoint_id=$2 AND status='in_flight'`,
          [endpoint.scope_key, endpoint.endpoint_id],
        )
        const capacity = Math.min(
          endpoint.max_in_flight - count.rows[0]!.count,
          config.concurrency - reservations.length,
        )
        if (capacity <= 0) continue
        const deliveries = await client.query<DeliveryRow & { now: Date }>(
          `SELECT d.id::text,d.scope_key,d.endpoint_id,d.event_id,d.attempt_count,d.created_at,
            e.body,e.created_at AS event_created_at,clock_timestamp() AS now
          FROM ${tables.deliveries} d JOIN ${tables.events} e ON e.id=d.event_id
          WHERE d.scope_key=$1 AND d.endpoint_id=$2 AND d.status='pending' AND d.next_attempt_at <= now()
          ORDER BY d.next_attempt_at,d.id LIMIT $3 FOR UPDATE OF d SKIP LOCKED`,
          [endpoint.scope_key, endpoint.endpoint_id, capacity],
        )
        for (const delivery of deliveries.rows) {
          if (signal?.aborted) break
          if (exhausted(delivery, delivery.now)) {
            await client.query(
              `UPDATE ${tables.deliveries} SET status='failed',last_error='Delivery retry budget expired' WHERE id=$1`,
              [delivery.id],
            )
          } else {
            reservations.push({ ...delivery, token: randomUUID() })
          }
        }
      }
      if (reservations.length) {
        await client.query(
          `UPDATE ${tables.deliveries} d SET status='in_flight',preparing=true,
          claim_token=input.token,lease_expires_at=statement_timestamp()+($3 * interval '1 millisecond')
          FROM unnest($1::bigint[],$2::uuid[]) AS input(id,token) WHERE d.id=input.id`,
          [reservations.map((row) => row.id), reservations.map((row) => row.token), config.leaseMs],
        )
      }
      return reservations
    })
  }

  async function resolve(reservation: Reservation, signal?: AbortSignal): Promise<Resolution> {
    if (signal?.aborted) return { reservation, endpoint: { status: 'paused' } }
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      // Use half the reservation lease for provider reads, leaving time to prepare
      // healthy siblings even when another read stalls. Late results are ignored.
      const endpoint = await Promise.race([
        config.source.resolveEndpoint(scopeFromKey(reservation.scope_key), reservation.endpoint_id),
        new Promise<EndpointResolution>((resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Endpoint lookup exceeded its time budget; delivery deferred.')),
            Math.max(1, Math.floor(config.leaseMs / 2)),
          )
          abort = () => resolve({ status: 'paused' })
          if (signal?.aborted) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        }),
      ])
      if (!endpoint || !['active', 'paused', 'deleted'].includes(endpoint.status))
        throw new Error('Endpoint source returned an invalid endpoint state.')
      if (endpoint.status === 'active') {
        if (typeof endpoint.url !== 'string' || !endpoint.url)
          throw new Error('Endpoint source returned an invalid endpoint URL.')
        // Validate provider signing material before consuming a receiver attempt.
        signWebhook({ id: reservation.event_id, timestamp: 0, body: '', secrets: endpoint.secrets })
        return {
          reservation,
          endpoint: { status: 'active', url: endpoint.url, secrets: [...endpoint.secrets] },
        }
      }
      return { reservation, endpoint }
    } catch (error) {
      return { reservation, error }
    } finally {
      clearTimeout(timer)
      if (abort) signal?.removeEventListener('abort', abort)
    }
  }

  async function claim(
    signal?: AbortSignal,
  ): Promise<{ claims: ClaimedDelivery[]; errors: unknown[] }> {
    if (signal?.aborted) return { claims: [], errors: [] }
    const reservations = await reserve(signal)
    const resolutions = await Promise.all(
      reservations.map((reservation) => resolve(reservation, signal)),
    )
    const claims = await transaction(async (client) => {
      const prepared: ClaimedDelivery[] = []
      // State keys are immutable. NO KEY UPDATE serializes capacity decisions while
      // allowing publication's foreign-key checks to proceed. Use database ordering
      // for every batch, including scope/endpoint IDs with non-ASCII characters.
      await client.query(
        `SELECT s.scope_key,s.endpoint_id FROM ${tables.endpointState} s
        WHERE (s.scope_key,s.endpoint_id) IN (SELECT * FROM unnest($1::text[],$2::text[]))
        ORDER BY s.scope_key,s.endpoint_id FOR NO KEY UPDATE OF s`,
        [
          resolutions.map(({ reservation }) => reservation.scope_key),
          resolutions.map(({ reservation }) => reservation.endpoint_id),
        ],
      )
      for (const resolution of resolutions) {
        const { reservation } = resolution
        if (resolution.endpoint?.status === 'deleted') {
          // An attempt already prepared may finish. Pending and unresolved work cannot start.
          await client.query(
            `UPDATE ${tables.deliveries} SET status='cancelled',preparing=false,claim_token=NULL,
              lease_expires_at=NULL,last_error='Endpoint deleted'
            WHERE scope_key=$1 AND endpoint_id=$2 AND (status='pending' OR (status='in_flight' AND preparing))`,
            [reservation.scope_key, reservation.endpoint_id],
          )
          continue
        }
        if (!resolution.endpoint || resolution.endpoint.status !== 'active' || signal?.aborted) {
          await client.query(
            `UPDATE ${tables.deliveries} SET status='pending',preparing=false,claim_token=NULL,lease_expires_at=NULL,
              next_attempt_at=clock_timestamp()+interval '1 second',last_error=COALESCE($3,last_error)
            WHERE id=$1 AND claim_token=$2 AND status='in_flight' AND preparing`,
            [
              reservation.id,
              reservation.token,
              !resolution.endpoint ? 'Endpoint lookup failed; delivery deferred' : null,
            ],
          )
          continue
        }
        const current = await client.query<{ now: Date }>(
          `SELECT clock_timestamp() AS now FROM ${tables.deliveries} WHERE id=$1 AND claim_token=$2
          AND status='in_flight' AND preparing AND lease_expires_at>clock_timestamp() FOR UPDATE`,
          [reservation.id, reservation.token],
        )
        if (!current.rows[0]) continue
        if (exhausted(reservation, current.rows[0].now)) {
          await client.query(
            `UPDATE ${tables.deliveries} SET status='failed',preparing=false,claim_token=NULL,lease_expires_at=NULL,
            last_error='Delivery retry budget expired' WHERE id=$1 AND claim_token=$2`,
            [reservation.id, reservation.token],
          )
          continue
        }
        prepared.push({
          id: reservation.id,
          scopeKey: reservation.scope_key,
          endpointId: reservation.endpoint_id,
          eventId: reservation.event_id,
          token: reservation.token,
          body: reservation.body,
          url: resolution.endpoint.url,
          secrets: resolution.endpoint.secrets,
          attemptCount: reservation.attempt_count + 1,
          createdAt: reservation.created_at,
          eventCreatedAt: reservation.event_created_at,
        })
      }
      if (prepared.length) {
        // All real attempts begin together, after provider reads, with a fresh send lease.
        const started = await client.query<{ id: string }>(
          `WITH claimed AS (
            UPDATE ${tables.deliveries} d SET preparing=false,attempt_count=d.attempt_count+1,
              lease_expires_at=statement_timestamp()+($3 * interval '1 millisecond')
            FROM unnest($1::bigint[],$2::uuid[]) AS input(id,token)
            WHERE d.id=input.id AND d.claim_token=input.token AND d.status='in_flight' AND d.preparing
              AND d.lease_expires_at>clock_timestamp() RETURNING d.id,d.attempt_count
          ), attempts AS (
            INSERT INTO ${tables.attempts}(delivery_id,number,started_at)
            SELECT id,attempt_count,statement_timestamp() FROM claimed RETURNING delivery_id
          ) SELECT delivery_id::text AS id FROM attempts`,
          [prepared.map((row) => row.id), prepared.map((row) => row.token), config.leaseMs],
        )
        const startedIds = new Set(started.rows.map((row) => row.id))
        return prepared.filter((row) => startedIds.has(row.id))
      }
      return prepared
    })
    return { claims, errors: resolutions.flatMap((row) => (row.endpoint ? [] : [row.error])) }
  }

  async function complete(claim: ClaimedDelivery, outcome: DeliveryOutcome): Promise<Completion> {
    return transaction(async (client) => {
      await client.query(
        `SELECT endpoint_id FROM ${tables.endpointState} WHERE scope_key=$1 AND endpoint_id=$2 FOR NO KEY UPDATE`,
        [claim.scopeKey, claim.endpointId],
      )
      const current = await client.query<{ now: Date }>(
        `SELECT clock_timestamp() AS now FROM ${tables.deliveries}
        WHERE id=$1 AND status='in_flight' AND NOT preparing AND claim_token=$2 AND lease_expires_at > clock_timestamp()
        FOR UPDATE`,
        [claim.id, claim.token],
      )
      if (!current.rows[0]) return 'stale'
      const succeeded =
        !outcome.abandoned &&
        outcome.error === null &&
        outcome.status !== null &&
        outcome.status >= 200 &&
        outcome.status < 300
      const next =
        !succeeded && outcome.retryable
          ? retryAt(claim.attemptCount, claim.createdAt, current.rows[0].now)
          : null
      const completion = succeeded ? 'succeeded' : next ? 'retried' : 'failed'
      const attemptOutcome = outcome.abandoned
        ? 'abandoned'
        : succeeded
          ? 'succeeded'
          : next
            ? 'retry'
            : 'failed'
      await client.query(
        `UPDATE ${tables.attempts} SET outcome=$3,finished_at=clock_timestamp(),response_status=$4,
        response_body=$5,error=$6 WHERE delivery_id=$1 AND number=$2 AND outcome='started'`,
        [
          claim.id,
          claim.attemptCount,
          attemptOutcome,
          outcome.status,
          outcome.responseBody,
          outcome.error,
        ],
      )
      await client.query(
        `UPDATE ${tables.deliveries} SET status=$3,claim_token=NULL,lease_expires_at=NULL,
        next_attempt_at=COALESCE($4,next_attempt_at),last_status=$5,last_error=$6 WHERE id=$1 AND claim_token=$2`,
        [
          claim.id,
          claim.token,
          succeeded ? 'succeeded' : next ? 'pending' : 'failed',
          next,
          outcome.status,
          outcome.error,
        ],
      )
      return completion
    })
  }

  /** Delete at most 100 expired events. Unexpired leases defer deletion to a later invocation. */
  async function prune(): Promise<number> {
    return transaction(async (client) => {
      const candidates = await client.query<{ id: string }>(
        `SELECT e.id FROM ${tables.events} e
        WHERE e.created_at < now()-($1 * interval '1 millisecond')
        AND NOT EXISTS (SELECT 1 FROM ${tables.deliveries} d WHERE d.event_id=e.id
          AND d.status='in_flight' AND d.lease_expires_at>clock_timestamp())
        ORDER BY e.created_at,e.id LIMIT 100`,
        [config.retentionMs],
      )
      if (!candidates.rows.length) return 0
      const ids = candidates.rows.map((row) => row.id)
      const locked = await client.query<{ scope_key: string; endpoint_id: string }>(
        `SELECT s.scope_key,s.endpoint_id FROM ${tables.endpointState} s
        WHERE EXISTS (SELECT 1 FROM ${tables.deliveries} d WHERE d.scope_key=s.scope_key
          AND d.endpoint_id=s.endpoint_id AND d.event_id=ANY($1::uuid[]))
        ORDER BY s.scope_key,s.endpoint_id FOR NO KEY UPDATE OF s SKIP LOCKED`,
        [ids],
      )
      const eligible = await client.query<{ id: string }>(
        `SELECT e.id FROM ${tables.events} e WHERE e.id=ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM ${tables.deliveries} d WHERE d.event_id=e.id
          AND ((d.status='in_flight' AND d.lease_expires_at>clock_timestamp())
            OR NOT EXISTS (SELECT 1 FROM unnest($2::text[],$3::text[]) AS locked(scope_key,endpoint_id)
              WHERE locked.scope_key=d.scope_key AND locked.endpoint_id=d.endpoint_id)))
        ORDER BY e.id FOR UPDATE OF e SKIP LOCKED`,
        [ids, locked.rows.map((row) => row.scope_key), locked.rows.map((row) => row.endpoint_id)],
      )
      if (!eligible.rows.length) return 0
      const deleted = await client.query(`DELETE FROM ${tables.events} WHERE id=ANY($1::uuid[])`, [
        eligible.rows.map((row) => row.id),
      ])
      return deleted.rowCount ?? 0
    })
  }

  return { recoverExpired, claim, complete, prune }
}
