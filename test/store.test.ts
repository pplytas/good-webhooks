import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { decryptSecret } from '../src/crypto.js'
import { createStore } from '../src/store.js'
import { closeDatabase, pool, resetDatabase, testConfig } from './db.js'

const config = testConfig()
const store = createStore(config)
const input = { url: 'http://127.0.0.1:19000/hooks', eventTypes: ['order.created'] }
const event = { type: 'order.created', data: { orderId: 'order_123' } }

beforeEach(resetDatabase)
afterAll(closeDatabase)

async function queued(tenantId = 'tenant-a') {
  const endpoint = await store.createEndpoint(tenantId, input)
  const published = await store.publish(tenantId, event)
  const delivery = (await store.listDeliveries(tenantId)).items[0]!
  return { ...endpoint, published, delivery }
}

describe('schema setup and endpoint management', () => {
  it('checks explicit schema version and reports missing or incompatible migrations', async () => {
    await store.checkSchema()
    await pool.query('UPDATE webhooks.schema_version SET version=2')
    await expect(store.checkSchema()).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' })
    await pool.query('DROP SCHEMA webhooks CASCADE')
    await expect(store.checkSchema()).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' })
  })

  it('stores only encrypted signing material and returns public endpoint fields', async () => {
    const created = await store.createEndpoint('tenant-a', {
      ...input,
      description: 'Orders',
      eventTypes: ['order.created', 'order.created'],
    })
    expect(created.secret).toMatch(/^whsec_/)
    expect(created.endpoint).toMatchObject({
      tenantId: 'tenant-a',
      description: 'Orders',
      eventTypes: ['order.created'],
      status: 'active',
      maxInFlight: 2,
    })
    const row = (await pool.query('SELECT secret FROM webhooks.endpoints')).rows[0]!
    expect(row.secret).not.toBe(created.secret)
    expect(decryptSecret(row.secret, config.encryptionKey)).toBe(created.secret)
    const fetched = await store.getEndpoint('tenant-a', created.endpoint.id)
    expect(fetched).toEqual(created.endpoint)
    expect(fetched).not.toHaveProperty('secret')
    expect(fetched).not.toHaveProperty('previousSecret')
    expect(await store.listEndpoints('tenant-a')).toEqual([fetched])
  })

  it('enforces tenant ownership inside every management and history operation', async () => {
    const { endpoint, delivery } = await queued()
    await pool.query("UPDATE webhooks.deliveries SET status='succeeded' WHERE id=$1", [delivery.id])
    const foreignOperations = [
      () => store.getEndpoint('tenant-b', endpoint.id),
      () => store.updateEndpoint('tenant-b', endpoint.id, { description: 'foreign' }),
      () => store.pauseEndpoint('tenant-b', endpoint.id),
      () => store.resumeEndpoint('tenant-b', endpoint.id),
      () => store.removeEndpoint('tenant-b', endpoint.id),
      () => store.rotateSecret('tenant-b', endpoint.id),
      () => store.getDelivery('tenant-b', delivery.id),
      () => store.replay('tenant-b', delivery.id),
    ]
    for (const operation of foreignOperations)
      await expect(operation()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await store.listEndpoints('tenant-b')).toEqual([])
    expect((await store.listDeliveries('tenant-b', { endpointId: endpoint.id })).items).toEqual([])
    expect((await store.getEndpoint('tenant-a', endpoint.id)).status).toBe('active')
  })

  it('updates endpoint fields, supports pause/resume, and excludes deleted endpoints', async () => {
    const { endpoint } = await store.createEndpoint('tenant-a', input)
    const changed = await store.updateEndpoint('tenant-a', endpoint.id, {
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
      (await store.updateEndpoint('tenant-a', endpoint.id, { description: null })).description,
    ).toBeNull()
    expect((await store.pauseEndpoint('tenant-a', endpoint.id)).status).toBe('paused')
    expect((await store.resumeEndpoint('tenant-a', endpoint.id)).status).toBe('active')
    expect((await store.removeEndpoint('tenant-a', endpoint.id)).status).toBe('deleted')
    expect(await store.listEndpoints('tenant-a')).toEqual([])
    await expect(store.resumeEndpoint('tenant-a', endpoint.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    await expect(
      store.updateEndpoint('tenant-a', endpoint.id, { description: 'resurrect' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await expect(store.rotateSecret('tenant-a', endpoint.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
  })

  it('retains one old signing secret during overlap and requires an explicit immediate second rotation', async () => {
    const created = await store.createEndpoint('tenant-a', input)
    const rotated = await store.rotateSecret('tenant-a', created.endpoint.id, { graceMs: 60_000 })
    expect(rotated.secret).not.toBe(created.secret)
    let row = (
      await pool.query(
        'SELECT secret,previous_secret,previous_secret_expires_at FROM webhooks.endpoints',
      )
    ).rows[0]!
    expect(decryptSecret(row.secret, config.encryptionKey)).toBe(rotated.secret)
    expect(decryptSecret(row.previous_secret, config.encryptionKey)).toBe(created.secret)
    expect(row.previous_secret_expires_at.getTime()).toBeGreaterThan(Date.now())
    await expect(store.rotateSecret('tenant-a', created.endpoint.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    const immediate = await store.rotateSecret('tenant-a', created.endpoint.id, { graceMs: 0 })
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
      store.createEndpoint('tenant-a', { ...input, eventTypes: [] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      store.createEndpoint('tenant-a', { ...input, maxInFlight: 51 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      store.createEndpoint('tenant-a', { ...input, description: 'x'.repeat(2001) }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      store.createEndpoint('tenant-a', { ...input, url: 'http://10.0.0.1/hooks' }),
    ).rejects.toMatchObject({ code: 'UNSAFE_URL' })
    await expect(store.getEndpoint('tenant-a', "x' OR true")).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    expect(await store.listEndpoints('tenant-a')).toEqual([])
  })

  it('bounds endpoint listing through a 1000-endpoint tenant cap', async () => {
    const { endpoint } = await store.createEndpoint('tenant-a', input)
    await pool.query(
      `INSERT INTO webhooks.endpoints(id,tenant_id,url,event_types,secret)
      SELECT gen_random_uuid(),'tenant-a',url,event_types,secret FROM webhooks.endpoints CROSS JOIN generate_series(1,999) WHERE id=$1`,
      [endpoint.id],
    )
    expect((await store.listEndpoints('tenant-a')).length).toBe(1000)
    await expect(store.createEndpoint('tenant-a', input)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    await store.removeEndpoint('tenant-a', endpoint.id)
    await store.createEndpoint('tenant-a', input)
    expect((await store.listEndpoints('tenant-a')).length).toBe(1000)
  })
})

describe('atomic publication', () => {
  it('fans out only to matching tenant subscriptions, includes paused endpoints, and excludes deleted endpoints', async () => {
    await store.createEndpoint('tenant-a', input)
    const paused = await store.createEndpoint('tenant-a', input)
    await store.pauseEndpoint('tenant-a', paused.endpoint.id)
    const removed = await store.createEndpoint('tenant-a', input)
    await store.removeEndpoint('tenant-a', removed.endpoint.id)
    await store.createEndpoint('tenant-a', { ...input, eventTypes: ['order.updated'] })
    await store.createEndpoint('tenant-b', input)
    const result = await store.publish('tenant-a', event)
    expect(result).toMatchObject({ deliveryCount: 2, duplicate: false })
    expect((await store.listDeliveries('tenant-a')).items).toHaveLength(2)
    expect((await store.listDeliveries('tenant-b')).items).toHaveLength(0)
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

  it('deduplicates concurrent publications per tenant and rejects changed payload or type', async () => {
    await store.createEndpoint('tenant-a', input)
    const results = await Promise.all(
      [1, 2].map(() => store.publish('tenant-a', { ...event, idempotencyKey: 'business-event-1' })),
    )
    expect(new Set(results.map((result) => result.eventId)).size).toBe(1)
    expect(results.filter((result) => result.duplicate)).toHaveLength(1)
    expect(results.map((result) => result.deliveryCount)).toEqual([1, 1])
    await expect(
      store.publish('tenant-a', {
        ...event,
        data: { orderId: 'other' },
        idempotencyKey: 'business-event-1',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(
      store.publish('tenant-a', {
        ...event,
        type: 'order.updated',
        idempotencyKey: 'business-event-1',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(
      (await store.publish('tenant-b', { ...event, idempotencyKey: 'business-event-1' })).duplicate,
    ).toBe(false)
    expect((await store.listDeliveries('tenant-a')).items).toHaveLength(1)
  })

  it('joins an active caller transaction and rolls back business state, event and deliveries together', async () => {
    await store.createEndpoint('tenant-a', input)
    const client = await pool.connect()
    try {
      await client.query('CREATE TEMP TABLE producer_events(id text)')
      await client.query('BEGIN')
      await client.query("INSERT INTO producer_events VALUES ('business-event-1')")
      const result = await store.publish('tenant-a', event, { transaction: client })
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
      await store.publish('tenant-a', { ...event, idempotencyKey: 'same' }, { transaction: client })
      await expect(
        store.publish(
          'tenant-a',
          { ...event, data: null, idempotencyKey: 'same' },
          { transaction: client },
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
      await store.publish(
        'tenant-a',
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
      await expect(store.publish('tenant-a', event, { transaction: client })).rejects.toMatchObject(
        { code: 'TRANSACTION_REQUIRED' },
      )
      expect((await client.query('SELECT * FROM webhooks.events')).rows).toHaveLength(0)
    } finally {
      client.release()
    }
  })

  it('rolls back the event when fanout fails and restores a supplied transaction to its savepoint', async () => {
    await store.createEndpoint('tenant-a', input)
    await pool.query(
      'ALTER TABLE webhooks.deliveries ADD CONSTRAINT test_fanout_failure CHECK (false)',
    )
    await expect(store.publish('tenant-a', event)).rejects.toMatchObject({ code: '23514' })
    expect((await pool.query('SELECT * FROM webhooks.events')).rows).toHaveLength(0)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await expect(store.publish('tenant-a', event, { transaction: client })).rejects.toMatchObject(
        { code: '23514' },
      )
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
    const { endpoint } = await store.createEndpoint('tenant-a', input)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      expect((await store.publish('tenant-a', event, { transaction: client })).deliveryCount).toBe(
        1,
      )
      const change = store.updateEndpoint('tenant-a', endpoint.id, {
        eventTypes: ['order.updated'],
      })
      await client.query('COMMIT')
      await change
      expect((await store.publish('tenant-a', event)).deliveryCount).toBe(0)
      expect((await store.listDeliveries('tenant-a')).items).toHaveLength(1)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})

describe('history, deletion and replay', () => {
  it('returns bounded keyset pages without duplicates and validates cursor bounds', async () => {
    const { endpoint } = await store.createEndpoint('tenant-a', input)
    await Promise.all([1, 2, 3].map(() => store.publish('tenant-a', event)))
    const first = await store.listDeliveries('tenant-a', {
      endpointId: endpoint.id,
      status: 'pending',
      limit: 2,
    })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBe(first.items[1]!.id)
    const last = await store.listDeliveries('tenant-a', { before: first.nextCursor!, limit: 2 })
    expect(last.items).toHaveLength(1)
    expect(last.nextCursor).toBeNull()
    expect(new Set([...first.items, ...last.items].map((item) => item.id)).size).toBe(3)
    await expect(store.listDeliveries('tenant-a', { limit: 101 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(
      store.listDeliveries('tenant-a', { before: '9223372036854775808' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.getDelivery('tenant-a', '-1')).rejects.toMatchObject({
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
    const result = await store.getDelivery('tenant-a', delivery.id)
    expect(result.attempts.map((attempt) => attempt.number)).toEqual([1, 2])
    expect(result.attempts[0]).toMatchObject({
      outcome: 'retry',
      responseStatus: 503,
      responseBody: 'temporarily unavailable',
      error: 'HTTP 503',
    })
  })

  it('cancels pending and inflight delivery, closes attempts, and fences stale worker writes on deletion', async () => {
    const { endpoint, delivery } = await queued()
    await store.publish('tenant-a', event)
    const token = randomUUID()
    await pool.query(
      "UPDATE webhooks.deliveries SET status='in_flight',attempt_count=1,claim_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",
      [delivery.id, token],
    )
    await pool.query('INSERT INTO webhooks.attempts(delivery_id,number) VALUES ($1,1)', [
      delivery.id,
    ])
    await store.removeEndpoint('tenant-a', endpoint.id)
    expect((await store.listDeliveries('tenant-a')).items.map((item) => item.status)).toEqual([
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
    expect((await store.getDelivery('tenant-a', delivery.id)).attempts[0]).toMatchObject({
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
      store.replay('tenant-a', delivery.id),
      store.replay('tenant-a', delivery.id),
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
    await expect(store.replay('tenant-a', succeeded.value.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    expect((await store.replay('tenant-a', delivery.id)).id).not.toBe(succeeded.value.id)
    expect(
      (await pool.query('SELECT body FROM webhooks.events WHERE id=$1', [published.eventId]))
        .rows[0]!.body,
    ).toBe(bodyBefore)
  })

  it('rejects replay of unfinished deliveries, paused/deleted endpoints, and expired events', async () => {
    const { endpoint, delivery } = await queued()
    await expect(store.replay('tenant-a', delivery.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    await pool.query("UPDATE webhooks.deliveries SET status='succeeded' WHERE id=$1", [delivery.id])
    await store.pauseEndpoint('tenant-a', endpoint.id)
    await expect(store.replay('tenant-a', delivery.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    await store.resumeEndpoint('tenant-a', endpoint.id)
    await pool.query("UPDATE webhooks.events SET created_at=clock_timestamp()-interval '2 days'")
    await expect(store.replay('tenant-a', delivery.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    await store.removeEndpoint('tenant-a', endpoint.id)
    await expect(store.replay('tenant-a', delivery.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
  })
})
