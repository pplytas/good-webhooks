// Opt-in real-adapter proof. Every server profile creates and drops its own database.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { betterAuth } from 'better-auth'
import { createBetterAuthManagementSchema } from '../dist/better-auth/schema.js'
import { createBetterAuthRepository } from '../dist/better-auth/store.js'

const run = promisify(execFile)
const profiles = process.argv.slice(2).flatMap((value) => value.split(','))
const allProfiles = ['postgres', 'mysql', 'mongodb', 'mssql', 'libsql', 'd1', 'drizzle', 'prisma']
if (!profiles.length) profiles.push(...allProfiles)
for (const profile of profiles)
  assert.ok(allProfiles.includes(profile), `Unknown profile: ${profile}`)
const idStrategies = [undefined, 'serial', 'uuid']
const scope = { type: 'user', id: `long-owner-${'x'.repeat(189)}` }
const canonicalScope = JSON.stringify(['named', scope.type, scope.id])
const digest = createHash('sha256').update(canonicalScope).digest('hex')
const schema = createBetterAuthManagementSchema({
  modelName: 'mapped_endpoint',
  fields: {
    allocationKey: 'slot_key',
    eventTypes: 'event_types',
    encryptedSecret: 'secret_ciphertext',
  },
})
const data = () => ({
  url: 'https://example.com/hook',
  description: null,
  eventTypes: ['invoice.paid'],
  status: 'active',
  revision: 0,
  encryptedSecret: 'encrypted-value',
  previousEncryptedSecret: null,
  previousSecretExpiresAt: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
})
function options(database, generateId) {
  return {
    database,
    secret: 'local-proof-only-secret-at-least-thirty-two-characters',
    baseURL: 'https://auth.example.com',
    advanced: { database: { validateSchema: false, ...(generateId ? { generateId } : {}) } },
    plugins: [{ id: 'storage-matrix', schema }],
  }
}

async function exercise(name, database, generateId, migrate = true) {
  const auth = betterAuth(options(database, generateId))
  const ctx = await auth.$context
  if (migrate) await ctx.runMigrations()
  const adapter = ctx.adapter
  const repository = createBetterAuthRepository(adapter)
  // Public create would deliberately perform complete lookup for each of these seed rows.
  // Direct adapter seeding keeps the proof fast while exercising the same generated schema.
  for (let slot = 0; slot < 995; slot++) {
    await adapter.create({
      model: 'webhookEndpoint',
      data: {
        ...data(),
        scopeKey: canonicalScope,
        allocationKey: `${digest}:${slot}`,
        creationToken: `seed:${slot}`,
      },
    })
  }
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => repository.create(scope, data())),
  )
  const successes = results.filter((result) => result.status === 'fulfilled')
  const failures = results.filter((result) => result.status === 'rejected')
  assert.equal(
    successes.length,
    5,
    JSON.stringify(failures.map(({ reason }) => ({ message: reason.message, code: reason.code }))),
  )
  assert.ok(failures.every(({ reason }) => reason.code === 'INVALID_STATE'))
  const rows = await repository.list(scope)
  assert.equal(rows.length, 1000)
  assert.ok(rows.every((row) => typeof row.id === 'string' && row.eventTypes[0] === 'invoice.paid'))
  assert.equal(await repository.get({ ...scope, id: scope.id.toUpperCase() }, rows[0].id), null)
  const changes = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      repository.update(scope, rows[0].id, 0, {
        encryptedSecret: `changed-${i}`,
        previousEncryptedSecret: 'encrypted-value',
        previousSecretExpiresAt: new Date('2026-10-08T00:00:00Z'),
      }),
    ),
  )
  assert.equal(changes.filter(Boolean).length, 1)
  const changed = changes.find(Boolean)
  assert.equal(changed.revision, 1)
  assert.equal(changed.previousSecretExpiresAt.toISOString(), '2026-10-08T00:00:00.000Z')
  const deleted = await repository.update(scope, changed.id, 1, { status: 'deleted' })
  assert.equal(deleted.status, 'deleted')
  assert.notEqual((await repository.create(scope, data())).id, deleted.id)
  assert.equal((await repository.list(scope)).length, 1000)
  assert.equal((await repository.get(scope, deleted.id)).status, 'deleted')
  const eventTypes = Array.from(
    { length: 100 },
    (_, i) => `${'x'.repeat(116)}${String(i).padStart(4, '0')}`,
  )
  const updated = await repository.update(scope, rows[1].id, 0, { eventTypes })
  assert.deepEqual(updated.eventTypes, eventTypes)
  assert.deepEqual((await repository.get(scope, rows[1].id)).eventTypes, eventTypes)
  // Three UTF8 bytes per UTF16 code unit exercises the largest byte expansion
  // for these character limits. Astral characters use two UTF16 code units.
  const fillUnicode = (prefix, limit) => prefix + '界'.repeat(limit - prefix.length)
  const unicodeScope = {
    type: fillUnicode('ομάδα🙂', 64),
    id: fillUnicode('ιδιοκτήτης🙂', 200),
  }
  const unicode = {
    ...data(),
    url: fillUnicode('https://example.com/διαδρομή🙂', 2048),
    description: fillUnicode('Περιγραφή 🙂', 2000),
  }
  const unicodeRow = await repository.create(unicodeScope, unicode)
  assert.equal(unicodeRow.url, unicode.url)
  assert.equal(unicodeRow.description, unicode.description)
  assert.equal((await repository.list(unicodeScope))[0].id, unicodeRow.id)
  assert.equal((await repository.get(unicodeScope, unicodeRow.id)).description, unicode.description)
  assert.equal((await repository.create(null, data())).eventTypes[0], 'invoice.paid')
  assert.equal((await repository.list(null)).length, 1)
  console.log(JSON.stringify({ profile: name, ids: generateId ?? 'default', result: 'passed' }))
}

