import { describe, expect, it } from 'vitest'
import { getPostgresMigration, getPostgresUpgrade } from '../src/migrations.js'

const schemaWithPercent = 'webb%hook'
const schemaWithDollars = 'web$$hook'

function doTagOf(sql: string): string {
  const match = /\bDO\s+(\$[^$]{0,40}\$)\s+BEGIN/.exec(sql)
  if (match === null) throw new Error(`no DO block found in:\n${sql}`)
  return match[1]!
}

describe('upgrade blocks with unusual schema names', () => {
  // A bare % inside RAISE's format string is a placeholder with no matching argument, which makes
  // PostgreSQL reject the whole function at compile time.
  it('escapes % in the RAISE message', () => {
    const sql = getPostgresUpgrade({ schema: schemaWithPercent, component: 'delivery', from: 6 })
    const raise = sql.split('\n').find((line) => line.includes('RAISE EXCEPTION'))
    expect(raise).toBeDefined()
    expect(raise).toContain(`"${schemaWithPercent.replace('%', '%%')}"`)
    // Every % that is not part of a %% pair would be a placeholder.
    expect(raise!.replaceAll('%%', '')).not.toContain('%')
  })

  // $$ terminates the DO block's body early, so the tag has to be one the schema name cannot close.
  it('picks a dollar tag the schema name cannot terminate', () => {
    const sql = getPostgresUpgrade({ schema: schemaWithDollars, component: 'delivery', from: 6 })
    const tag = doTagOf(sql)
    expect(tag).not.toBe('$$')
    expect(schemaWithDollars).not.toContain(tag)
    // The tag opens and closes the block exactly once each, plus the guard's own DO block.
    expect(sql.split(tag).length % 2).toBe(1)
  })

  it('skips dollar tags already present in the schema name', () => {
    const schema = 'web$$hook$gw1$'
    const sql = getPostgresUpgrade({ schema, component: 'delivery', from: 6 })
    const tag = doTagOf(sql)
    expect(schema).not.toContain(tag)
    expect(tag).toBe('$gw2$')
  })

  it('covers the published upgrade steps as well as the current one', () => {
    for (const from of [3, 4, 5, 6]) {
      const sql = getPostgresUpgrade({ schema: schemaWithDollars, component: 'delivery', from })
      const tag = doTagOf(sql)
      expect(schemaWithDollars).not.toContain(tag)
      expect(sql.replaceAll('%%', '')).not.toContain('%')
    }
  })

  // The initial migration has no DO block and no RAISE, so a % there is part of a quoted
  // identifier and must stay as it is - escaping it would name a different schema.
  it('leaves the initial migration untouched', () => {
    const sql = getPostgresMigration({ schema: schemaWithPercent })
    expect(sql).toContain(`"${schemaWithPercent}"`)
    expect(sql).not.toContain('%%')
  })
})

describe('ordinary schema names are unaffected', () => {
  // The published .sql files are immutable, so the escaping above must be a no-op for names
  // without % or $$. This is what keeps the generator parity test green.
  it('keeps the $$ tag and adds no escapes', () => {
    const sql = getPostgresUpgrade({ schema: 'public', component: 'delivery', from: 6 })
    expect(doTagOf(sql)).toBe('$$')
    expect(sql).not.toContain('%%')
    expect(sql).not.toContain('$gw')
  })

  it('keeps quoted names working', () => {
    const sql = getPostgresUpgrade({ schema: 'Webhook "Shared"', component: 'delivery', from: 6 })
    expect(doTagOf(sql)).toBe('$$')
    expect(sql).toContain(`"Webhook ""Shared"""`)
  })
})
