import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
const minimumTypeScriptVersion = '5.9.3'
const sixTypeScriptVersion = '6.0.3'
const directory = await mkdtemp(join(tmpdir(), 'good-webhooks-consumer-'))
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: 'pipe', encoding: 'utf8' })
// Package-local binaries, so the script also works outside `pnpm run`.
const bin = (name) => join(packageDirectory, 'node_modules', '.bin', name)
const typecheck = (args = []) => {
  // Install the compilers once and check the same archive and inference fixtures.
  for (const compiler of ['typescript-minimum', 'typescript-six', 'typescript']) {
    const executable = join(directory, 'node_modules', compiler, 'bin/tsc')
    const version = run(process.execPath, [executable, '--version'], directory).trim()
    for (const [module, moduleResolution] of [
      ['NodeNext', 'NodeNext'],
      ['ESNext', 'Bundler'],
    ]) {
      console.log(`${version}: ${moduleResolution}, ${args.length ? 'Better Auth' : 'standalone'}`)
      run(
        process.execPath,
        [
          executable,
          '--noEmit',
          '--module',
          module,
          '--moduleResolution',
          moduleResolution,
          ...args,
        ],
        directory,
      )
    }
  }
}
async function consumerFixture(name, replacements) {
  let source = await readFile(join(packageDirectory, 'test', name), 'utf8')
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(from, to)
  if (source.includes('../src/')) throw new Error(`Unmapped source import in ${name}`)
  await writeFile(join(directory, name), source)
}
try {
  const filename = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
  const archive = resolve(packageDirectory, filename)
  run('pnpm', ['pack', '--out', archive], packageDirectory)
  // The package is ESM-only and CommonJS consumers load it through require(esm) on Node.js 24,
  // which the CommonJS assertions below verify, so attw's cjs-resolves-to-esm warning is expected.
  // SQL exports are not modules; attw cannot resolve them, and the consumer test reads each one.
  const sqlExports = Object.keys(manifest.exports).filter((entry) => entry.endsWith('.sql'))
  console.log(
    run(
      bin('attw'),
      [
        archive,
        '--profile',
        'node16',
        '--ignore-rules',
        'cjs-resolves-to-esm',
        '--exclude-entrypoints',
        ...sqlExports,
        '--format',
        'table-flipped',
      ],
      packageDirectory,
    ),
  )
  console.log(run(bin('publint'), [archive, '--strict'], packageDirectory))
  await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}')
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive], directory)
  await writeFile(
    join(directory, 'standalone.mjs'),
    `
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createWebhooks } from 'good-webhooks'
import { createDelivery } from 'good-webhooks/delivery'
import { createManagement } from 'good-webhooks/management'
import { createPostgresManagement } from 'good-webhooks/management/postgres'
import { getPostgresMigration, getPostgresUpgrade, POSTGRES_SCHEMA_VERSION } from 'good-webhooks/migrations'
import { parseWebhook } from 'good-webhooks/verify'
const require = createRequire(import.meta.url)
assert.throws(() => require.resolve('better-auth'), { code: 'MODULE_NOT_FOUND' })
for (const value of [createWebhooks, createDelivery, createManagement, createPostgresManagement, parseWebhook]) assert.equal(typeof value, 'function')
for (const [entry, name] of [['good-webhooks', 'createWebhooks'], ['good-webhooks/delivery', 'createDelivery'], ['good-webhooks/management', 'createManagement'], ['good-webhooks/management/postgres', 'createPostgresManagement'], ['good-webhooks/verify', 'parseWebhook'], ['good-webhooks/migrations', 'getPostgresMigration']]) assert.equal(typeof require(entry)[name], 'function')
assert.ok(getPostgresMigration({schema:'custom',component:'delivery'}).includes('"custom"."webhook_events"'))
assert.equal(POSTGRES_SCHEMA_VERSION, 6)
assert.ok(getPostgresUpgrade({schema:'custom',component:'delivery',from:3}).includes('"custom"."webhook_schema_version"'))
for (const name of ['001-initial', 'management', 'delivery']) {
  const sql = await readFile(new URL(import.meta.resolve('good-webhooks/migrations/' + name + '.sql')), 'utf8')
  assert.ok(sql.includes('CREATE SCHEMA'))
}
for (const name of ['all', 'management', 'delivery']) {
  // Shipped steps are immutable; only the newest one still matches the generator on its own.
  for (const [step, from] of [['004', 3], ['005', 4]]) {
    const sql = await readFile(new URL(import.meta.resolve('good-webhooks/migrations/upgrades/' + step + '-' + name + '.sql')), 'utf8')
    assert.ok(sql.includes('Upgrades schema version ' + from + ' to ' + (from + 1)))
  }
  const step6 = await readFile(new URL(import.meta.resolve('good-webhooks/migrations/upgrades/006-' + name + '.sql')), 'utf8')
  assert.equal(step6, getPostgresUpgrade({ component: name, from: 5 }))
}
`,
  )
  run(process.execPath, ['standalone.mjs'], directory)
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `typescript@${manifest.devDependencies.typescript}`,
      `typescript-minimum@npm:typescript@${minimumTypeScriptVersion}`,
      `typescript-six@npm:typescript@${sixTypeScriptVersion}`,
      `@types/node@${manifest.devDependencies['@types/node']}`,
      `@types/pg@${manifest.devDependencies['@types/pg']}`,
      `pg@${manifest.devDependencies.pg}`,
      `zod@${manifest.dependencies.zod}`,
    ],
    directory,
  )
  await writeFile(
    join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: false,
        types: ['node'],
      },
      include: ['*.ts'],
    }),
  )
  await consumerFixture('consumer-types.ts', {
    '../src/index.js': 'good-webhooks',
    '../src/verify.js': 'good-webhooks/verify',
  })
  await writeFile(
    join(directory, 'management-types.ts'),
    `
import { Pool } from 'pg'
import { z } from 'zod'
import { createDelivery } from 'good-webhooks/delivery'
import { createManagement, type EndpointManagement, type ManagementOptions, type ManagementRepository, type StoredEndpoint } from 'good-webhooks/management'
import { createPostgresManagement } from 'good-webhooks/management/postgres'
import { getPostgresMigration } from 'good-webhooks/migrations'
function consumer(options: ManagementOptions) {
  const portable: EndpointManagement = createManagement(options)
  const management = createPostgresManagement({ database: new Pool(), encryptionKey: new Uint8Array(32), eventTypes: ['invoice.paid'] })
  management.list(null)
  const delivery = createDelivery({ database: new Pool(), source: management.source, events: { 'invoice.paid': z.object({ id: z.string() }) } })
  delivery.publish({ type: 'invoice.paid', data: { id: 'invoice-1' } })
  // @ts-expect-error delivery subpath preserves payload inference
  delivery.publish({ type: 'invoice.paid', data: { id: 1 } })
  // @ts-expect-error direct management requires explicit scope
  portable.list()
  const migration: string = getPostgresMigration({ schema: 'custom', component: 'management' })
  void migration
}
void consumer
const rows: StoredEndpoint[] = []
const repository: ManagementRepository = {
  async list() { return rows },
  async get(_scope, id) { return rows.find((row) => row.id === id) ?? null },
  async create(_scope, endpoint, { limit }) {
    if (rows.length >= limit) throw new Error('ENDPOINT_LIMIT')
    const encryptedHeaders: string | null = endpoint.encryptedHeaders
    const row = { ...endpoint, encryptedHeaders, id: String(rows.length) }
    rows.push(row)
    return row
  },
  async update() { return null },
}
const legacy: ManagementRepository = {
  ...repository,
  // @ts-expect-error create takes { limit } since 0.5.0
  async create(_scope, endpoint, limit: number) { return { ...endpoint, id: String(limit) } },
}
void legacy
`,
  )
  typecheck()
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `better-auth@${manifest.devDependencies['better-auth']}`,
    ],
    directory,
  )
  await writeFile(
    join(directory, 'better-auth.mjs'),
    `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { goodWebhooks, createBetterAuthManagement } from 'good-webhooks/better-auth'
import { goodWebhooksClient } from 'good-webhooks/better-auth/client'
const require = createRequire(import.meta.url)
assert.equal(typeof createBetterAuthManagement, 'function')
assert.deepEqual(Object.keys(goodWebhooks({eventTypes:['invoice.paid']}).schema), ['webhookEndpoint'])
assert.equal(goodWebhooksClient().id, 'good-webhooks')
assert.equal(typeof require('good-webhooks/better-auth').goodWebhooks, 'function')
assert.equal(typeof require('good-webhooks/better-auth/client').goodWebhooksClient, 'function')
`,
  )
  run(process.execPath, ['better-auth.mjs'], directory)
  await consumerFixture('better-auth-consumer-types.ts', {
    '../src/better-auth/index.js': 'good-webhooks/better-auth',
    '../src/better-auth/client.js': 'good-webhooks/better-auth/client',
  })
  // Better Auth 1.7.7 declarations require Bun types and contain upstream strict-type errors.
  // Keep the consumer inference assertions while standalone declarations remain fully checked.
  typecheck(['--skipLibCheck'])
  console.log(
    'Packed consumer checks passed: standalone without Better Auth, plugin imports, ESM, CommonJS, all migrations, and public TypeScript declarations.',
  )
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  await rm(directory, { recursive: true, force: true })
}
