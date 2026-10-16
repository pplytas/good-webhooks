// Prints the Better Auth release CI should test for a range, such as `~1.7.7` or `~1.8.0-0`.
// Like pnpm's default minimum release age, it prefers the newest matching release that is at least
// a day old and falls back to the newest one. CI installs the printed version exactly, because a
// range that the lockfile already satisfies would keep the locked version.
import { execFileSync } from 'node:child_process'

const range = process.argv[2]
if (!range) throw new Error('Usage: node scripts/better-auth-version.mjs <range>')

const view = (...args) =>
  JSON.parse(execFileSync('npm', ['view', ...args, '--json'], { encoding: 'utf8' }))
const published = view('better-auth', 'time')
const matching = [view(`better-auth@${range}`, 'version')]
  .flat()
  .sort((a, b) => Date.parse(published[a]) - Date.parse(published[b]))
if (!matching.length) throw new Error(`No better-auth release matches ${range}`)

const dayAgo = Date.now() - 24 * 60 * 60 * 1000
const mature = matching.filter((version) => Date.parse(published[version]) <= dayAgo)
console.log((mature.length ? mature : matching).at(-1))
