import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { decryptSecret } from '../src/crypto.js'
import { createStore } from '../src/store.js'
import { createWorkerStore } from '../src/worker-store.js'
import type { Database } from '../src/types.js'
import { closeDatabase, pool, resetDatabase, testConfig } from './db.js'

const config = testConfig()
const store = createStore(config)
const input = { url: 'http://127.0.0.1:19000/hooks', eventTypes: ['order.created'] }
const event = { type: 'order.created', data: { orderId: 'order_123' } }

beforeEach(resetDatabase)
afterAll(closeDatabase)

async function queued(scopeKey = 'scope-a') {
  const endpoint = await store.createEndpoint(scopeKey, input)
  const published = await store.publish(scopeKey, event)
  const delivery = (await store.listDeliveries(scopeKey)).items[0]!
  return { ...endpoint, published, delivery }
}

describe('schema setup and endpoint management', () => {
  it('lets a migration runner roll back schema installation and bookkeeping together', async () => {
    const migration = await readFile(
      new URL('../migrations/001-initial.sql', import.meta.url),
      'utf8',
    )
    const client = await pool.connect()
    try {
      await client.query('DROP SCHEMA webhooks CASCADE')
      await client.query('CREATE TEMP TABLE migration_ledger (version integer PRIMARY KEY)')
      await client.query('BEGIN')
      await client.query('INSERT INTO migration_ledger VALUES (2)')
      await client.query(migration)
      // A failed ledger write must not leave either the schema or earlier bookkeeping committed.
      await expect(client.query('INSERT INTO migration_ledger VALUES (2)')).rejects.toMatchObject({
        code: '23505',
      })
      await client.query('ROLLBACK')
      expect((await client.query('SELECT version FROM migration_ledger')).rows).toEqual([])
      expect(
        (await client.query("SELECT to_regnamespace('webhooks') AS schema")).rows[0].schema,
      ).toBeNull()

      // A runner can retry the same migration after the rollback.
      await client.query('BEGIN')
      await client.query(migration)
      await client.query('INSERT INTO migration_ledger VALUES (2)')
      await client.query('COMMIT')
      await store.checkSchema()
      expect((await client.query('SELECT version FROM migration_ledger')).rows).toEqual([
        { version: 2 },
      ])
    } finally {
      await client.query('ROLLBACK')
      await client.query('DROP TABLE IF EXISTS migration_ledger')
      client.release()
    }
  })

  it('checks explicit schema version and reports missing or incompatible migrations', async () => {
    await store.checkSchema()
    await pool.query('UPDATE webhooks.schema_version SET version=1')
    await expect(store.checkSchema()).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' })
    await pool.query('DROP SCHEMA webhooks CASCADE')
    await expect(store.checkSchema()).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' })
  })

  it('stores only encrypted signing material and returns public endpoint fields', async () => {
    const created = await store.createEndpoint('scope-a', {
      ...input,
      description: 'Orders',
      eventTypes: ['order.created', 'order.created'],
    })
    expect(created.secret).toMatch(/^whsec_/)
    expect(created.endpoint).toMatchObject({
      description: 'Orders',
      eventTypes: ['order.created'],
      status: 'active',
      maxInFlight: 2,
    })
    const row = (await pool.query('SELECT secret FROM webhooks.endpoints')).rows[0]!
    expect(row.secret).not.toBe(created.secret)
    expect(decryptSecret(row.secret, config.encryptionKey)).toBe(created.secret)
    const fetched = await store.getEndpoint('scope-a', created.endpoint.id)
    expect(fetched).toEqual(created.endpoint)
    expect(fetched).not.toHaveProperty('secret')
    expect(fetched).not.toHaveProperty('previousSecret')
    expect(await store.listEndpoints('scope-a')).toEqual([fetched])
  })

  it('enforces scope ownership inside every management and history operation', async () => {
    const { endpoint, delivery } = await queued()
    await pool.query("UPDATE webhooks.deliveries SET status='succeeded' WHERE id=$1", [delivery.id])
    const foreignOperations = [
      () => store.getEndpoint('scope-b', endpoint.id),
      () => store.updateEndpoint('scope-b', endpoint.id, { description: 'foreign' }),
      () => store.pauseEndpoint('scope-b', endpoint.id),
      () => store.resumeEndpoint('scope-b', endpoint.id),
      () => store.removeEndpoint('scope-b', endpoint.id),
      () => store.rotateSecret('scope-b', endpoint.id),
      () => store.getDelivery('scope-b', delivery.id),
      () => store.replay('scope-b', delivery.id),
    ]
    for (const operation of foreignOperations)
      await expect(operation()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await store.listEndpoints('scope-b')).toEqual([])
    expect((await store.listDeliveries('scope-b', { endpointId: endpoint.id })).items).toEqual([])
    expect((await store.getEndpoint('scope-a', endpoint.id)).status).toBe('active')
  })

  it('updates endpoint fields, supports pause/resume, and excludes deleted endpoints', async () => {
    const { endpoint } = await store.createEndpoint('scope-a', input)
    const changed = await store.updateEndpoint('scope-a', endpoint.id, {
      url: 'http://127.0.0.1:19001/events',
      eventTypes: ['order.updated'],
      description: 'new',
      maxInFlight: 3,
    })
    expect(changed).toMatchObject({
      url: 'http://127.0.0.1:19001/events',
      eventTypes: ['order.updated'],
      description: 'new',
      maxInFlight: 3,
    })
    expect(
      (await store.updateEndpoint('scope-a', endpoint.id, { description: null })).description,
    ).toBeNull()
    expect((await store.pauseEndpoint('scope-a', endpoint.id)).status).toBe('paused')
    expect((await store.resumeEndpoint('scope-a', endpoint.id)).status).toBe('active')
    expect((await store.removeEndpoint('scope-a', endpoint.id)).status).toBe('deleted')
    expect(await store.listEndpoints('scope-a')).toEqual([])
    await expect(store.resumeEndpoint('scope-a', endpoint.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    await expect(
      store.updateEndpoint('scope-a', endpoint.id, { description: 'resurrect' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await expect(store.rotateSecret('scope-a', endpoint.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
  })

  it('retains one old signing secret during overlap and requires an explicit immediate second rotation', async () => {
    const created = await store.createEndpoint('scope-a', input)
    const rotated = await store.rotateSecret('scope-a', created.endpoint.id, { graceMs: 60_000 })
    expect(rotated.secret).not.toBe(created.secret)
    let row = (
      await pool.query(
        'SELECT secret,previous_secret,previous_secret_expires_at FROM webhooks.endpoints',
      )
    ).rows[0]!
    expect(decryptSecret(row.secret, config.encryptionKey)).toBe(rotated.secret)
    expect(decryptSecret(row.previous_secret, config.encryptionKey)).toBe(created.secret)
    expect(row.previous_secret_expires_at.getTime()).toBeGreaterThan(Date.now())
    await expect(store.rotateSecret('scope-a', created.endpoint.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    const immediate = await store.rotateSecret('scope-a', created.endpoint.id, { graceMs: 0 })
    row = (
      await pool.query(
        'SELECT secret,previous_secret,previous_secret_expires_at FROM webhooks.endpoints',
      )
    ).rows[0]!
    expect(decryptSecret(row.secret, config.encryptionKey)).toBe(immediate.secret)
    expect(row.previous_secret).toBeNull()
    expect(row.previous_secret_expires_at).toBeNull()
  })

  it('rejects invalid bounds and unsafe URLs before writing endpoints', async () => {
    await expect(store.createEndpoint('', input)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      store.createEndpoint('scope-a', { ...input, eventTypes: [] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      store.createEndpoint('scope-a', { ...input, maxInFlight: 51 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      store.createEndpoint('scope-a', { ...input, description: 'x'.repeat(2001) }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      store.createEndpoint('scope-a', { ...input, url: 'http://10.0.0.1/hooks' }),
    ).rejects.toMatchObject({ code: 'UNSAFE_URL' })
    await expect(store.getEndpoint('scope-a', "x' OR true")).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    expect(await store.listEndpoints('scope-a')).toEqual([])
  })

  it('bounds endpoint listing through a 1000-endpoint scope cap', async () => {
    const { endpoint } = await store.createEndpoint('scope-a', input)
    await pool.query(
      `INSERT INTO webhooks.endpoints(id,scope_key,url,event_types,secret)
      SELECT gen_random_uuid(),'scope-a',url,event_types,secret FROM webhooks.endpoints CROSS JOIN generate_series(1,999) WHERE id=$1`,
      [endpoint.id],
    )
    expect((await store.listEndpoints('scope-a')).length).toBe(1000)
    await expect(store.createEndpoint('scope-a', input)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    await store.removeEndpoint('scope-a', endpoint.id)
    await store.createEndpoint('scope-a', input)
    expect((await store.listEndpoints('scope-a')).length).toBe(1000)
  })
})

describe('atomic publication', () => {
  it('starts delivery age at publication inside an older caller transaction', async () => {
    await store.createEndpoint('scope-a', input)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_sleep(1.1)')
      await store.publish('scope-a', event, { transaction: client })
      await client.query('COMMIT')
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    const claims = await createWorkerStore(testConfig({ maxAgeMs: 1000 })).claim()
    expect(claims).toHaveLength(1)
    expect(claims[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(
      claims[0]!.eventCreatedAt.getTime(),
    )
  })

  it('fans out only to matching scope subscriptions, includes paused endpoints, and excludes deleted endpoints', async () => {
    await store.createEndpoint('scope-a', input)
    const paused = await store.createEndpoint('scope-a', input)
    await store.pauseEndpoint('scope-a', paused.endpoint.id)
    const removed = await store.createEndpoint('scope-a', input)
    await store.removeEndpoint('scope-a', removed.endpoint.id)
    await store.createEndpoint('scope-a', { ...input, eventTypes: ['order.updated'] })
    await store.createEndpoint('scope-b', input)
    const result = await store.publish('scope-a', event)
    expect(result).toMatchObject({ deliveryCount: 2, duplicate: false })
    expect((await store.listDeliveries('scope-a')).items).toHaveLength(2)
    expect((await store.listDeliveries('scope-b')).items).toHaveLength(0)
    const row = (
      await pool.query('SELECT body,created_at FROM webhooks.events WHERE id=$1', [result.eventId])
    ).rows[0]!
    expect(JSON.parse(row.body)).toEqual({
      id: result.eventId,
      type: event.type,
      occurredAt: row.created_at.toISOString(),
      data: event.data,
    })
  })

  it('deduplicates concurrent publications per scope and rejects changed payload or type', async () => {
    await store.createEndpoint('scope-a', input)
    const results = await Promise.all(
      [1, 2].map(() => store.publish('scope-a', { ...event, idempotencyKey: 'business-event-1' })),
    )
    expect(new Set(results.map((result) => result.eventId)).size).toBe(1)
    expect(results.filter((result) => result.duplicate)).toHaveLength(1)
    expect(results.map((result) => result.deliveryCount)).toEqual([1, 1])
    await expect(
      store.publish('scope-a', {
        ...event,
        data: { orderId: 'other' },
        idempotencyKey: 'business-event-1',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(
      store.publish('scope-a', {
        ...event,
        type: 'order.updated',
        idempotencyKey: 'business-event-1',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(
      (await store.publish('scope-b', { ...event, idempotencyKey: 'business-event-1' })).duplicate,
    ).toBe(false)
    expect((await store.listDeliveries('scope-a')).items).toHaveLength(1)
  })

  it('joins an active caller transaction and rolls back business state, event and deliveries together', async () => {
    await store.createEndpoint('scope-a', input)
    const client = await pool.connect()
    try {
      await client.query('CREATE TEMP TABLE producer_events(id text)')
      await client.query('BEGIN')
      await client.query("INSERT INTO producer_events VALUES ('business-event-1')")
      const result = await store.publish('scope-a', event, { transaction: client })
      expect(result.deliveryCount).toBe(1)
      expect((await client.query('SELECT * FROM webhooks.events')).rows).toHaveLength(1)
      expect((await pool.query('SELECT * FROM webhooks.events')).rows).toHaveLength(0)
      await client.query('ROLLBACK')
      expect((await client.query('SELECT * FROM producer_events')).rows).toHaveLength(0)
      expect((await pool.query('SELECT * FROM webhooks.events')).rows).toHaveLength(0)
      expect((await pool.query('SELECT * FROM webhooks.deliveries')).rows).toHaveLength(0)
    } finally {
      client.release()
    }
  })

  it('does not commit a caller transaction and preserves it after an operation failure', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await store.publish('scope-a', { ...event, idempotencyKey: 'same' }, { transaction: client })
      await expect(
        store.publish(
          'scope-a',
          { ...event, data: null, idempotencyKey: 'same' },
          { transaction: client },
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
      await store.publish(
        'scope-a',
        { ...event, idempotencyKey: 'second' },
        { transaction: client },
      )
      expect((await pool.query('SELECT * FROM webhooks.events')).rows).toHaveLength(0)
      await client.query('COMMIT')
      expect((await pool.query('SELECT * FROM webhooks.events')).rows).toHaveLength(2)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('rejects a caller client that has no active transaction without persisting anything', async () => {
    const client = await pool.connect()
    try {
      await expect(store.publish('scope-a', event, { transaction: client })).rejects.toMatchObject({
        code: 'TRANSACTION_REQUIRED',
      })
      expect((await client.query('SELECT * FROM webhooks.events')).rows).toHaveLength(0)
    } finally {
      client.release()
    }
  })

  it('rolls back the event when fanout fails and restores a supplied transaction to its savepoint', async () => {
    await store.createEndpoint('scope-a', input)
    await pool.query(
      'ALTER TABLE webhooks.deliveries ADD CONSTRAINT test_fanout_failure CHECK (false)',
    )
    await expect(store.publish('scope-a', event)).rejects.toMatchObject({ code: '23514' })
    expect((await pool.query('SELECT * FROM webhooks.events')).rows).toHaveLength(0)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await expect(store.publish('scope-a', event, { transaction: client })).rejects.toMatchObject({
        code: '23514',
      })
      expect((await client.query('SELECT * FROM webhooks.events')).rows).toHaveLength(0)
      // A PostgreSQL constraint failure normally aborts the transaction. The savepoint keeps it usable.
      expect((await client.query('SELECT 42 AS answer')).rows[0]!.answer).toBe(42)
      await client.query('COMMIT')
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('serializes endpoint subscription changes behind uncommitted publication', async () => {
    const { endpoint } = await store.createEndpoint('scope-a', input)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      expect((await store.publish('scope-a', event, { transaction: client })).deliveryCount).toBe(1)
      const change = store.updateEndpoint('scope-a', endpoint.id, {
        eventTypes: ['order.updated'],
      })
      await client.query('COMMIT')
      await change
      expect((await store.publish('scope-a', event)).deliveryCount).toBe(0)
      expect((await store.listDeliveries('scope-a')).items).toHaveLength(1)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})

describe('history, deletion and replay', () => {
  it('returns bounded keyset pages without duplicates and validates cursor bounds', async () => {
    const { endpoint } = await store.createEndpoint('scope-a', input)
    await Promise.all([1, 2, 3].map(() => store.publish('scope-a', event)))
    const first = await store.listDeliveries('scope-a', {
      endpointId: endpoint.id,
      status: 'pending',
      limit: 2,
    })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBe(first.items[1]!.id)
    const last = await store.listDeliveries('scope-a', { before: first.nextCursor!, limit: 2 })
    expect(last.items).toHaveLength(1)
    expect(last.nextCursor).toBeNull()
    expect(new Set([...first.items, ...last.items].map((item) => item.id)).size).toBe(3)
    await expect(store.listDeliveries('scope-a', { limit: 101 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(
      store.listDeliveries('scope-a', { before: '9223372036854775808' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.getDelivery('scope-a', '-1')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })

  it('returns persisted attempt history in attempt-number order', async () => {
    const { delivery } = await queued()
    await pool.query(
      `INSERT INTO webhooks.attempts(delivery_id,number,outcome,response_status,response_body,error,finished_at) VALUES
      ($1,2,'succeeded',204,'',NULL,clock_timestamp()),($1,1,'retry',503,'temporarily unavailable','HTTP 503',clock_timestamp())`,
      [delivery.id],
    )
    const result = await store.getDelivery('scope-a', delivery.id)
    expect(result.attempts.map((attempt) => attempt.number)).toEqual([1, 2])
    expect(result.attempts[0]).toMatchObject({
      outcome: 'retry',
      responseStatus: 503,
      responseBody: 'temporarily unavailable',
      error: 'HTTP 503',
    })
  })

  it('reads delivery state and attempts from the same snapshot while a worker completes', async () => {
    const { delivery } = await queued()
    const workerStore = createWorkerStore(config)
    let advanced = false
    const database: Database = {
      connect: () => pool.connect(),
      async query(text, values) {
        const result = await pool.query(text, values)
        if (!advanced && text.includes('FROM webhooks.deliveries')) {
          advanced = true
          const [claim] = await workerStore.claim()
          await workerStore.complete(claim!, {
            status: 200,
            responseBody: 'accepted',
            error: null,
            retryable: false,
          })
        }
        return result
      },
    }
    const history = await createStore(testConfig({ database })).getDelivery('scope-a', delivery.id)
    expect(advanced).toBe(true)
    expect(history).toMatchObject({ status: 'pending', attemptCount: 0, attempts: [] })
    const completed = await store.getDelivery('scope-a', delivery.id)
    expect(completed).toMatchObject({
      status: 'succeeded',
      attemptCount: 1,
      attempts: [{ number: 1, outcome: 'succeeded' }],
    })
    expect(completed.attempts[0]!.startedAt).toBeInstanceOf(Date)
    expect(completed.attempts[0]!.finishedAt).toBeInstanceOf(Date)
  })

  it('cancels pending and inflight delivery, closes attempts, and fences stale worker writes on deletion', async () => {
    const { endpoint, delivery } = await queued()
    await store.publish('scope-a', event)
    const token = randomUUID()
    await pool.query(
      "UPDATE webhooks.deliveries SET status='in_flight',attempt_count=1,claim_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",
      [delivery.id, token],
    )
    await pool.query('INSERT INTO webhooks.attempts(delivery_id,number) VALUES ($1,1)', [
      delivery.id,
    ])
    await store.removeEndpoint('scope-a', endpoint.id)
    expect((await store.listDeliveries('scope-a')).items.map((item) => item.status)).toEqual([
      'cancelled',
      'cancelled',
    ])
    const row = (
      await pool.query('SELECT claim_token,lease_expires_at FROM webhooks.deliveries WHERE id=$1', [
        delivery.id,
      ])
    ).rows[0]!
    expect(row.claim_token).toBeNull()
    expect(row.lease_expires_at).toBeNull()
    expect((await store.getDelivery('scope-a', delivery.id)).attempts[0]).toMatchObject({
      outcome: 'abandoned',
      error: 'Endpoint deleted',
    })
    const stale = await pool.query(
      "UPDATE webhooks.deliveries SET status='succeeded' WHERE id=$1 AND claim_token=$2",
      [delivery.id, token],
    )
    expect(stale.rowCount).toBe(0)
  })

  it('replays an immutable event once concurrently, forbids replay chains, and permits another replay after completion', async () => {
    const { published, delivery } = await queued()
    await pool.query("UPDATE webhooks.deliveries SET status='failed' WHERE id=$1", [delivery.id])
    const bodyBefore = (
      await pool.query('SELECT body FROM webhooks.events WHERE id=$1', [published.eventId])
    ).rows[0]!.body
    const outcomes = await Promise.allSettled([
      store.replay('scope-a', delivery.id),
      store.replay('scope-a', delivery.id),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const failed = outcomes.find((outcome) => outcome.status === 'rejected')!
    expect(failed.status === 'rejected' && failed.reason).toMatchObject({
      code: 'REPLAY_IN_PROGRESS',
    })
    const succeeded = outcomes.find((outcome) => outcome.status === 'fulfilled')!
    if (succeeded.status !== 'fulfilled') throw new Error('Replay missing')
    expect(succeeded.value).toMatchObject({
      eventId: published.eventId,
      replayOf: delivery.id,
      status: 'pending',
      attemptCount: 0,
    })
    await pool.query("UPDATE webhooks.deliveries SET status='succeeded' WHERE id=$1", [
      succeeded.value.id,
    ])
    await expect(store.replay('scope-a', succeeded.value.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    expect((await store.replay('scope-a', delivery.id)).id).not.toBe(succeeded.value.id)
    expect(
      (await pool.query('SELECT body FROM webhooks.events WHERE id=$1', [published.eventId]))
        .rows[0]!.body,
    ).toBe(bodyBefore)
  })

  it('rejects replay of unfinished deliveries, paused/deleted endpoints, and expired events', async () => {
    const { endpoint, delivery } = await queued()
    await expect(store.replay('scope-a', delivery.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    await pool.query("UPDATE webhooks.deliveries SET status='succeeded' WHERE id=$1", [delivery.id])
    await store.pauseEndpoint('scope-a', endpoint.id)
    await expect(store.replay('scope-a', delivery.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    await store.resumeEndpoint('scope-a', endpoint.id)
    await pool.query("UPDATE webhooks.events SET created_at=clock_timestamp()-interval '2 days'")
    await expect(store.replay('scope-a', delivery.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    await store.removeEndpoint('scope-a', endpoint.id)
    await expect(store.replay('scope-a', delivery.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
  })
})
