import { randomInt, randomUUID } from 'node:crypto'
import { decryptSecret } from './crypto.js'
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
  endpoint_id: string
  event_id: string
  attempt_count: number
  created_at: Date
  body: string
  event_created_at: Date
}
type EndpointRow = {
  id: string
  url: string
  secret: string
  previous_secret: string | null
  previous_secret_expires_at: Date | null
  max_in_flight: number
  status: string
}

/** All mutations lock endpoint, then delivery. Never retain a transaction across HTTP. */
export function createWorkerStore(config: ResolvedConfig) {
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

  async function recoverExpired(): Promise<void> {
    await transaction(async (client) => {
      const endpoints = await client.query<Pick<EndpointRow, 'id' | 'status'>>(`
        SELECT e.id, e.status FROM webhooks.endpoints e
        WHERE EXISTS (SELECT 1 FROM webhooks.deliveries d
          WHERE d.endpoint_id=e.id AND d.status='in_flight' AND d.lease_expires_at <= now())
        ORDER BY e.id LIMIT 100 FOR UPDATE OF e SKIP LOCKED`)
      for (const endpoint of endpoints.rows) {
        const expired = await client.query<
          Pick<DeliveryRow, 'id' | 'attempt_count' | 'created_at'> & { now: Date }
        >(
          `
          SELECT id, attempt_count, created_at, clock_timestamp() AS now FROM webhooks.deliveries
          WHERE endpoint_id=$1 AND status='in_flight' AND lease_expires_at <= now()
          ORDER BY id FOR UPDATE SKIP LOCKED`,
          [endpoint.id],
        )
        for (const delivery of expired.rows) {
          const next = retryAt(delivery.attempt_count, delivery.created_at, delivery.now)
          const status = endpoint.status === 'deleted' ? 'cancelled' : next ? 'pending' : 'failed'
          await client.query(
            `UPDATE webhooks.attempts SET outcome='abandoned', finished_at=clock_timestamp(),
            error='Worker lease expired; receiver outcome is unknown'
            WHERE delivery_id=$1 AND number=$2 AND outcome='started'`,
            [delivery.id, delivery.attempt_count],
          )
          await client.query(
            `UPDATE webhooks.deliveries SET status=$2, claim_token=NULL, lease_expires_at=NULL,
            next_attempt_at=COALESCE($3, next_attempt_at), last_status=NULL, last_error='Worker lease expired; receiver outcome is unknown'
            WHERE id=$1`,
            [delivery.id, status, next],
          )
        }
      }
    })
  }

  async function claim(signal?: AbortSignal): Promise<ClaimedDelivery[]> {
    if (signal?.aborted) return []
    return transaction(async (client) => {
      const endpoints = await client.query<EndpointRow>(
        `
        SELECT e.id, e.url, e.secret, e.previous_secret, e.previous_secret_expires_at, e.max_in_flight, e.status
        FROM webhooks.endpoints e
        JOIN LATERAL (SELECT min(d.next_attempt_at) AS due FROM webhooks.deliveries d
          WHERE d.endpoint_id=e.id AND d.status='pending' AND d.next_attempt_at <= now()) pending ON pending.due IS NOT NULL
        WHERE e.status='active' AND (SELECT count(*) FROM webhooks.deliveries active
          WHERE active.endpoint_id=e.id AND active.status='in_flight') < e.max_in_flight
        ORDER BY pending.due,e.id LIMIT $1 FOR UPDATE OF e SKIP LOCKED`,
        [config.concurrency],
      )
      const claims: ClaimedDelivery[] = []
      // SKIP LOCKED never waits for another endpoint lock and lets LIMIT count available rows.
      for (const endpoint of endpoints.rows) {
        if (signal?.aborted || claims.length >= config.concurrency) break
        const count = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM webhooks.deliveries
          WHERE endpoint_id=$1 AND status='in_flight'`,
          [endpoint.id],
        )
        const capacity = Math.min(
          endpoint.max_in_flight - count.rows[0]!.count,
          config.concurrency - claims.length,
        )
        if (capacity <= 0) continue
        const deliveries = await client.query<DeliveryRow & { now: Date }>(
          `
          SELECT d.id::text, d.endpoint_id, d.event_id, d.attempt_count, d.created_at,
            e.body, e.created_at AS event_created_at, clock_timestamp() AS now
          FROM webhooks.deliveries d JOIN webhooks.events e ON e.id=d.event_id
          WHERE d.endpoint_id=$1 AND d.status='pending' AND d.next_attempt_at <= now()
          ORDER BY d.next_attempt_at, d.id LIMIT $2 FOR UPDATE OF d SKIP LOCKED`,
          [endpoint.id, capacity],
        )
        let secrets: { secret: string; previousSecret: string | null } | undefined
        for (const delivery of deliveries.rows) {
          if (signal?.aborted) break
          if (
            delivery.attempt_count >= config.retryDelaysMs.length + 1 ||
            delivery.now.getTime() - delivery.created_at.getTime() >= config.maxAgeMs
          ) {
            await client.query(
              `UPDATE webhooks.deliveries SET status='failed', last_error='Delivery retry budget expired'
              WHERE id=$1`,
              [delivery.id],
            )
            continue
          }
          // Validate before consuming an attempt. Misconfigured encryption rolls back the whole claim batch.
          secrets ??= {
            secret: decryptSecret(endpoint.secret, config.encryptionKey),
            previousSecret:
              endpoint.previous_secret &&
              endpoint.previous_secret_expires_at &&
              endpoint.previous_secret_expires_at > delivery.now
                ? decryptSecret(endpoint.previous_secret, config.encryptionKey)
                : null,
          }
          const token = randomUUID()
          const attemptCount = delivery.attempt_count + 1
          claims.push({
            id: delivery.id,
            endpointId: delivery.endpoint_id,
            eventId: delivery.event_id,
            token,
            body: delivery.body,
            url: endpoint.url,
            ...secrets,
            attemptCount,
            createdAt: delivery.created_at,
            eventCreatedAt: delivery.event_created_at,
          })
        }
      }
      if (claims.length) {
        // Persist attempts and start every lease together after selection and secret decryption.
        // Endpoint and delivery locks remain held through this final statement and commit.
        await client.query(
          `WITH claimed AS (
            UPDATE webhooks.deliveries d SET status='in_flight',attempt_count=d.attempt_count+1,
              claim_token=input.token,lease_expires_at=statement_timestamp()+($3 * interval '1 millisecond')
            FROM unnest($1::bigint[],$2::uuid[]) AS input(id,token)
            WHERE d.id=input.id RETURNING d.id,d.attempt_count
          )
          INSERT INTO webhooks.attempts(delivery_id,number,started_at)
          SELECT id,attempt_count,statement_timestamp() FROM claimed`,
          [
            claims.map((delivery) => delivery.id),
            claims.map((delivery) => delivery.token),
            config.leaseMs,
          ],
        )
      }
      return claims
    })
  }

  async function complete(claim: ClaimedDelivery, outcome: DeliveryOutcome): Promise<Completion> {
    return transaction(async (client) => {
      await client.query('SELECT id FROM webhooks.endpoints WHERE id=$1 FOR UPDATE', [
        claim.endpointId,
      ])
      const current = await client.query<{ now: Date }>(
        `SELECT clock_timestamp() AS now FROM webhooks.deliveries
        WHERE id=$1 AND status='in_flight' AND claim_token=$2 AND lease_expires_at > clock_timestamp()
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
        `UPDATE webhooks.attempts SET outcome=$3, finished_at=clock_timestamp(), response_status=$4,
        response_body=$5, error=$6 WHERE delivery_id=$1 AND number=$2 AND outcome='started'`,
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
        `UPDATE webhooks.deliveries SET status=$3, claim_token=NULL, lease_expires_at=NULL,
        next_attempt_at=COALESCE($4,next_attempt_at), last_status=$5, last_error=$6 WHERE id=$1 AND claim_token=$2`,
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
        `SELECT id FROM webhooks.events
        WHERE created_at < now()-($1 * interval '1 millisecond')
        AND NOT EXISTS (SELECT 1 FROM webhooks.deliveries d WHERE d.event_id=webhooks.events.id
          AND d.status='in_flight' AND d.lease_expires_at>clock_timestamp())
        ORDER BY created_at,id LIMIT 100`,
        [config.retentionMs],
      )
      if (!candidates.rows.length) return 0
      const ids = candidates.rows.map((row) => row.id)
      // Cascading delivery deletion uses the same endpoint-first ordering as every other mutation.
      const locked = await client.query<{ id: string }>(
        `SELECT e.id FROM webhooks.endpoints e
        WHERE EXISTS (SELECT 1 FROM webhooks.deliveries d WHERE d.endpoint_id=e.id AND d.event_id=ANY($1::uuid[]))
        ORDER BY e.id FOR UPDATE OF e SKIP LOCKED`,
        [ids],
      )
      const eligible = await client.query<{ id: string }>(
        `SELECT e.id FROM webhooks.events e WHERE e.id=ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM webhooks.deliveries d WHERE d.event_id=e.id
          AND ((d.status='in_flight' AND d.lease_expires_at>clock_timestamp()) OR NOT(d.endpoint_id=ANY($2::uuid[]))))
        ORDER BY e.id FOR UPDATE OF e SKIP LOCKED`,
        [ids, locked.rows.map((row) => row.id)],
      )
      if (!eligible.rows.length) return 0
      const deleted = await client.query('DELETE FROM webhooks.events WHERE id=ANY($1::uuid[])', [
        eligible.rows.map((row) => row.id),
      ])
      return deleted.rowCount ?? 0
    })
  }

  return { recoverExpired, claim, complete, prune }
}
