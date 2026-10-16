import { mkdir, writeFile } from 'node:fs/promises'
import {
  getPostgresMigration,
  getPostgresUpgrade,
  POSTGRES_SCHEMA_VERSION,
} from '../dist/migrations.js'

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
// Published upgrade files are immutable. Write only the step into the current schema version.
const padded = String(POSTGRES_SCHEMA_VERSION).padStart(3, '0')
for (const component of ['all', 'management', 'delivery']) {
  await writeFile(
    new URL(`../migrations/upgrades/${padded}-${component}.sql`, import.meta.url),
    getPostgresUpgrade({ component, from: POSTGRES_SCHEMA_VERSION - 1 }),
  )
}