function localURL(value) {
  const url = new URL(value)
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'Matrix server URLs must use loopback hosts.',
  )
  return url
}
function databaseName() {
  return `gw_ba_matrix_${randomUUID().replaceAll('-', '')}`
}
const pgURL = () =>
  localURL(
    process.env.BA_MATRIX_POSTGRES_URL ??
      'postgres://postgres:webhooks_dev_only@127.0.0.1:55439/postgres',
  )

async function postgresDatabase(callback) {
  const { Pool } = await import('pg')
  const url = pgURL()
  const admin = new Pool({ connectionString: url.href })
  const name = databaseName()
  await admin.query(`CREATE DATABASE ${name}`)
  url.pathname = `/${name}`
  const pool = new Pool({ connectionString: url.href, max: 20 })
  try {
    await callback(pool, url.href)
  } finally {
    await pool.end()
    await admin.query(`DROP DATABASE ${name}`)
    await admin.end()
  }
}

async function nativePostgres() {
  for (const ids of idStrategies) await postgresDatabase((pool) => exercise('postgres', pool, ids))
}
async function nativeMysql() {
  const { default: mysql } = await import('mysql2/promise')
  const url = localURL(
    process.env.BA_MATRIX_MYSQL_URL ?? 'mysql://root:webhooks_local_proof@127.0.0.1:55440/mysql',
  )
  const admin = await mysql.createConnection(url.href)
  try {
    for (const ids of idStrategies) {
      const name = databaseName()
      await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4`)
      url.pathname = `/${name}`
      const pool = mysql.createPool({ uri: url.href, connectionLimit: 20 })
      try {
        await exercise('mysql', pool, ids)
      } finally {
        await pool.end()
        await admin.query(`DROP DATABASE ${name}`)
      }
    }
  } finally {
    await admin.end()
  }
}
async function nativeMongo() {
  const [{ MongoClient }, { mongodbAdapter }] = await Promise.all([
    import('mongodb'),
    import('better-auth/adapters/mongodb'),
  ])
  const url = localURL(process.env.BA_MATRIX_MONGODB_URL ?? 'mongodb://127.0.0.1:55441')
  const client = await new MongoClient(url.href).connect()
  try {
    for (const ids of [undefined, 'uuid']) {
      const db = client.db(databaseName())
      try {
        await exercise('mongodb', mongodbAdapter(db, { client, transaction: false }), ids, false)
      } finally {
        await db.dropDatabase()
      }
    }
  } finally {
    await client.close()
  }
}
async function nativeMssql() {
  const [{ Kysely, MssqlDialect, sql }, Tarn, Tedious] = await Promise.all([
    import('kysely'),
    import('tarn'),
    import('tedious'),
  ])
  const url = localURL(
    process.env.BA_MATRIX_MSSQL_URL ?? 'mssql://sa:Local-Proof-Only-Pass123@127.0.0.1:55442/master',
  )
  const connect = (database) =>
    new Kysely({
      dialect: new MssqlDialect({
        tarn: { ...Tarn, options: { min: 0, max: 20 } },
        tedious: {
          ...Tedious,
          connectionFactory: () =>
            new Tedious.Connection({
              server: url.hostname,
              options: {
                port: Number(url.port || 1433),
                encrypt: false,
                trustServerCertificate: true,
                // SQL Server's deadlock detector can take several rounds for
                // the intentional 20-writer race, especially under emulation.
                requestTimeout: 60_000,
                database,
              },
              authentication: {
                type: 'default',
                options: {
                  userName: decodeURIComponent(url.username),
                  password: decodeURIComponent(url.password),
                },
              },
            }),
        },
      }),
    })
  const admin = connect('master')
  try {
    for (const ids of idStrategies) {
      const name = databaseName()
      // BA generates varchar, so use UTF8 collation to preserve arbitrary Unicode inputs.
      await sql
        .raw(`CREATE DATABASE ${name} COLLATE Latin1_General_100_CI_AS_SC_UTF8`)
        .execute(admin)
      const db = connect(name)
      try {
        await exercise('mssql', { db, type: 'mssql' }, ids)
      } finally {
        await db.destroy()
        await sql.raw(`DROP DATABASE ${name}`).execute(admin)
      }
    }
  } finally {
    await admin.destroy()
  }
}
async function nativeLibsql() {
  const [{ Kysely }, { LibsqlDialect }] = await Promise.all([
    import('kysely'),
    import('@libsql/kysely-libsql'),
  ])
  for (const ids of idStrategies) {
    const db = new Kysely({ dialect: new LibsqlDialect({ url: ':memory:' }) })
    try {
      await exercise('libsql', { db, type: 'sqlite' }, ids)
    } finally {
      await db.destroy()
    }
  }
}
async function nativeD1() {
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare')
  for (const ids of idStrategies) {
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        compatibilityDate: '2026-10-01',
        d1Databases: { DB: 'good-webhooks-ba-matrix' },
      }),
    )
    try {
      await exercise('d1-local-workerd', await mf.getD1Database('DB'), ids)
    } finally {
      await mf.dispose()
    }
  }
}

async function generatedWorkspace(callback) {
  // A repository-local disposable directory lets generated clients resolve installed packages.
  const directory = await mkdtemp(resolve('.ba-storage-matrix-'))
  try {
    await callback(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
async function command(binary, args) {
  try {
    await run(resolve('node_modules/.bin', binary), args, { maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    throw new Error(`${binary} failed:\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, {
      cause: error,
    })
  }
}
async function drizzlePostgres() {
  const [{ drizzle }, { drizzleAdapter }, { generateSchema }] = await Promise.all([
    import('drizzle-orm/node-postgres'),
    import('better-auth/adapters/drizzle'),
    import('auth/api'),
  ])
  for (const ids of idStrategies) {
    await postgresDatabase((pool, connectionString) =>
      generatedWorkspace(async (directory) => {
        const database = drizzleAdapter(drizzle(pool), {
          provider: 'pg',
          schema: {},
          transaction: false,
        })
        const opts = options(database, ids)
        const ctx = await betterAuth(opts).$context
        const file = resolve(directory, 'schema.ts')
        const result = await generateSchema({ adapter: ctx.adapter, options: opts, file })
        assert.ok(result.code)
        await writeFile(file, result.code)
        const config = resolve(directory, 'drizzle.config.ts')
        await writeFile(
          config,
          `export default ${JSON.stringify({ dialect: 'postgresql', schema: file, dbCredentials: { url: connectionString } })}`,
        )
        await command('drizzle-kit', ['push', '--config', config, '--force'])
        const generatedSchema = await import(pathToFileURL(file).href)
        await exercise(
          'drizzle-postgres',
          drizzleAdapter(drizzle(pool, { schema: generatedSchema }), {
            provider: 'pg',
            schema: generatedSchema,
            transaction: false,
          }),
          ids,
          false,
        )
      }),
    )
  }
}
async function prismaPostgres() {
  const [{ prismaAdapter }, { PrismaPg }, { generateSchema }] = await Promise.all([
    import('better-auth/adapters/prisma'),
    import('@prisma/adapter-pg'),
    import('auth/api'),
  ])
  for (const ids of idStrategies) {
    await postgresDatabase((_pool, connectionString) =>
      generatedWorkspace(async (directory) => {
        const opts = options(prismaAdapter({}, { provider: 'postgresql', transaction: false }), ids)
        const ctx = await betterAuth(opts).$context
        const file = resolve(directory, 'schema.prisma')
        await writeFile(
          file,
          'generator client {\n provider = "prisma-client"\n output = "./client"\n importFileExtension = "ts"\n}\ndatasource db {\n provider = "postgresql"\n}\n',
        )
        const result = await generateSchema({ adapter: ctx.adapter, options: opts, file })
        assert.ok(result.code)
        await writeFile(file, result.code)
        const config = resolve(directory, 'prisma.config.ts')
        await writeFile(
          config,
          `export default ${JSON.stringify({ schema: file, datasource: { url: connectionString } })}`,
        )
        await command('prisma', ['generate', '--config', config])
        await command('prisma', ['db', 'push', '--config', config])
        const { PrismaClient } = await import(
          pathToFileURL(resolve(directory, 'client/client.ts')).href
        )
        const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
        try {
          await exercise(
            'prisma-postgres',
            prismaAdapter(client, { provider: 'postgresql', transaction: false }),
            ids,
            false,
          )
        } finally {
          await client.$disconnect()
        }
      }),
    )
  }
}

const runners = {
  postgres: nativePostgres,
  mysql: nativeMysql,
  mongodb: nativeMongo,
  mssql: nativeMssql,
  libsql: nativeLibsql,
  d1: nativeD1,
  drizzle: drizzlePostgres,
  prisma: prismaPostgres,
}
for (const profile of profiles) await runners[profile]()
