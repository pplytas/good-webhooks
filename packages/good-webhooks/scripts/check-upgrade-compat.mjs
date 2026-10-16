// Mixed-version rehearsal: the previously published package against this checkout's schema and SQL.
// Proves that old processes fail fast on upgraded storage, new processes fail fast on old storage,
// and a backlog queued by the old package is delivered by the new one after the upgrade SQL runs.
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { createWebhooks } from '../dist/index.js'
import { getPostgresUpgrade, POSTGRES_SCHEMA_VERSION } from '../dist/migrations.js'

const connectionString = process.env.TEST_DATABASE_URL
if (!connectionString) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database.')
const previous = process.env.PREVIOUS_GOOD_WEBHOOKS_VERSION ?? '0.1.1'
const encryptionKey = Buffer.alloc(32, 7).toString('base64')
const events = {
  'invoice.paid': {
    '~standard': { version: 1, vendor: 'compat', validate: (value) => ({ value }) },
  },
}
const scope = { type: 'user', id: 'compat' }

const directory = await mkdtemp(join(tmpdir(), 'good-webhooks-compat-'))
const pool = new Pool({ connectionString, max: 4 })
let received = 0
const server = createServer((_request, response) => {
  received++
  response.writeHead(204).end()
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const url = `http://127.0.0.1:${server.address().port}/hook`

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
async function expectMismatch(promise, label) {
  try {
    await promise
  } catch (error) {
    assert(
      error?.code === 'SCHEMA_MISMATCH',
      `${label}: expected SCHEMA_MISMATCH, got ${error?.code ?? error}`,
    )
    console.log(`${label}: ${error.message}`)
    return
  }
  throw new Error(`${label}: expected SCHEMA_MISMATCH`)
}
async function apply(sql) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(sql)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
async function drain(app) {
  const total = { claimed: 0, succeeded: 0 }
  for (let round = 0; round < 10; round++) {
    const result = await app.worker.runOnce()
    total.claimed += result.claimed
    total.succeeded += result.succeeded
    if (result.claimed === 0) break
  }
  return total
}
async function reset() {
  await pool.query(`DROP TABLE IF EXISTS public.webhook_attempts, public.webhook_deliveries,
    public.webhook_events, public.webhook_endpoint_state, public.webhook_endpoints,
    public.webhook_schema_version CASCADE`)
}

try {
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'compat', private: true, type: 'module' }),
  )
  execFileSync(
    'npm',
    ['install', '--no-audit', '--no-fund', '--silent', `good-webhooks@${previous}`, 'pg@^8.23.1'],
    {
      cwd: directory,
      stdio: 'inherit',
    },
  )
  const previousPackage = join(directory, 'node_modules/good-webhooks')
  const old = {
    ...(await import(pathToFileURL(join(previousPackage, 'dist/index.js')).href)),
    ...(await import(pathToFileURL(join(previousPackage, 'dist/migrations.js')).href)),
  }
  // Packages before beta.2 do not export their schema version; they wrote version 3.
  const from = old.POSTGRES_SCHEMA_VERSION ?? 3
  const oldApp = old.createWebhooks({ database: pool, encryptionKey, events, allowLocalhost: true })
  const newApp = createWebhooks({ database: pool, encryptionKey, events, allowLocalhost: true })

  // 1. Old storage, old package: the baseline a running installation starts from.
  await reset()
  await apply(old.getPostgresMigration())
  await oldApp.check()
  const { endpoint } = await oldApp
    .forScope(scope)
    .endpoints.create({ url, eventTypes: ['invoice.paid'] })
  for (const id of ['inv_1', 'inv_2', 'inv_3'])
    await oldApp.forScope(scope).publish({ type: 'invoice.paid', data: { id }, idempotencyKey: id })

  // 2. New package on old storage must refuse to start and name the upgrade.
  await expectMismatch(newApp.check(), `new ${POSTGRES_SCHEMA_VERSION} on old storage`)

  // 3. Upgrade SQL runs while the backlog is pending; the old process keeps working until it restarts.
  await apply(getPostgresUpgrade({ from }))
  const result = await drain(oldApp)
  assert(
    result.succeeded === 3,
    `old worker after upgrade SQL: expected 3 deliveries, got ${JSON.stringify(result)}`,
  )
  assert(received === 3, `receiver saw ${received} requests`)

  // 4. A restarted old process must fail fast on upgraded storage.
  await expectMismatch(oldApp.check(), `old ${previous} on upgraded storage`)

  // 5. The new package starts and continues the same endpoint's work.
  await newApp.check()
  await newApp
    .forScope(scope)
    .publish({ type: 'invoice.paid', data: { id: 'inv_4' }, idempotencyKey: 'inv_4' })
  const drained = await drain(newApp)
  assert(drained.succeeded === 1, `new worker: ${JSON.stringify(drained)}`)
  assert(received === 4, `receiver saw ${received} requests`)
  const history = await newApp.forScope(scope).deliveries.list({ endpointId: endpoint.id })
  assert(
    history.items.length === 4,
    `expected 4 deliveries in history, got ${history.items.length}`,
  )
  assert(
    history.items.every((item) => item.status === 'succeeded'),
    'every delivery succeeded',
  )

  console.log(
    `Upgrade compatibility passed: ${previous} storage (schema ${from}) and backlog upgraded to schema ${POSTGRES_SCHEMA_VERSION}.`,
  )
} finally {
  await reset().catch(() => {})
  await pool.end()
  await new Promise((resolve) => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
