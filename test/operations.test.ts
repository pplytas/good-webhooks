import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer, type Server, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkerStore } from '../src/worker-store.js'
import {
  dropWebhookTables,
  closeDatabase,
  pool,
  resetDatabase,
  testConfig,
  testStore as createStore,
  testScopeKey,
} from './db.js'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const databaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:webhooks_dev_only@127.0.0.1:55439/webhooks'
const encryptionKey = Buffer.from(new Uint8Array(32).fill(7)).toString('base64')
const children: Running[] = []
const cleanupServers: Array<() => Promise<void>> = []

type ExitResult = { code: number | null; signal: NodeJS.Signals | null }
type Running = {
  child: ChildProcessWithoutNullStreams
  readonly stdout: string
  readonly stderr: string
  result: Promise<ExitResult>
}

function start(args: string[], overrides: NodeJS.ProcessEnv = {}): Running {
  const child = spawn(process.execPath, args, {
    cwd,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      WEBHOOK_ENCRYPTION_KEY: encryptionKey,
      WEBHOOK_ALLOW_LOCALHOST: 'true',
      WEBHOOK_DB_CONNECT_TIMEOUT_MS: '500',
      WEBHOOK_DB_STATEMENT_TIMEOUT_MS: '1000',
      WEBHOOK_POLL_INTERVAL_MS: '60000',
      WEBHOOK_CLEANUP_MAX_BATCHES: '20',
      WEBHOOK_CLEANUP_MAX_DURATION_MS: '30000',
      ...overrides,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const result = new Promise<ExitResult>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const running = {
    child,
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
    result,
  }
  children.push(running)
  return running
}

function example(entry: 'worker' | 'cleanup', env?: NodeJS.ProcessEnv): Running {
  return start([`examples/operations/${entry}.ts`], env)
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(20)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

async function ready(running: Running): Promise<void> {
  await waitUntil(() => {
    if (running.stdout.includes('webhooks.worker.started')) return true
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      throw new Error(`Worker exited before startup: ${running.stderr}`)
    }
    return false
  }, 'worker startup')
}

function records(output: string): Array<Record<string, unknown>> {
  return output
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
}

async function assertClosed(role: 'worker' | 'cleanup'): Promise<void> {
  await waitUntil(async () => {
    const result = await pool.query(
      'SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1',
      [`webhooks-example-${role}`],
    )
    return result.rows.length === 0
  }, `${role} database connections to close`)
}

async function listen(server: Server): Promise<number> {
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  cleanupServers.push(async () => {
    for (const socket of sockets) socket.destroy()
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.')
  return address.port
}

async function queued(url = 'http://127.0.0.1:19001/hooks') {
  const store = createStore(testConfig())
  const { endpoint } = await store.createEndpoint('operations', {
    url,
    eventTypes: ['invoice.paid'],
  })
  const event = await store.publish('operations', {
    type: 'invoice.paid',
    data: { invoiceId: 'inv_operations', amount: 42 },
  })
  const delivery = (await store.listDeliveries('operations')).items[0]!
  return { endpoint, event, delivery }
}

async function expired(count: number): Promise<void> {
  await pool.query(
    `INSERT INTO public.webhook_events(id,scope_key,type,body,fingerprint,created_at)
    SELECT gen_random_uuid(),$2,'invoice.paid','{}','fixture',now()-interval '8 days'
    FROM generate_series(1,$1::integer)`,
    [count, testScopeKey('operations')],
  )
}

beforeEach(resetDatabase)
afterEach(async () => {
  for (const running of children) {
    if (running.child.exitCode === null && running.child.signalCode === null)
      running.child.kill('SIGKILL')
  }
  await Promise.all(children.splice(0).map((child) => child.result))
  for (const close of cleanupServers.splice(0)) await close()
})
afterAll(closeDatabase)

describe('worker process lifecycle', () => {
  it('imports configuration without reading required environment or opening connections', async () => {
    const running = start(
      [
        '--input-type=module',
        '--eval',
        'await import("./examples/operations/config.ts"); console.log("inert import")',
      ],
      { DATABASE_URL: undefined, WEBHOOK_ENCRYPTION_KEY: undefined },
    )
    expect(await running.result).toEqual({ code: 0, signal: null })
    expect(running.stdout).toContain('inert import')
    expect(running.stderr).toBe('')
    await assertClosed('worker')
  })

  it.each(['worker', 'cleanup'] as const)(
    'fails %s without persistent configuration',
    async (entry) => {
      const running = example(entry, { WEBHOOK_ENCRYPTION_KEY: undefined })
      expect(await running.result).toEqual({ code: 1, signal: null })
      expect(records(running.stderr)).toContainEqual(
        expect.objectContaining({
          event: `webhooks.${entry}.failed`,
          phase: 'configuration',
          message: 'WEBHOOK_ENCRYPTION_KEY is required.',
        }),
      )
      await assertClosed(entry)
    },
  )

  it('rejects an invalid encryption key before startup I/O', async () => {
    const running = example('worker', { WEBHOOK_ENCRYPTION_KEY: 'not-a-key' })
    expect(await running.result).toEqual({ code: 1, signal: null })
    expect(records(running.stderr)).toContainEqual(
      expect.objectContaining({ code: 'INVALID_CONFIG', phase: 'configuration' }),
    )
    await assertClosed('worker')
  })

  it.each(['worker', 'cleanup'] as const)(
    'closes the pool when %s startup finds no schema',
    async (entry) => {
      await dropWebhookTables(pool)
      const running = example(entry)
      expect(await running.result).toEqual({ code: 1, signal: null })
      expect(records(running.stderr)).toContainEqual(
        expect.objectContaining({ code: 'SCHEMA_MISMATCH', phase: 'startup' }),
      )
      await assertClosed(entry)
    },
  )

  it('exits nonzero on a worker failure without consuming an attempt', async () => {
    const { delivery } = await queued()
    const running = example('worker', {
      WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
    })
    expect(await running.result).toEqual({ code: 1, signal: null })
    expect(running.stdout).toContain('webhooks.worker.started')
    expect(records(running.stderr)).toContainEqual(
      expect.objectContaining({ name: 'AggregateError', phase: 'run' }),
    )
    expect(
      (
        await pool.query('SELECT status,attempt_count FROM public.webhook_deliveries WHERE id=$1', [
          delivery.id,
        ])
      ).rows[0],
    ).toEqual({
      status: 'pending',
      attempt_count: 0,
    })
    await assertClosed('worker')
  })

  it('handles a real idle-pool connection error and exits nonzero', async () => {
    const running = example('worker')
    await ready(running)
    let pid: number | undefined
    await waitUntil(async () => {
      const result = await pool.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='webhooks-example-worker' AND state='idle'",
      )
      pid = result.rows[0]?.pid
      return pid !== undefined
    }, 'an idle worker connection')
    await pool.query('SELECT pg_terminate_backend($1)', [pid])
    expect(await running.result).toEqual({ code: 1, signal: null })
    expect(records(running.stderr)).toContainEqual(
      expect.objectContaining({ event: 'webhooks.worker.failed', phase: 'pool' }),
    )
    expect(running.stderr).not.toContain("Unhandled 'error' event")
    await assertClosed('worker')
  })

  it('bounds a blocked startup statement and closes its connection', async () => {
    const lock = await pool.connect()
    try {
      await lock.query('BEGIN')
      await lock.query('LOCK TABLE public.webhook_schema_version IN ACCESS EXCLUSIVE MODE')
      const running = example('worker', { WEBHOOK_DB_STATEMENT_TIMEOUT_MS: '150' })
      const started = Date.now()
      expect(await running.result).toEqual({ code: 1, signal: null })
      expect(Date.now() - started).toBeLessThan(4000)
      expect(records(running.stderr)).toContainEqual(
        expect.objectContaining({ code: '57014', phase: 'startup' }),
      )
      await assertClosed('worker')
    } finally {
      await lock.query('ROLLBACK')
      lock.release()
    }
  })

  it('handles a database disconnect while a transaction owns the client', async () => {
    const lock = await pool.connect()
    try {
      await lock.query('BEGIN')
      await lock.query('LOCK TABLE public.webhook_endpoint_state IN ACCESS EXCLUSIVE MODE')
      const running = example('worker', { WEBHOOK_DB_STATEMENT_TIMEOUT_MS: '5000' })
      await ready(running)
      let pid: number | undefined
      await waitUntil(async () => {
        const result = await pool.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='webhooks-example-worker' AND wait_event_type='Lock'",
        )
        pid = result.rows[0]?.pid
        return pid !== undefined
      }, 'a checked-out worker connection to block inside its transaction')
      await pool.query('SELECT pg_terminate_backend($1)', [pid])
      expect(await running.result).toEqual({ code: 1, signal: null })
      expect(records(running.stderr)).toContainEqual(
        expect.objectContaining({ event: 'webhooks.worker.failed' }),
      )
      expect(running.stderr).not.toContain("Unhandled 'error' event")
      await assertClosed('worker')
    } finally {
      await lock.query('ROLLBACK')
      lock.release()
    }
  })

  it('bounds a database connection that accepts TCP but never completes startup', async () => {
    const port = await listen(createTcpServer(() => undefined))
    const running = example('worker', {
      DATABASE_URL: `postgres://postgres:unused@127.0.0.1:${port}/stalled`,
      WEBHOOK_DB_CONNECT_TIMEOUT_MS: '150',
    })
    const started = Date.now()
    expect(await running.result).toEqual({ code: 1, signal: null })
    expect(Date.now() - started).toBeLessThan(4000)
    expect(records(running.stderr)).toContainEqual(expect.objectContaining({ phase: 'startup' }))
  })

  it('stops normally on SIGTERM and closes the pool', async () => {
    const running = example('worker')
    await ready(running)
    running.child.kill('SIGTERM')
    expect(await running.result).toEqual({ code: 0, signal: null })
    expect(running.stdout).toContain('webhooks.worker.stopped')
    expect(running.stderr).toBe('')
    await assertClosed('worker')
  })

  it('stops during delivery and persists an unknown receiver outcome', async () => {
    let received = false
    const port = await listen(
      createHttpServer((request) => {
        request.resume()
        received = true
      }),
    )
    const { delivery } = await queued(`http://127.0.0.1:${port}/hooks`)
    const running = example('worker')
    await ready(running)
    await waitUntil(() => received, 'the receiver to see an active delivery')
    running.child.kill('SIGTERM')
    expect(await running.result).toEqual({ code: 0, signal: null })
    expect(running.stderr).toBe('')
    expect(
      (
        await pool.query('SELECT status,last_error FROM public.webhook_deliveries WHERE id=$1', [
          delivery.id,
        ])
      ).rows[0],
    ).toMatchObject({
      status: 'pending',
      last_error: 'Worker stopped; receiver outcome is unknown',
    })
    expect(
      (
        await pool.query('SELECT outcome FROM public.webhook_attempts WHERE delivery_id=$1', [
          delivery.id,
        ])
      ).rows,
    ).toEqual([{ outcome: 'abandoned' }])
    await assertClosed('worker')
  })
})

describe('bounded cleanup process', () => {
  it('runs multiple sequential batches and continues after a short positive batch', async () => {
    await expired(205)
    const running = example('cleanup')
    expect(await running.result).toEqual({ code: 0, signal: null })
    expect(records(running.stdout)).toContainEqual({
      event: 'webhooks.cleanup.finished',
      batches: 4,
      deleted: 205,
      reason: 'no_progress',
    })
    expect(running.stderr).toBe('')
    expect((await pool.query('SELECT id FROM public.webhook_events')).rows).toEqual([])
    await assertClosed('cleanup')
  })

  it('stops at its batch budget and reports the bounded work without claiming completion', async () => {
    await expired(205)
    const running = example('cleanup', { WEBHOOK_CLEANUP_MAX_BATCHES: '1' })
    expect(await running.result).toEqual({ code: 0, signal: null })
    expect(records(running.stdout)).toContainEqual({
      event: 'webhooks.cleanup.finished',
      batches: 1,
      deleted: 100,
      reason: 'batch_budget',
    })
    expect(records(running.stderr)).toContainEqual({
      event: 'webhooks.cleanup.budget_exhausted',
      batches: 1,
      deleted: 100,
      reason: 'batch_budget',
    })
    expect(
      (await pool.query('SELECT count(*)::integer AS count FROM public.webhook_events')).rows[0]
        .count,
    ).toBe(105)
  })

  it('stops after an in-progress batch exceeds the time budget', async () => {
    await expired(205)
    const lock = await pool.connect()
    try {
      await lock.query('BEGIN')
      await lock.query('LOCK TABLE public.webhook_events IN ACCESS EXCLUSIVE MODE')
      const running = example('cleanup', {
        WEBHOOK_CLEANUP_MAX_DURATION_MS: '100',
        WEBHOOK_DB_STATEMENT_TIMEOUT_MS: '5000',
      })
      // Observe the blocked query's elapsed time instead of guessing when the child starts.
      await waitUntil(async () => {
        const result = await pool.query(`SELECT pid FROM pg_stat_activity
          WHERE datname=current_database() AND application_name='webhooks-example-cleanup'
          AND wait_event_type='Lock' AND clock_timestamp()-query_start > interval '150 milliseconds'`)
        return result.rows.length === 1
      }, 'a cleanup batch to remain blocked beyond its time budget')
      await lock.query('COMMIT')
      expect(await running.result).toEqual({ code: 0, signal: null })
      expect(records(running.stdout)).toContainEqual({
        event: 'webhooks.cleanup.finished',
        batches: 1,
        deleted: 100,
        reason: 'time_budget',
      })
      expect(records(running.stderr)).toContainEqual({
        event: 'webhooks.cleanup.budget_exhausted',
        batches: 1,
        deleted: 100,
        reason: 'time_budget',
      })
      expect(
        (await pool.query('SELECT count(*)::integer AS count FROM public.webhook_events')).rows[0]
          .count,
      ).toBe(105)
      await assertClosed('cleanup')
    } finally {
      await lock.query('ROLLBACK')
      lock.release()
    }
  })

  it('finishes an active prune batch after SIGTERM and closes without starting another', async () => {
    await expired(205)
    const lock = await pool.connect()
    try {
      await lock.query('BEGIN')
      await lock.query('LOCK TABLE public.webhook_events IN ACCESS EXCLUSIVE MODE')
      const running = example('cleanup', { WEBHOOK_DB_STATEMENT_TIMEOUT_MS: '5000' })
      await waitUntil(async () => {
        const result = await pool.query(`SELECT pid FROM pg_stat_activity
          WHERE datname=current_database() AND application_name='webhooks-example-cleanup'
          AND wait_event_type='Lock'`)
        return result.rows.length === 1
      }, 'a cleanup batch to block inside its transaction')
      expect(running.child.kill('SIGTERM')).toBe(true)
      await lock.query('COMMIT')
      expect(await running.result).toEqual({ code: 0, signal: null })
      expect(records(running.stdout)).toContainEqual({
        event: 'webhooks.cleanup.finished',
        batches: 1,
        deleted: 100,
        reason: 'signal',
      })
      expect(running.stderr).toBe('')
      expect(
        (await pool.query('SELECT count(*)::integer AS count FROM public.webhook_events')).rows[0]
          .count,
      ).toBe(105)
      await assertClosed('cleanup')
    } finally {
      await lock.query('ROLLBACK')
      lock.release()
    }
  })

  it('defers active leases and removes their history on a later run after lease expiry', async () => {
    const { event } = await queued()
    await createWorkerStore(testConfig()).claim()
    await pool.query("UPDATE public.webhook_events SET created_at=now()-interval '8 days'")
    await expired(101)
    const first = example('cleanup')
    expect(await first.result).toEqual({ code: 0, signal: null })
    expect(records(first.stdout)).toContainEqual(
      expect.objectContaining({ deleted: 101, reason: 'no_progress' }),
    )
    expect((await pool.query('SELECT id FROM public.webhook_events')).rows).toEqual([
      { id: event.eventId },
    ])
    await pool.query(
      "UPDATE public.webhook_deliveries SET lease_expires_at=now()-interval '1 second'",
    )
    const later = example('cleanup')
    expect(await later.result).toEqual({ code: 0, signal: null })
    expect(records(later.stdout)).toContainEqual(
      expect.objectContaining({ deleted: 1, reason: 'no_progress' }),
    )
    expect((await pool.query('SELECT id FROM public.webhook_events')).rows).toEqual([])
  })

  it('reports zero progress under endpoint contention while expired history still exists', async () => {
    const { endpoint, event } = await queued()
    await pool.query("UPDATE public.webhook_events SET created_at=now()-interval '8 days'")
    const lock = await pool.connect()
    try {
      await lock.query('BEGIN')
      await lock.query(
        'SELECT endpoint_id FROM public.webhook_endpoint_state WHERE endpoint_id=$1 FOR UPDATE',
        [endpoint.id],
      )
      const running = example('cleanup')
      expect(await running.result).toEqual({ code: 0, signal: null })
      expect(records(running.stdout)).toContainEqual({
        event: 'webhooks.cleanup.finished',
        batches: 1,
        deleted: 0,
        reason: 'no_progress',
      })
      expect((await pool.query('SELECT id FROM public.webhook_events')).rows).toEqual([
        { id: event.eventId },
      ])
    } finally {
      await lock.query('ROLLBACK')
      lock.release()
    }
  })
})
