import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { Pool } from 'pg'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { generateSecret, verifyWebhook } from '../src/crypto.js'
import { createDelivery } from '../src/delivery.js'
import { APPLICATION_SCOPE, scopeKey } from '../src/scope.js'
import { createWorkerStore } from '../src/worker-store.js'
import type {
  EndpointResolution,
  EndpointSource,
  ManagementScope,
} from '../src/management/types.js'
import type { Database, ResolvedConfig } from '../src/types.js'

const database = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    'postgres://postgres:webhooks_dev_only@127.0.0.1:55439/webhooks',
  max: 10,
})
const servers: Server[] = []
const secret = generateSecret()
const endpointId = 'endpoint_custom-opaque-id'
const active = (): EndpointResolution => ({
  status: 'active',
  url: 'https://example.com/webhook',
  secrets: [secret],
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
function provider(): EndpointSource {
  return { matchRecipients: async () => [endpointId], resolveEndpoint: async () => active() }
}
function config(source: EndpointSource, options: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    database,
    source,
    retryDelaysMs: [10, 20],
    maxAgeMs: 60_000,
    timeoutMs: 100,
    concurrency: 4,
    leaseMs: 2000,
    maxResponseBytes: 1024,
    retentionMs: 86_400_000,
    allowLocalhost: true,
    ...options,
  }
}
function engine(source: EndpointSource, leaseMs = 2000) {
  return createDelivery({
    database,
    source,
    events: { 'order.created': z.object({ id: z.number() }) },
    delivery: { timeoutMs: 100, leaseMs, concurrency: 4 },
    retry: { delaysMs: [10, 20], maxAgeMs: 60_000 },
    allowLocalhost: true,
  })
}
const event = { type: 'order.created', data: { id: 1 } } as const
async function due() {
  await database.query(
    "UPDATE webhooks.deliveries SET next_attempt_at=now()-interval '1 second' WHERE status='pending'",
  )
}
async function rows() {
  return (await database.query('SELECT * FROM webhooks.deliveries ORDER BY id')).rows
}
async function receiver() {
  const received: { body: string; headers: Record<string, string | string[] | undefined> }[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      received.push({ body: Buffer.concat(chunks).toString(), headers: request.headers })
      response.end('ok')
    })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Receiver did not bind')
  return { url: `http://127.0.0.1:${address.port}/webhooks`, received }
}

beforeEach(async () => {
  const migration = await readFile(new URL('../migrations/delivery.sql', import.meta.url), 'utf8')
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    await client.query('DROP SCHEMA IF EXISTS webhooks CASCADE')
    await client.query('DROP SCHEMA IF EXISTS webhooks_management CASCADE')
    await client.query(migration)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        }),
    ),
  )
})
afterAll(async () => {
  await database.end()
})

