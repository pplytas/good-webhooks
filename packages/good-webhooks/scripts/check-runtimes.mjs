import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
const archive = resolve(
  packageDirectory,
  `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`,
)
const directory = await mkdtemp(join(tmpdir(), 'good-webhooks-runtimes-'))
const smoke = await readFile(
  join(packageDirectory, 'scripts', 'runtime-compatibility-smoke.mjs'),
  'utf8',
)
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' })

try {
  const bunDirectory = join(directory, 'bun')
  const denoDirectory = join(directory, 'deno')
  await mkdir(bunDirectory)
  await mkdir(denoDirectory)
  for (const consumer of [bunDirectory, denoDirectory]) {
    await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}')
    await writeFile(join(consumer, 'runtime-compatibility-smoke.mjs'), smoke)
  }

  run('bun', ['add', archive], bunDirectory)
  run('bun', ['run', 'runtime-compatibility-smoke.mjs'], bunDirectory)
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive], denoDirectory)
  run(
    'deno',
    ['run', '--node-modules-dir=manual', 'runtime-compatibility-smoke.mjs'],
    denoDirectory,
  )
  console.log('Packed good-webhooks/verify passed its Bun and Deno smoke checks.')

  const workersDirectory = join(directory, 'workers')
  await mkdir(workersDirectory)
  await writeFile(join(workersDirectory, 'package.json'), '{"private":true,"type":"module"}')
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive], workersDirectory)
  const dist = join(workersDirectory, 'node_modules', 'good-webhooks', 'dist')
  const modules = await workerModules(dist)
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare')
  // Module paths outside the working directory need their own root.
  const worker = (options) =>
    new Miniflare(convertV4MiniflareOptions({ ...options, modulesRoot: dist, modules }))
  const workerd = createRequire(import.meta.resolve('miniflare'))('workerd/package.json').version

  const smokeCheck = async (options) => {
    const instance = worker(options)
    try {
      const result = await (await instance.dispatchFetch('http://localhost/')).json()
      if (!result.ok) throw new Error(`Cloudflare Workers smoke check failed:\n${result.error}`)
    } finally {
      await instance.dispose()
    }
  }
  await smokeCheck({ compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'] })
  // Same date with and without the flag, so only Node.js compatibility decides whether it starts.
  // workerd's stderr is not reliably part of the rejection, so the paired run proves the cause.
  await smokeCheck({ compatibilityDate: '2024-09-23', compatibilityFlags: ['nodejs_compat'] })
  console.log(
    'Expecting the next worker to fail to start: compatibility date 2024-09-23 without nodejs_compat.',
  )
  const incompatible = worker({ compatibilityDate: '2024-09-23' })
  try {
    const started = await incompatible.ready.then(
      () => true,
      () => false,
    )
    if (started) throw new Error('The worker started without Node.js compatibility.')
  } finally {
    await incompatible.dispose().catch(() => {})
  }
  console.log(
    `Packed good-webhooks/verify passed its Cloudflare Workers smoke check on workerd ${workerd}, and fails to start without nodejs_compat.`,
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}

// The verify entry point and its imports, plus an entry that runs the smoke check per request.
async function workerModules(dist) {
  if (!smoke.includes("from 'good-webhooks/verify'")) throw new Error('The smoke import moved.')
  // Every built module, so a new import in verify.js resolves; unreferenced modules are harmless.
  const names = (await readdir(dist)).filter((name) => name.endsWith('.js'))
  const modules = await Promise.all(
    names.map(async (name) => ({
      type: 'ESModule',
      path: join(dist, name),
      contents: await readFile(join(dist, name), 'utf8'),
    })),
  )
  // The static import makes a missing node:crypto fail at startup, which the negative run checks.
  const entry = `import './verify.js'
export default {
  async fetch() {
    try {
      await import('./runtime-compatibility-smoke.js')
      return Response.json({ ok: true })
    } catch (error) {
      return Response.json({ ok: false, error: String(error?.stack ?? error) })
    }
  },
}`
  return [
    { type: 'ESModule', path: join(dist, 'entry.js'), contents: entry },
    {
      type: 'ESModule',
      path: join(dist, 'runtime-compatibility-smoke.js'),
      contents: smoke.replace("'good-webhooks/verify'", "'./verify.js'"),
    },
    ...modules,
  ]
}
