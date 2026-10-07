import { writeFile } from 'node:fs/promises'
import { getPostgresMigration } from '../dist/migrations.js'

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
