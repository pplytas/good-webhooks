// Large-history helpers: seed succeeded deliveries by SQL and prune concurrently with the live phase.
import { setTimeout as sleep } from 'node:timers/promises'
import { history } from './config.mjs'

const spreadMs = Math.round(history.retentionMs / (1 - history.agedShare))

/**
 * Seed rows first..first+count-1 as succeeded deliveries, round-robin over the endpoints, in
 * batches. Each seeded stage is spread evenly in time order over the 10 days ending one minute ago.
 */
export async function seedHistory(pool, schema, first, count) {
  const client = await pool.connect()
  try {
    await client.query('SET statement_timeout = 0')
    const state = await client.query(
      `SELECT scope_key,endpoint_id FROM "${schema}".webhook_endpoint_state ORDER BY scope_key,endpoint_id`,
    )
    const scopeKeys = state.rows.map((row) => row.scope_key)
    const endpointIds = state.rows.map((row) => row.endpoint_id)
    const end = (await client.query(`SELECT now() - interval '1 minute' AS end`)).rows[0].end
    for (let from = first; from < first + count; from += history.batchSize) {
      const to = Math.min(first + count, from + history.batchSize) - 1
      // One statement per batch; the foreign keys are checked when it ends.
      await client.query(
        `WITH source AS MATERIALIZED (
          SELECT n, md5('history:' || n)::uuid AS id, ($3::text[])[1 + n % $5] AS scope_key,
            ($4::text[])[1 + n % $5] AS endpoint_id,
            $6::timestamptz - (1 - (n - $7 + 0.5) / $8)::float8 * ($9 * interval '1 millisecond') AS created_at
          FROM generate_series($1::bigint,$2::bigint) AS n
        ), events AS (
          INSERT INTO "${schema}".webhook_events(id,scope_key,type,body,fingerprint,idempotency_key,created_at)
          SELECT id,scope_key,'benchmark.event',
            json_build_object('id',id,'type','benchmark.event','occurredAt',created_at,
              'data',json_build_object('endpoint',n % $5,'sequence',n))::text,
            'history','history:' || n,created_at FROM source
        ), deliveries AS (
          INSERT INTO "${schema}".webhook_deliveries(scope_key,endpoint_id,event_id,status,attempt_count,
            next_attempt_at,created_at,window_started_at,replay_of,last_status)
          SELECT scope_key,endpoint_id,id,'succeeded',1,created_at,created_at,created_at,NULL,204
          FROM source ORDER BY n RETURNING id,created_at
        )
        INSERT INTO "${schema}".webhook_attempts(delivery_id,number,started_at,finished_at,outcome,response_status)
        SELECT id,1,created_at,created_at + interval '15 milliseconds','succeeded',204 FROM deliveries`,
        [from, to, scopeKeys, endpointIds, scopeKeys.length, end, first, count, spreadMs],
      )
    }
    // VACUUM as autovacuum would on a long-lived table: it sets hint bits and the visibility map,
    // so the live phase does not pay for the bulk load. It also refreshes planner statistics.
    for (const table of ['webhook_events', 'webhook_deliveries', 'webhook_attempts'])
      await client.query(`VACUUM (ANALYZE) "${schema}".${table}`)
  } finally {
    client.release()
  }
}

export async function tableStats(pool, schema) {
  const result = await pool.query(
    `SELECT pg_total_relation_size('"${schema}".webhook_events')::float8 AS events,
      pg_total_relation_size('"${schema}".webhook_deliveries')::float8 AS deliveries,
      pg_total_relation_size('"${schema}".webhook_attempts')::float8 AS attempts,
      (SELECT count(*) FROM "${schema}".webhook_deliveries)::int AS delivery_count,
      (SELECT count(*) FROM "${schema}".webhook_events)::int AS event_count`,
  )
  const row = result.rows[0]
  return {
    deliveries: row.delivery_count,
    events: row.event_count,
    tableBytes: { events: row.events, deliveries: row.deliveries, attempts: row.attempts },
  }
}

/** Run prune() back to back, pausing 50 ms only when nothing was deleted. stop() returns totals. */
export function startPruneLoop(app, onError) {
  const stats = { calls: 0, eventsDeleted: 0, totalMs: 0 }
  let stopping = false
  const loop = (async () => {
    while (!stopping) {
      const started = performance.now()
      const deleted = await app.worker.prune()
      stats.totalMs += performance.now() - started
      stats.calls++
      stats.eventsDeleted += deleted
      if (!deleted) await sleep(50)
    }
  })().catch(onError)
  return async () => {
    stopping = true
    await loop
    return {
      calls: stats.calls,
      eventsDeleted: stats.eventsDeleted,
      meanMs: stats.calls ? +(stats.totalMs / stats.calls).toFixed(2) : null,
    }
  }
}
