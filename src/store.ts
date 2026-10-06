import { createHash, randomUUID } from 'node:crypto'
import { encryptSecret, generateSecret } from './crypto.js'
import { WebhookError } from './errors.js'
import { assertSafeUrl } from './transport.js'
import type {
  Attempt,
  CreateEndpointInput,
  Delivery,
  DeliveryDetail,
  DeliveryQuery,
  Endpoint,
  EndpointWithSecret,
  JsonValue,
  Page,
  PublishOptions,
  PublishResult,
  ResolvedConfig,
  SqlClient,
  UpdateEndpointInput,
} from './types.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BIGINT = 9223372036854775807n
const ENDPOINT_LIMIT = 1000
const MAX_ROTATION_GRACE_MS = 86_400_000
const DELIVERY_STATUSES = new Set(['pending', 'in_flight', 'succeeded', 'failed', 'cancelled'])
const ENDPOINT_FIELDS =
  'id, tenant_id, url, description, event_types, status, max_in_flight, created_at, updated_at'
const DELIVERY_FIELDS =
  'id::text, tenant_id, endpoint_id, event_id, status, attempt_count, next_attempt_at, created_at, replay_of::text, last_error, last_status'

interface EndpointRow extends Record<string, unknown> {
  id: string
  tenant_id: string
  url: string
  description: string | null
  event_types: string[]
  status: Endpoint['status']
  max_in_flight: number
  created_at: Date
  updated_at: Date
}
interface DeliveryRow extends Record<string, unknown> {
  id: string
  tenant_id: string
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
interface AttemptRow extends Record<string, unknown> {
  number: number
  started_at: Date
  finished_at: Date | null
  outcome: Attempt['outcome']
  response_status: number | null
  response_body: string | null
  error: string | null
}

function endpoint(row: EndpointRow): Endpoint {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    url: row.url,
    description: row.description,
    eventTypes: row.event_types,
    status: row.status,
    maxInFlight: row.max_in_flight,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function delivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    tenantId: row.tenant_id,
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
function tenant(id: string): void {
  if (typeof id !== 'string' || !id.trim() || id.length > 200 || id.includes('\0'))
    invalid('Tenant id must contain 1–200 characters and no null bytes.')
}
function endpointId(id: string): void {
  if (typeof id !== 'string' || !UUID.test(id)) invalid('Endpoint id must be a UUID.')
}
function deliveryId(id: string): void {
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > MAX_BIGINT)
    invalid('Delivery id must be a positive PostgreSQL bigint string.')
}
function eventTypes(types: readonly string[]): string[] {
  if (
    !Array.isArray(types) ||
    types.length < 1 ||
    types.length > 100 ||
    types.some(
      (type) =>
        typeof type !== 'string' || !type.trim() || type.length > 120 || type.includes('\0'),
    )
  ) {
    invalid('An endpoint must subscribe to 1–100 event names of 1–120 characters.')
  }
  return [...new Set(types)]
}
function description(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > 2000 || value.includes('\0'))
    invalid('Description must contain at most 2000 characters and no null bytes.')
  return value
}
function maxInFlight(value: number | undefined): number {
  if (value === undefined) return 2
  if (!Number.isSafeInteger(value) || value < 1 || value > 50)
    invalid('maxInFlight must be an integer from 1 to 50.')
  return value
}
function postgresCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined
}

/** Endpoint mutations and event fanout serialize within each tenant, including caller-owned transactions. */
async function lockTenant(client: SqlClient, tenantId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `@pplytas/webhooks:tenant:${tenantId}`,
  ])
}