describe('delivery with an independent management provider', () => {
  it('publishes and sends with opaque IDs and no management tables', async () => {
    const target = await receiver()
    const source = provider()
    source.resolveEndpoint = async () => ({ status: 'active', url: target.url, secrets: [secret] })
    const app = engine(source)
    await expect(app.check()).resolves.toBeUndefined()
    const published = await app.publish(event)
    expect(published.deliveryCount).toBe(1)
    expect(
      (await database.query("SELECT to_regnamespace('webhooks_management') AS schema")).rows[0]
        .schema,
    ).toBeNull()
    expect(await app.worker.tick()).toMatchObject({ claimed: 1, succeeded: 1 })
    expect(target.received).toHaveLength(1)
    verifyWebhook({ ...target.received[0]!, secret })
    expect((await app.deliveries.list({ endpointId })).items[0]?.endpointId).toBe(endpointId)
  })

  it('publishes reversed recipients while a worker prepares without deadlocking or exceeding endpoint capacity', async () => {
    const source = provider()
    source.matchRecipients = async () => ['b', 'a']
    const app = engine(source)
    await app.publish(event)
    await app.deliverySettings.set('a', { maxInFlight: 1 })
    await app.deliverySettings.set('b', { maxInFlight: 1 })

    const lookupsStarted = deferred<void>()
    const finishLookups = deferred<void>()
    let lookups = 0
    source.resolveEndpoint = async () => {
      if (++lookups === 2) lookupsStarted.resolve()
      await finishLookups.promise
      return active()
    }
    let workerPid: number | undefined
    const trackedDatabase: Database = {
      query: database.query.bind(database),
      async connect() {
        const client = await database.connect()
        return {
          release: () => client.release(),
          async query<R extends Record<string, unknown>>(text: string, values?: unknown[]) {
            if (
              text.includes('FROM webhooks.endpoint_state') &&
              !text.includes('SKIP LOCKED') &&
              text.includes('FOR ')
            ) {
              workerPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
                .rows[0]!.pid
            }
            return client.query<R>(text, values)
          },
        }
      },
    }
    const worker = createWorkerStore(config(source, { database: trackedDatabase, leaseMs: 10_000 }))
    let claimFinished = false
    const claiming = worker.claim().finally(() => {
      claimFinished = true
    })
    // Observe rejection immediately; the joint assertion below still reports any error.
    void claiming.catch(() => {})
    await lookupsStarted.promise

    const control = await database.connect()
    const publisher = await database.connect()
    const gate = (await control.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid
    const publisherPid = (await publisher.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]!.pid
    let publishing: ReturnType<typeof app.publish> | undefined
    async function waitFor(check: () => Promise<boolean>, message: string) {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (await check()) return
        await sleep(10)
      }
      throw new Error(message)
    }
    try {
      await control.query('SELECT pg_advisory_lock(982741, $1)', [gate])
      // PostgreSQL runs this after its FK triggers. The publisher already holds
      // b's KEY SHARE lock when it waits here, before checking recipient a.
      await database.query(`CREATE FUNCTION webhooks.pause_after_b() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.endpoint_id='b' THEN PERFORM pg_advisory_xact_lock(982741, ${gate}); END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER zz_pause_after_b AFTER INSERT ON webhooks.deliveries
        FOR EACH ROW EXECUTE FUNCTION webhooks.pause_after_b()`)
      await publisher.query('BEGIN')
      publishing = app
        .publish({ ...event, data: { id: 2 } }, { transaction: publisher })
        .then(async (result) => {
          await publisher.query('COMMIT')
          return result
        })
      void publishing.catch(() => {})
      await waitFor(
        async () =>
          (
            await database.query<{ waiting: boolean }>(
              "SELECT wait_event='advisory' AS waiting FROM pg_stat_activity WHERE pid=$1",
              [publisherPid],
            )
          ).rows[0]?.waiting === true,
        'Publication did not reach the foreign-key lock gate',
      )

      finishLookups.resolve()
      await waitFor(
        async () =>
          claimFinished ||
          (workerPid !== undefined &&
            (
              await database.query<{ blocked: boolean }>(
                'SELECT $2::int=ANY(pg_blocking_pids($1)) AS blocked',
                [workerPid, publisherPid],
              )
            ).rows[0]?.blocked === true),
        'Worker neither prepared nor reached the publication lock',
      )
      await control.query('SELECT pg_advisory_unlock(982741, $1)', [gate])
      const [claimResult, publicationResult] = await Promise.allSettled([claiming, publishing])
      expect(claimResult.status).toBe('fulfilled')
      expect(publicationResult.status).toBe('fulfilled')
      if (claimResult.status !== 'fulfilled' || publicationResult.status !== 'fulfilled')
        throw new Error('Concurrent publication and worker preparation failed')
      expect(claimResult.value.errors).toEqual([])
      expect(claimResult.value.claims.map((claim) => claim.endpointId).sort()).toEqual(['a', 'b'])
      expect(publicationResult.value.deliveryCount).toBe(2)
      expect(await rows()).toHaveLength(4)
      expect((await rows()).filter((row) => row.status === 'pending')).toHaveLength(2)
      expect((await createWorkerStore(config(source)).claim()).claims).toEqual([])
      expect(
        (
          await database.query(
            'SELECT endpoint_id,max_in_flight FROM webhooks.endpoint_state ORDER BY endpoint_id',
          )
        ).rows,
      ).toEqual([
        { endpoint_id: 'a', max_in_flight: 1 },
        { endpoint_id: 'b', max_in_flight: 1 },
      ])
    } finally {
      finishLookups.resolve()
      await control.query('SELECT pg_advisory_unlock(982741, $1)', [gate])
      await Promise.allSettled([claiming, publishing])
      await publisher.query('ROLLBACK')
      publisher.release()
      control.release()
    }
  })

  it('returns an accepted idempotency result and conflicts without consulting unavailable management', async () => {
    const source = provider()
    source.matchRecipients = vi.fn(source.matchRecipients)
    const app = engine(source)
    const accepted = await app.publish({ ...event, idempotencyKey: 'once' })
    source.matchRecipients = vi.fn(async () => {
      throw new Error('Management unavailable')
    })
    expect(await app.publish({ ...event, idempotencyKey: 'once' })).toEqual({
      ...accepted,
      duplicate: true,
    })
    await expect(
      app.publish({ ...event, data: { id: 2 }, idempotencyKey: 'once' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(source.matchRecipients).not.toHaveBeenCalled()
    expect(await rows()).toHaveLength(1)
  })

  it('keeps only the winning recipient set when concurrent idempotent lookups disagree', async () => {
    const firstLookup = deferred<void>()
    const oldRecipients = deferred<readonly string[]>()
    const source = provider()
    let calls = 0
    source.matchRecipients = async () => {
      if (++calls === 1) {
        firstLookup.resolve()
        return oldRecipients.promise
      }
      return ['new-recipient']
    }
    const app = engine(source)
    const losing = app.publish({ ...event, idempotencyKey: 'race' })
    await firstLookup.promise
    const winning = await app.publish({ ...event, idempotencyKey: 'race' })
    oldRecipients.resolve(['old-recipient'])
    expect(await losing).toEqual({ ...winning, duplicate: true })
    expect((await rows()).map((row) => row.endpoint_id)).toEqual(['new-recipient'])
    expect(
      (await database.query('SELECT count(*)::int AS count FROM webhooks.events')).rows[0].count,
    ).toBe(1)
  })

  it('does not accept partial fanout when recipient lookup fails', async () => {
    const source = provider()
    source.matchRecipients = async () => {
      throw new Error('Second page failed')
    }
    await expect(engine(source).publish(event)).rejects.toThrow('Second page failed')
    expect(await rows()).toEqual([])
    expect(
      (await database.query('SELECT count(*)::int AS count FROM webhooks.events')).rows[0].count,
    ).toBe(0)
    expect(
      (await database.query('SELECT count(*)::int AS count FROM webhooks.endpoint_state')).rows[0]
        .count,
    ).toBe(0)
  })

  it('defers provider failures without recording receiver attempts and recovers using current configuration', async () => {
    const source = provider()
    source.resolveEndpoint = async () => {
      throw new Error('Management unavailable')
    }
    const app = engine(source)
    await app.publish(event)
    await expect(app.worker.tick()).rejects.toBeInstanceOf(AggregateError)
    expect((await rows())[0]).toMatchObject({
      status: 'pending',
      preparing: false,
      attempt_count: 0,
    })
    expect((await database.query('SELECT * FROM webhooks.attempts')).rows).toEqual([])
    const target = await receiver()
    const rotated = generateSecret()
    source.resolveEndpoint = async () => ({ status: 'active', url: target.url, secrets: [rotated] })
    await due()
    expect(await app.worker.tick()).toMatchObject({ claimed: 1, succeeded: 1 })
    verifyWebhook({ ...target.received[0]!, secret: rotated })
  })

  it('preserves retry history and budget through a pause and provider outage', async () => {
    const source = provider()
    const app = engine(source)
    await app.publish(event)
    const store = createWorkerStore(config(source))
    const first = (await store.claim()).claims[0]!
    expect(
      await store.complete(first, {
        status: 503,
        responseBody: 'later',
        error: 'Receiver returned HTTP 503',
        retryable: true,
      }),
    ).toBe('retried')
    source.resolveEndpoint = async () => ({ status: 'paused' })
    await due()
    expect(await app.worker.tick()).toMatchObject({ claimed: 0 })
    expect((await rows())[0]).toMatchObject({
      attempt_count: 1,
      last_status: 503,
      last_error: 'Receiver returned HTTP 503',
    })
    source.resolveEndpoint = async () => {
      throw new Error('Provider outage')
    }
    await due()
    await expect(app.worker.tick()).rejects.toBeInstanceOf(AggregateError)
    expect((await rows())[0].attempt_count).toBe(1)
    expect((await database.query('SELECT * FROM webhooks.attempts')).rows).toHaveLength(1)
    const target = await receiver()
    source.resolveEndpoint = async () => ({ status: 'active', url: target.url, secrets: [secret] })
    await due()
    expect(await app.worker.tick()).toMatchObject({ claimed: 1, succeeded: 1 })
    expect((await rows())[0].attempt_count).toBe(2)
  })

  it('lets healthy siblings send when another provider read stalls', async () => {
    const target = await receiver()
    const source = provider()
    source.matchRecipients = async () => ['stalled', 'healthy']
    source.resolveEndpoint = async (_scope, id) =>
      id === 'stalled'
        ? new Promise<EndpointResolution>(() => {})
        : { status: 'active', url: target.url, secrets: [secret] }
    const app = engine(source, 1000)
    await app.publish(event)
    await expect(app.worker.tick()).rejects.toBeInstanceOf(AggregateError)
    expect(target.received).toHaveLength(1)
    const byId = new Map((await rows()).map((row) => [row.endpoint_id, row]))
    expect(byId.get('healthy')).toMatchObject({ status: 'succeeded', attempt_count: 1 })
    expect(byId.get('stalled')).toMatchObject({ status: 'pending', attempt_count: 0 })
  })

  it('fences a lookup whose reservation expired and was reclaimed by another worker', async () => {
    const lookupStarted = deferred<void>()
    const finishLookup = deferred<EndpointResolution>()
    const source = provider()
    let calls = 0
    source.resolveEndpoint = async () => {
      if (++calls === 1) {
        lookupStarted.resolve()
        return finishLookup.promise
      }
      return active()
    }
    await engine(source).publish(event)
    const first = createWorkerStore(config(source))
    const second = createWorkerStore(config(source))
    const stale = first.claim()
    await lookupStarted.promise
    await database.query(
      "UPDATE webhooks.deliveries SET lease_expires_at=now()-interval '1 second'",
    )
    await second.recoverExpired()
    const replacement = await second.claim()
    expect(replacement.claims).toHaveLength(1)
    finishLookup.resolve(active())
    expect((await stale).claims).toEqual([])
    expect((await database.query('SELECT * FROM webhooks.attempts')).rows).toHaveLength(1)
    expect((await rows())[0].attempt_count).toBe(1)
  })

  it('retains paused work and resumes it without consuming an attempt while paused', async () => {
    const source = provider()
    source.resolveEndpoint = async () => ({ status: 'paused' })
    const app = engine(source)
    await app.publish(event)
    expect(await app.worker.tick()).toMatchObject({ claimed: 0 })
    await app.publish(event)
    expect((await rows()).map((row) => row.attempt_count)).toEqual([0, 0])
    const target = await receiver()
    source.resolveEndpoint = async () => ({ status: 'active', url: target.url, secrets: [secret] })
    await due()
    expect(await app.worker.tick()).toMatchObject({ claimed: 2, succeeded: 2 })
  })

  it('cancels pending work on deletion and allows an already prepared attempt to finish', async () => {
    const source = provider()
    const app = engine(source)
    await app.publish(event)
    const store = createWorkerStore(config(source))
    const { claims } = await store.claim()
    expect(claims).toHaveLength(1)
    await app.publish(event)
    source.resolveEndpoint = async () => ({ status: 'deleted' })
    expect((await store.claim()).claims).toEqual([])
    expect((await rows()).map((row) => row.status)).toEqual(['in_flight', 'cancelled'])
    expect(
      await store.complete(claims[0]!, {
        status: 200,
        responseBody: '',
        error: null,
        retryable: false,
      }),
    ).toBe('succeeded')
  })

  it('cancels unresolved siblings even when one captured active configuration before deletion', async () => {
    const source = provider()
    let calls = 0
    source.resolveEndpoint = async () => (++calls === 1 ? active() : { status: 'deleted' })
    const app = engine(source)
    await app.publish(event)
    await app.publish(event)
    expect((await createWorkerStore(config(source)).claim()).claims).toEqual([])
    expect((await rows()).map((row) => row.status)).toEqual(['cancelled', 'cancelled'])
    expect((await database.query('SELECT * FROM webhooks.attempts')).rows).toEqual([])
  })

  it('isolates endpoint capacity and settings when scopes share an opaque endpoint ID', async () => {
    const source = provider()
    const app = engine(source)
    const personal = app.forScope({ type: 'user', id: 'owner' })
    const organization = app.forScope({ type: 'organization', id: 'owner' })
    expect(await personal.deliverySettings.get(endpointId)).toEqual({ maxInFlight: 2 })
    expect(await personal.deliverySettings.set(endpointId, { maxInFlight: 1 })).toEqual({
      maxInFlight: 1,
    })
    expect(await organization.deliverySettings.get(endpointId)).toEqual({ maxInFlight: 2 })
    for (let n = 0; n < 3; n++) {
      await personal.publish(event)
      await organization.publish(event)
    }
    const claims = (await createWorkerStore(config(source, { concurrency: 10 })).claim()).claims
    expect(
      claims.filter((row) => row.scopeKey === scopeKey({ type: 'user', id: 'owner' })),
    ).toHaveLength(1)
    expect(
      claims.filter((row) => row.scopeKey === scopeKey({ type: 'organization', id: 'owner' })),
    ).toHaveLength(2)
    source.resolveEndpoint = async () => ({ status: 'deleted' })
    await expect(app.deliverySettings.set('missing', { maxInFlight: 1 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('passes the canonical scope to provider lookups', async () => {
    const source = provider()
    const scopes: ManagementScope[] = []
    source.matchRecipients = async (scope) => {
      scopes.push(scope)
      return [endpointId]
    }
    source.resolveEndpoint = async (scope) => {
      scopes.push(scope)
      return { status: 'paused' }
    }
    const app = engine(source)
    await app.publish(event)
    await app.forScope({ type: 'organization', id: 'acme' }).publish(event)
    await app.worker.tick()
    expect(scopes.filter((scope) => scope === null)).toHaveLength(2)
    expect(
      scopes.filter((scope) => scope?.type === 'organization' && scope.id === 'acme'),
    ).toHaveLength(2)
    expect((await rows()).some((row) => row.scope_key === APPLICATION_SCOPE)).toBe(true)
  })

  it('treats an invalid provider result as a lookup failure', async () => {
    const source = provider()
    source.resolveEndpoint = async () => ({ status: 'unknown' }) as unknown as EndpointResolution
    const app = engine(source)
    await app.publish(event)
    await expect(app.worker.tick()).rejects.toBeInstanceOf(AggregateError)
    expect((await rows())[0]).toMatchObject({ status: 'pending', attempt_count: 0 })
  })

  it('stops waiting for provider reads when shutdown is requested', async () => {
    const started = deferred<void>()
    const source = provider()
    source.resolveEndpoint = () => {
      started.resolve()
      return new Promise<EndpointResolution>(() => {})
    }
    const app = engine(source, 60_000)
    await app.publish(event)
    const controller = new AbortController()
    const ticking = app.worker.tick({ signal: controller.signal })
    await started.promise
    controller.abort()
    expect(await ticking).toMatchObject({ claimed: 0 })
    expect((await rows())[0]).toMatchObject({ status: 'pending', attempt_count: 0 })
  })
})
