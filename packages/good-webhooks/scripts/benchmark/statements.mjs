// Claim-path timings from pg_stat_statements, shared by the history benchmark and the chaos
// contention mode. Server-side execution time only: no network, pool wait, or client time.

export const missingExtension =
  'pg_stat_statements is missing. Start PostgreSQL with `-c shared_preload_libraries=pg_stat_statements` ' +
  '(for example as docker run arguments) and run `CREATE EXTENSION pg_stat_statements` in this database.'

/**
 * Statements picked by text. pg_stat_statements keeps identifiers but replaces constants with $n,
 * so 'in_flight', true and 100 appear as parameters.
 */
const statements = {
  endpointPick: (query) =>
    query.includes('JOIN LATERAL') && query.includes('FOR NO KEY UPDATE OF s SKIP LOCKED'),
  deliveryPick: (query) => query.includes('FOR UPDATE OF d SKIP LOCKED'),
  // Other updates also set status and preparing; only reserve() assigns a new claim token.
  reserve: (query) =>
    /SET status=(\$\d+|'in_flight'),preparing=(\$\d+|true)/.test(query) &&
    query.includes('claim_token=input.token'),
  expiredScan: (query) =>
    query.includes('lease_expires_at <= now()') &&
    query.includes('FOR NO KEY UPDATE OF s SKIP LOCKED'),
  pruneCandidates: (query) => /ORDER BY e\.created_at,e\.id LIMIT (\$\d+|100)/.test(query),
}

export async function hasStatementStats(pool) {
  const result = await pool.query(`SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements'`)
  return result.rows.length > 0
}

export async function resetStatementStats(pool) {
  await pool.query('SELECT pg_stat_statements_reset()')
}

/** Read { calls, meanMs, stddevMs, maxMs } per statement for this schema; fail when a required one is absent. */
export async function statementStats(pool, schema, { names, required }) {
  const result = await pool.query(
    `SELECT calls::float8 AS calls, mean_exec_time, stddev_exec_time, max_exec_time, query
     FROM pg_stat_statements
     WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query LIKE $1`,
    [`%"${schema}"%`],
  )
  const stats = {}
  for (const name of names) {
    // One query text can have several rows (for example per user); combine them.
    const rows = result.rows.filter((row) => statements[name](row.query))
    const calls = rows.reduce((sum, row) => sum + row.calls, 0)
    if (!calls) {
      if (required.includes(name)) throw new Error(`pg_stat_statements has no ${name} statement.`)
      stats[name] = null
      continue
    }
    // Pooled mean and standard deviation over the rows (usually one).
    const mean = rows.reduce((sum, row) => sum + row.calls * row.mean_exec_time, 0) / calls
    const variance =
      rows.reduce(
        (sum, row) =>
          sum + row.calls * (row.stddev_exec_time ** 2 + (row.mean_exec_time - mean) ** 2),
        0,
      ) / calls
    stats[name] = {
      calls,
      meanMs: +mean.toFixed(2),
      stddevMs: +Math.sqrt(variance).toFixed(2),
      maxMs: +Math.max(...rows.map((row) => row.max_exec_time)).toFixed(2),
    }
  }
  return stats
}