export function createStore(config: ResolvedConfig) {
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

  async function safeUrl(url: string): Promise<void> {
    if (typeof url !== 'string' || url.length < 1 || url.length > 2048)
      invalid('Endpoint URL must contain 1–2048 characters.')
    await assertSafeUrl(url, config.allowLocalhost)
  }

  async function lockedEndpoint(
    client: SqlClient,
    tenantId: string,
    id: string,
  ): Promise<EndpointRow> {
    const { rows } = await client.query<EndpointRow>(
      `SELECT ${ENDPOINT_FIELDS} FROM webhooks.endpoints WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [tenantId, id],
    )
    if (!rows[0]) throw new WebhookError('NOT_FOUND', 'Endpoint not found in this tenant.')
    return rows[0]
  }

  function editable(row: EndpointRow): void {
    if (row.status === 'deleted')
      throw new WebhookError('INVALID_STATE', 'Deleted endpoints cannot be modified.')
  }

  async function checkSchema(): Promise<void> {
    try {
      const result = await config.database.query<{ version: number }>(
        'SELECT version FROM webhooks.schema_version ORDER BY version',
      )
      if (result.rows.length !== 1 || result.rows[0]?.version !== 1) {
        throw new WebhookError(
          'SCHEMA_MISMATCH',
          'Expected webhook schema version 1. Apply the package migrations before using the library.',
        )
      }
    } catch (error) {
      if (error instanceof WebhookError) throw error
      if (['42P01', '3F000', '42703'].includes(postgresCode(error) ?? '')) {
        throw new WebhookError(
          'SCHEMA_MISMATCH',
          'Webhook schema is missing or incompatible. Apply the package migrations before using the library.',
          { cause: error },
        )
      }
      throw error
    }
  }

  async function createEndpoint(
    tenantId: string,
    input: CreateEndpointInput,
  ): Promise<EndpointWithSecret> {
    tenant(tenantId)
    object(input, 'Endpoint input')
    const url = input.url
    const types = eventTypes(input.eventTypes)
    const desc = description(input.description)
    const inFlight = maxInFlight(input.maxInFlight)
    await safeUrl(url)
    const secret = generateSecret()
    return transaction(async (client) => {
      await lockTenant(client, tenantId)
      const count = await client.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM webhooks.endpoints WHERE tenant_id=$1 AND status<>'deleted'",
        [tenantId],
      )
      if ((count.rows[0]?.count ?? 0) >= ENDPOINT_LIMIT)
        throw new WebhookError(
          'INVALID_STATE',
          `A tenant may have at most ${ENDPOINT_LIMIT} nondeleted endpoints.`,
        )
      const result = await client.query<EndpointRow>(
        `INSERT INTO webhooks.endpoints(id,tenant_id,url,description,event_types,max_in_flight,secret) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${ENDPOINT_FIELDS}`,
        [
          randomUUID(),
          tenantId,
          url,
          desc,
          types,
          inFlight,
          encryptSecret(secret, config.encryptionKey),
        ],
      )
      return { endpoint: endpoint(result.rows[0]!), secret }
    })
  }

  async function listEndpoints(tenantId: string): Promise<Endpoint[]> {
    tenant(tenantId)
    const result = await config.database.query<EndpointRow>(
      `SELECT ${ENDPOINT_FIELDS} FROM webhooks.endpoints WHERE tenant_id=$1 AND status<>'deleted' ORDER BY created_at DESC,id DESC LIMIT ${ENDPOINT_LIMIT}`,
      [tenantId],
    )
    return result.rows.map(endpoint)
  }

  async function getEndpoint(tenantId: string, id: string): Promise<Endpoint> {
    tenant(tenantId)
    endpointId(id)
    const { rows } = await config.database.query<EndpointRow>(
      `SELECT ${ENDPOINT_FIELDS} FROM webhooks.endpoints WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    )
    if (!rows[0]) throw new WebhookError('NOT_FOUND', 'Endpoint not found in this tenant.')
    return endpoint(rows[0])
  }

  async function updateEndpoint(
    tenantId: string,
    id: string,
    patch: UpdateEndpointInput,
  ): Promise<Endpoint> {
    tenant(tenantId)
    endpointId(id)
    object(patch, 'Endpoint patch')
    const url = patch.url
    const types = patch.eventTypes === undefined ? undefined : eventTypes(patch.eventTypes)
    const desc = patch.description === undefined ? undefined : description(patch.description)
    const inFlight = patch.maxInFlight === undefined ? undefined : maxInFlight(patch.maxInFlight)
    if (url !== undefined) await safeUrl(url)
    return transaction(async (client) => {
      await lockTenant(client, tenantId)
      const current = await lockedEndpoint(client, tenantId, id)
      editable(current)
      const { rows } = await client.query<EndpointRow>(
        `UPDATE webhooks.endpoints SET url=$3,description=$4,event_types=$5,max_in_flight=$6,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING ${ENDPOINT_FIELDS}`,
        [
          tenantId,
          id,
          url ?? current.url,
          desc === undefined ? current.description : desc,
          types ?? current.event_types,
          inFlight ?? current.max_in_flight,
        ],
      )
      return endpoint(rows[0]!)
    })
  }

  async function changeStatus(
    tenantId: string,
    id: string,
    status: 'active' | 'paused',
  ): Promise<Endpoint> {
    tenant(tenantId)
    endpointId(id)
    return transaction(async (client) => {
      await lockTenant(client, tenantId)
      const current = await lockedEndpoint(client, tenantId, id)
      editable(current)
      if (status === 'active') await safeUrl(current.url)
      const { rows } = await client.query<EndpointRow>(
        `UPDATE webhooks.endpoints SET status=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING ${ENDPOINT_FIELDS}`,
        [tenantId, id, status],
      )
      return endpoint(rows[0]!)
    })
  }

  async function removeEndpoint(tenantId: string, id: string): Promise<Endpoint> {
    tenant(tenantId)
    endpointId(id)
    return transaction(async (client) => {
      await lockTenant(client, tenantId)
      await lockedEndpoint(client, tenantId, id)
      const { rows } = await client.query<EndpointRow>(
        `UPDATE webhooks.endpoints SET status='deleted',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING ${ENDPOINT_FIELDS}`,
        [tenantId, id],
      )
      await client.query(
        `WITH cancelled AS (
        UPDATE webhooks.deliveries SET status='cancelled',claim_token=NULL,lease_expires_at=NULL,last_error='Endpoint deleted'
        WHERE tenant_id=$1 AND endpoint_id=$2 AND status IN ('pending','in_flight') RETURNING id
      ) UPDATE webhooks.attempts SET outcome='abandoned',finished_at=clock_timestamp(),error='Endpoint deleted'
        WHERE delivery_id IN (SELECT id FROM cancelled) AND outcome='started'`,
        [tenantId, id],
      )
      return endpoint(rows[0]!)
    })
  }

  async function rotateSecret(
    tenantId: string,
    id: string,
    options: { graceMs?: number } = {},
  ): Promise<EndpointWithSecret> {
    tenant(tenantId)
    endpointId(id)
    object(options, 'Rotation options')
    const graceMs = options.graceMs ?? MAX_ROTATION_GRACE_MS
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > MAX_ROTATION_GRACE_MS)
      invalid('Secret rotation graceMs must be an integer from 0 to 86400000.')
    return transaction(async (client) => {
      await lockTenant(client, tenantId)
      const current = await lockedEndpoint(client, tenantId, id)
      editable(current)
      const overlap = await client.query<{ active: boolean }>(
        'SELECT previous_secret IS NOT NULL AND previous_secret_expires_at>clock_timestamp() AS active FROM webhooks.endpoints WHERE tenant_id=$1 AND id=$2',
        [tenantId, id],
      )
      if (graceMs > 0 && overlap.rows[0]?.active)
        throw new WebhookError(
          'INVALID_STATE',
          'A signing-secret overlap is still active. Wait for it to expire or explicitly rotate with graceMs: 0.',
        )
      const secret = generateSecret()
      const { rows } = await client.query<EndpointRow>(
        `UPDATE webhooks.endpoints SET previous_secret=CASE WHEN $4::bigint>0 THEN secret ELSE NULL END,previous_secret_expires_at=CASE WHEN $4::bigint>0 THEN clock_timestamp()+$4::bigint*interval '1 millisecond' ELSE NULL END,secret=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING ${ENDPOINT_FIELDS}`,
        [tenantId, id, encryptSecret(secret, config.encryptionKey), graceMs],
      )
      return { endpoint: endpoint(rows[0]!), secret }
    })
  }

  async function publish(
    tenantId: string,
    input: { type: string; data: JsonValue; idempotencyKey?: string },
    options: PublishOptions = {},
  ): Promise<PublishResult> {
    tenant(tenantId)
    object(input, 'Event input')
    object(options, 'Publication options')
    eventTypes([input.type])
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
    return transaction(async (client) => {
      await lockTenant(client, tenantId)
      if (input.idempotencyKey !== undefined) {
        const existing = await client.query<{ id: string; fingerprint: string; count: number }>(
          `SELECT e.id,e.fingerprint,(SELECT count(*)::integer FROM webhooks.deliveries d WHERE d.event_id=e.id AND d.replay_of IS NULL) AS count FROM webhooks.events e WHERE e.tenant_id=$1 AND e.idempotency_key=$2`,
          [tenantId, input.idempotencyKey],
        )
        if (existing.rows[0]) {
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
      }
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
        'INSERT INTO webhooks.events(id,tenant_id,type,body,fingerprint,idempotency_key,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          eventId,
          tenantId,
          input.type,
          body,
          fingerprint,
          input.idempotencyKey ?? null,
          occurredAt,
        ],
      )
      const result = await client.query(
        "INSERT INTO webhooks.deliveries(tenant_id,endpoint_id,event_id) SELECT tenant_id,id,$2 FROM webhooks.endpoints WHERE tenant_id=$1 AND status<>'deleted' AND $3=ANY(event_types)",
        [tenantId, eventId, input.type],
      )
      return { eventId, deliveryCount: result.rowCount ?? 0, duplicate: false }
    }, options.transaction)
  }

  async function listDeliveries(
    tenantId: string,
    query: DeliveryQuery = {},
  ): Promise<Page<Delivery>> {
    tenant(tenantId)
    object(query, 'Delivery query')
    if (query.endpointId !== undefined) endpointId(query.endpointId)
    if (query.before !== undefined) deliveryId(query.before)
    if (query.status !== undefined && !DELIVERY_STATUSES.has(query.status))
      invalid('Unknown delivery status.')
    const limit = query.limit ?? 25
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      invalid('Delivery list limit must be an integer from 1 to 100.')
    const { rows } = await config.database.query<DeliveryRow>(
      `SELECT ${DELIVERY_FIELDS} FROM webhooks.deliveries WHERE tenant_id=$1 AND ($2::uuid IS NULL OR endpoint_id=$2) AND ($3::text IS NULL OR status=$3) AND ($4::bigint IS NULL OR id<$4) ORDER BY id DESC LIMIT $5`,
      [tenantId, query.endpointId ?? null, query.status ?? null, query.before ?? null, limit + 1],
    )
    const items = rows.slice(0, limit).map(delivery)
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null }
  }

  async function getDelivery(tenantId: string, id: string): Promise<DeliveryDetail> {
    tenant(tenantId)
    deliveryId(id)
    const { rows } = await config.database.query<DeliveryRow>(
      `SELECT ${DELIVERY_FIELDS} FROM webhooks.deliveries WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    )
    if (!rows[0]) throw new WebhookError('NOT_FOUND', 'Delivery not found in this tenant.')
    const attempts = await config.database.query<AttemptRow>(
      'SELECT a.number,a.started_at,a.finished_at,a.outcome,a.response_status,a.response_body,a.error FROM webhooks.attempts a JOIN webhooks.deliveries d ON d.id=a.delivery_id WHERE d.tenant_id=$1 AND d.id=$2 ORDER BY a.number',
      [tenantId, id],
    )
    return {
      ...delivery(rows[0]),
      attempts: attempts.rows.map((row) => ({
        number: row.number,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        outcome: row.outcome,
        responseStatus: row.response_status,
        responseBody: row.response_body,
        error: row.error,
      })),
    }
  }

  async function replay(tenantId: string, id: string): Promise<Delivery> {
    tenant(tenantId)
    deliveryId(id)
    return transaction(async (client) => {
      await lockTenant(client, tenantId)
      const found = await client.query<{ endpoint_id: string }>(
        'SELECT endpoint_id FROM webhooks.deliveries WHERE tenant_id=$1 AND id=$2',
        [tenantId, id],
      )
      if (!found.rows[0]) throw new WebhookError('NOT_FOUND', 'Delivery not found in this tenant.')
      const target = await lockedEndpoint(client, tenantId, found.rows[0].endpoint_id)
      if (target.status !== 'active')
        throw new WebhookError('INVALID_STATE', 'Replay requires an active endpoint.')
      const original = await client.query<DeliveryRow>(
        `SELECT ${DELIVERY_FIELDS} FROM webhooks.deliveries WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [tenantId, id],
      )
      const row = original.rows[0]
      if (!row) throw new WebhookError('NOT_FOUND', 'Delivery not found in this tenant.')
      if (row.replay_of !== null || !['succeeded', 'failed'].includes(row.status))
        throw new WebhookError(
          'INVALID_STATE',
          'Only an original succeeded or failed delivery can be replayed.',
        )
      const retained = await client.query<{ valid: boolean }>(
        "SELECT created_at>clock_timestamp()-$3::bigint*interval '1 millisecond' AS valid FROM webhooks.events WHERE tenant_id=$1 AND id=$2",
        [tenantId, row.event_id, config.retentionMs],
      )
      if (!retained.rows[0]?.valid)
        throw new WebhookError('INVALID_STATE', 'The event is outside the replay retention window.')
      const active = await client.query(
        "SELECT id FROM webhooks.deliveries WHERE tenant_id=$1 AND replay_of=$2 AND status IN ('pending','in_flight')",
        [tenantId, id],
      )
      if (active.rows.length)
        throw new WebhookError(
          'REPLAY_IN_PROGRESS',
          'This delivery already has a pending or in-flight replay.',
        )
      const inserted = await client.query<DeliveryRow>(
        `INSERT INTO webhooks.deliveries(tenant_id,endpoint_id,event_id,replay_of) VALUES ($1,$2,$3,$4) RETURNING ${DELIVERY_FIELDS}`,
        [tenantId, row.endpoint_id, row.event_id, id],
      )
      return delivery(inserted.rows[0]!)
    })
  }

  return {
    checkSchema,
    createEndpoint,
    listEndpoints,
    getEndpoint,
    updateEndpoint,
    removeEndpoint,
    pauseEndpoint: (tenantId: string, id: string) => changeStatus(tenantId, id, 'paused'),
    resumeEndpoint: (tenantId: string, id: string) => changeStatus(tenantId, id, 'active'),
    rotateSecret,
    publish,
    listDeliveries,
    getDelivery,
    replay,
  }
}
