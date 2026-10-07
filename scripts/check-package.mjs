import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'good-webhooks-consumer-'))
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: 'pipe', encoding: 'utf8' })
try {
  const [{ filename }] = JSON.parse(
    run('npm', ['pack', '--json', '--ignore-scripts'], process.cwd()),
  )
  await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}')
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', resolve(filename)],
    directory,
  )
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
import { getPostgresMigration } from 'good-webhooks/migrations'
import { parseWebhook } from 'good-webhooks/verify'
const require = createRequire(import.meta.url)
assert.throws(() => require.resolve('better-auth'), { code: 'MODULE_NOT_FOUND' })
for (const value of [createWebhooks, createDelivery, createManagement, createPostgresManagement, parseWebhook]) assert.equal(typeof value, 'function')
for (const [entry, name] of [['good-webhooks', 'createWebhooks'], ['good-webhooks/delivery', 'createDelivery'], ['good-webhooks/management', 'createManagement'], ['good-webhooks/management/postgres', 'createPostgresManagement'], ['good-webhooks/verify', 'parseWebhook'], ['good-webhooks/migrations', 'getPostgresMigration']]) assert.equal(typeof require(entry)[name], 'function')
assert.ok(getPostgresMigration({schema:'custom',component:'delivery'}).includes('"custom"."webhook_events"'))
for (const name of ['001-initial', 'management', 'delivery']) {
  const sql = await readFile(new URL(import.meta.resolve('good-webhooks/migrations/' + name + '.sql')), 'utf8')
  assert.ok(sql.includes('CREATE SCHEMA'))
}
`,
  )
  run(process.execPath, ['standalone.mjs'], directory)
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
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
  console.log(
    'Packed consumer checks passed: standalone without Better Auth, plugin imports, ESM, CommonJS, and all migrations.',
  )
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  await rm(directory, { recursive: true, force: true })
}
