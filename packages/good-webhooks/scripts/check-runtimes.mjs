import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
} finally {
  await rm(directory, { recursive: true, force: true })
}
