import { mkdir, writeFile } from 'node:fs/promises'
import { getPostgresMigration, getPostgresUpgrade } from '../dist/migrations.js'

for (const [file, component] of [
  ['001-initial', 'all'],
  ['management', 'management'],
  ['delivery', 'delivery'],
]) {
  await writeFile(
    new URL(`../migrations/${file}.sql`, import.meta.url),
    getPostgresMigration({ component }),
  )
}

await mkdir(new URL('../migrations/upgrades/', import.meta.url), { recursive: true })
for (const component of ['all', 'management', 'delivery']) {
  await writeFile(
    new URL(`../migrations/upgrades/004-${component}.sql`, import.meta.url),
    getPostgresUpgrade({ component, from: 3 }),
  )
}
