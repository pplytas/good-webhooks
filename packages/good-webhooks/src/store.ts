import { createHash, randomUUID } from 'node:crypto'
import { scopeFromKey } from './scope.js'
import { postgresTables, resolvePostgresSchema } from './postgres-schema.js'
import { WebhookError } from './errors.js'
import type {
  Attempt,
  Delivery,
  DeliveryDetail,
  DeliveryQuery,
  JsonValue,
  Page,
  PublishOptions,
  PublishResult,
  ResolvedConfig,
  SqlClient,
} from './types.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BIGINT = 9223372036854775807n
const DELIVERY_STATUSES = new Set(['pending', 'in_flight', 'succeeded', 'failed', 'cancelled'])
const DELIVERY_FIELDS =
  'id::text, scope_key, endpoint_id, event_id, status, attempt_count, next_attempt_at, created_at, replay_of::text, last_error, last_status'

interface DeliveryRow extends Record<string, unknown> {
  id: string
  scope_key: string
  endpoint_id: string
  event_id: string
  status: Delivery['status']
  attempt_count: number
  next_attempt_at: Date
  created_at: Date
  replay_of: string | null
  last_error: string | null
  last_status: number | null
}
interface DeliveryHistoryRow extends DeliveryRow {
  number: number | null
  started_at: Date | null
  finished_at: Date | null
  outcome: Attempt['outcome'] | null
  response_status: number | null
  response_body: string | null
  error: string | null
}

function delivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventId: row.event_id,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    replayOf: row.replay_of,
    lastError: row.last_error,
    lastStatus: row.last_status,
  }
}

function invalid(message: string): never {
  throw new WebhookError('INVALID_INPUT', message)
}
function object(value: unknown, name: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(`${name} must be an object.`)
}
function scope(key: string): void {
  if (typeof key !== 'string' || !key.trim() || key.length > 2048 || key.includes('\0'))
    invalid('Invalid internal scope key.')
}
function endpointId(id: string): void {
  if (typeof id !== 'string' || !id.trim() || id.length > 2048 || id.includes('\0'))
    invalid('Endpoint id must contain 1–2048 characters and no null bytes.')
}
function deliveryId(id: string): void {
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > MAX_BIGINT)
    invalid('Delivery id must be a positive PostgreSQL bigint string.')
}
function eventType(type: string): void {
  if (typeof type !== 'string' || !type.trim() || type.length > 120 || type.includes('\0'))
    invalid('An event name must contain 1–120 characters and no null bytes.')
}
function maxInFlight(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50)
    invalid('maxInFlight must be an integer from 1 to 50.')
  return value
}
function postgresCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined
}

/** Delivery acceptance serializes within each scope, including caller-owned transactions. */
async function lockScope(client: SqlClient, schema: string, scopeKey: string): Promise<void> {
  // Schema is part of the installation identity; tuples avoid ambiguous concatenation.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `good-webhooks:delivery:${JSON.stringify([schema, scopeKey])}`,
  ])
}

export function createStore(config: ResolvedConfig) {
  const schema = resolvePostgresSchema(config.schema)
  const tables = postgresTables(schema)
  async function transaction<T>(
    run: (client: SqlClient) => Promise<T>,
    supplied?: SqlClient,
  ): Promise<T> {
    if (supplied) {
      const savepoint = `webhooks_${randomUUID().replaceAll('-', '')}`
      try {
        await supplied.query(`SAVEPOINT ${savepoint}`)
      } catch (error) {
        if (postgresCode(error) === '25P01')
          throw new WebhookError(
            'TRANSACTION_REQUIRED',
            'Publication requires a client inside an active BEGIN transaction.',
            { cause: error },
          )
        throw error
      }
      try {
        const result = await run(supplied)
        await supplied.query(`RELEASE SAVEPOINT ${savepoint}`)
        return result
      } catch (error) {
        await supplied.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => {})
        await supplied.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => {})
        throw error
      }
    }
    const client = await config.database.connect()
    try {
      await client.query('BEGIN')
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async function checkSchema(): Promise<void> {
    try {
      const result = await config.database.query<{ version: number }>(
        `SELECT version FROM ${tables.schemaVersion} ORDER BY version`,
      )
      if (result.rows.length !== 1 || result.rows[0]?.version !== 3) {
        throw new WebhookError(
          'SCHEMA_MISMATCH',
          'Expected webhook delivery schema version 3. Older prototypes require an explicit upgrade or a fresh database; the initial migration does not upgrade existing data.',
        )
      }
    } catch (error) {
      if (error instanceof WebhookError) throw error
      if (['42P01', '3F000', '42703'].includes(postgresCode(error) ?? '')) {
        throw new WebhookError(
          'SCHEMA_MISMATCH',
          `Webhook delivery schema ${JSON.stringify(schema)} is missing or incompatible. Generate matching SQL with getPostgresMigration({ schema: ${JSON.stringify(schema)}, component: 'delivery' }).`,
          { cause: error },
        )
      }
      throw error
    }
  }

  async function publish(
    scopeKey: string,
    input: { type: string; data: JsonValue; idempotencyKey?: string },
    options: PublishOptions = {},
  ): Promise<PublishResult> {
    scope(scopeKey)
    object(input, 'Event input')
    object(options, 'Publication options')
    eventType(input.type)
    if (
      input.idempotencyKey !== undefined &&
      (typeof input.idempotencyKey !== 'string' ||
        !input.idempotencyKey.trim() ||
        input.idempotencyKey.length > 200 ||
        input.idempotencyKey.includes('\0'))
    )
      invalid('Idempotency key must contain 1–200 characters and no null bytes.')
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([input.type, input.data]))
      .digest('hex')
    async function existingPublication(client: SqlClient): Promise<PublishResult | null> {
      if (input.idempotencyKey === undefined) return null
      const existing = await client.query<{ id: string; fingerprint: string; count: number }>(
        `SELECT e.id,e.fingerprint,(SELECT count(*)::integer FROM ${tables.deliveries} d
          WHERE d.event_id=e.id AND d.replay_of IS NULL) AS count
        FROM ${tables.events} e WHERE e.scope_key=$1 AND e.idempotency_key=$2`,
        [scopeKey, input.idempotencyKey],
      )
      if (!existing.rows[0]) return null
      if (existing.rows[0].fingerprint !== fingerprint)
        throw new WebhookError(
          'IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for a different event type or payload.',
        )
      return {
        eventId: existing.rows[0].id,
        deliveryCount: existing.rows[0].count,
        duplicate: true,
      }
    }

    // Accepted repeats do not depend on management storage remaining available.
    const existing = options.transaction
      ? await transaction(existingPublication, options.transaction)
      : await existingPublication(config.database)
    if (existing) return existing
    const matched = await config.source.matchRecipients(scopeFromKey(scopeKey), input.type)
    if (!Array.isArray(matched)) invalid('Endpoint source must return a complete array of IDs.')
    const recipients = [...new Set(matched)]
    for (const id of recipients) endpointId(id)
    return transaction(async (client) => {
      await lockScope(client, schema, scopeKey)
      // A concurrent publication may have committed while this caller resolved recipients.
      const accepted = await existingPublication(client)
      if (accepted) return accepted
      const eventId = randomUUID()
      const time = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
      const occurredAt = time.rows[0]!.now
      const body = JSON.stringify({
        id: eventId,
        type: input.type,
        occurredAt: occurredAt.toISOString(),
        data: input.data,
      })
      await client.query(
        `INSERT INTO ${tables.events}(id,scope_key,type,body,fingerprint,idempotency_key,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          eventId,
          scopeKey,
          input.type,
          body,
          fingerprint,
          input.idempotencyKey ?? null,
          occurredAt,
        ],
      )
      await client.query(
        `INSERT INTO ${tables.endpointState}(scope_key,endpoint_id)
        SELECT $1,id FROM unnest($2::text[]) AS input(id)
        ON CONFLICT (scope_key,endpoint_id) DO NOTHING`,
        [scopeKey, recipients],
      )
      const result = await client.query(
        `INSERT INTO ${tables.deliveries}(scope_key,endpoint_id,event_id)
        SELECT $1,id,$2 FROM unnest($3::text[]) AS input(id)`,
        [scopeKey, eventId, recipients],
      )
      return { eventId, deliveryCount: result.rowCount ?? 0, duplicate: false }
    }, options.transaction)
  }

  async function listDeliveries(
    scopeKey: string,
    query: DeliveryQuery = {},
  ): Promise<Page<Delivery>> {
    scope(scopeKey)
    object(query, 'Delivery query')
    if (query.endpointId !== undefined) endpointId(query.endpointId)
    if (
      query.eventId !== undefined &&
      (typeof query.eventId !== 'string' || !UUID.test(query.eventId))
    )
      invalid('Event id must be a UUID.')
    if (query.before !== undefined) deliveryId(query.before)
    if (query.status !== undefined && !DELIVERY_STATUSES.has(query.status))
      invalid('Unknown delivery status.')
    const limit = query.limit ?? 25
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      invalid('Delivery list limit must be an integer from 1 to 100.')
    // Sort the bigint column, not the text output named "id", to match the cursor comparison.
    const { rows } = await config.database.query<DeliveryRow>(
      `SELECT ${DELIVERY_FIELDS} FROM ${tables.deliveries} AS d WHERE scope_key=$1 AND ($2::text IS NULL OR endpoint_id=$2) AND ($3::text IS NULL OR status=$3) AND ($4::bigint IS NULL OR id<$4) AND ($6::uuid IS NULL OR event_id=$6) ORDER BY d.id DESC LIMIT $5`,
      [
        scopeKey,
        query.endpointId ?? null,
        query.status ?? null,
        query.before ?? null,
        limit + 1,
        query.eventId ?? null,
      ],
    )
    const items = rows.slice(0, limit).map(delivery)
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null }
  }

  async function getDelivery(scopeKey: string, id: string): Promise<DeliveryDetail> {
    scope(scopeKey)
    deliveryId(id)
    const { rows } = await config.database.query<DeliveryHistoryRow>(
      `WITH delivery AS (
        SELECT ${DELIVERY_FIELDS} FROM ${tables.deliveries} WHERE scope_key=$1 AND id=$2
      )
      SELECT d.*,a.number,a.started_at,a.finished_at,a.outcome,a.response_status,a.response_body,a.error
      FROM delivery d LEFT JOIN ${tables.attempts} a ON a.delivery_id=d.id::bigint ORDER BY a.number`,
      [scopeKey, id],
    )
    if (!rows[0]) throw new WebhookError('NOT_FOUND', 'Delivery not found in this scope.')
    return {
      ...delivery(rows[0]),
      attempts: rows.flatMap((row) =>
        row.number === null
          ? []
          : [
              {
                number: row.number,
                startedAt: row.started_at!,
                finishedAt: row.finished_at,
                outcome: row.outcome!,
                responseStatus: row.response_status,
                responseBody: row.response_body,
                error: row.error,
              },
            ],
      ),
    }
  }

  async function replay(scopeKey: string, id: string): Promise<Delivery> {
    scope(scopeKey)
    deliveryId(id)
    const found = await config.database.query<{ endpoint_id: string }>(
      `SELECT endpoint_id FROM ${tables.deliveries} WHERE scope_key=$1 AND id=$2`,
      [scopeKey, id],
    )
    if (!found.rows[0]) throw new WebhookError('NOT_FOUND', 'Delivery not found in this scope.')
    const target = await config.source.resolveEndpoint(
      scopeFromKey(scopeKey),
      found.rows[0].endpoint_id,
    )
    if (target.status !== 'active')
      throw new WebhookError('INVALID_STATE', 'Replay requires an active endpoint.')
    return transaction(async (client) => {
      await lockScope(client, schema, scopeKey)
      await client.query(
        `SELECT endpoint_id FROM ${tables.endpointState} WHERE scope_key=$1 AND endpoint_id=$2 FOR NO KEY UPDATE`,
        [scopeKey, found.rows[0]!.endpoint_id],
      )
      const original = await client.query<DeliveryRow>(
        `SELECT ${DELIVERY_FIELDS} FROM ${tables.deliveries} WHERE scope_key=$1 AND id=$2 FOR UPDATE`,
        [scopeKey, id],
      )
      const row = original.rows[0]
      if (!row) throw new WebhookError('NOT_FOUND', 'Delivery not found in this scope.')
      if (row.replay_of !== null || !['succeeded', 'failed'].includes(row.status))
        throw new WebhookError(
          'INVALID_STATE',
          'Only an original succeeded or failed delivery can be replayed.',
        )
      const retained = await client.query<{ valid: boolean }>(
        `SELECT created_at>clock_timestamp()-$3::bigint*interval '1 millisecond' AS valid FROM ${tables.events} WHERE scope_key=$1 AND id=$2`,
        [scopeKey, row.event_id, config.retentionMs],
      )
      if (!retained.rows[0]?.valid)
        throw new WebhookError('INVALID_STATE', 'The event is outside the replay retention window.')
      const active = await client.query(
        `SELECT id FROM ${tables.deliveries} WHERE scope_key=$1 AND replay_of=$2 AND status IN ('pending','in_flight')`,
        [scopeKey, id],
      )
      if (active.rows.length)
        throw new WebhookError(
          'REPLAY_IN_PROGRESS',
          'This delivery already has a pending or in-flight replay.',
        )
      const inserted = await client.query<DeliveryRow>(
        `INSERT INTO ${tables.deliveries}(scope_key,endpoint_id,event_id,replay_of) VALUES ($1,$2,$3,$4) RETURNING ${DELIVERY_FIELDS}`,
        [scopeKey, row.endpoint_id, row.event_id, id],
      )
      return delivery(inserted.rows[0]!)
    })
  }

  async function getEndpointDeliveryOptions(
    scopeKey: string,
    id: string,
  ): Promise<{ maxInFlight: number }> {
    scope(scopeKey)
    endpointId(id)
    const resolved = await config.source.resolveEndpoint(scopeFromKey(scopeKey), id)
    if (resolved.status === 'deleted')
      throw new WebhookError('NOT_FOUND', 'Endpoint not found in this scope.')
    const result = await config.database.query<{ max_in_flight: number }>(
      `SELECT max_in_flight FROM ${tables.endpointState} WHERE scope_key=$1 AND endpoint_id=$2`,
      [scopeKey, id],
    )
    return { maxInFlight: result.rows[0]?.max_in_flight ?? 2 }
  }

  async function setEndpointDeliveryOptions(
    scopeKey: string,
    id: string,
    options: { maxInFlight: number },
  ): Promise<{ maxInFlight: number }> {
    scope(scopeKey)
    endpointId(id)
    object(options, 'Delivery options')
    const value = maxInFlight(options.maxInFlight)
    const resolved = await config.source.resolveEndpoint(scopeFromKey(scopeKey), id)
    if (resolved.status === 'deleted')
      throw new WebhookError('NOT_FOUND', 'Endpoint not found in this scope.')
    await config.database.query(
      `INSERT INTO ${tables.endpointState}(scope_key,endpoint_id,max_in_flight) VALUES ($1,$2,$3)
      ON CONFLICT (scope_key,endpoint_id) DO UPDATE SET max_in_flight=EXCLUDED.max_in_flight`,
      [scopeKey, id, value],
    )
    return { maxInFlight: value }
  }

  return {
    checkSchema,
    publish,
    listDeliveries,
    getDelivery,
    replay,
    getEndpointDeliveryOptions,
    setEndpointDeliveryOptions,
  }
}
