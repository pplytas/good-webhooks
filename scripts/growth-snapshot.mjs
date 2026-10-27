// Collects a weekly growth snapshot and prints it as one JSON line.
// Usage: GITHUB_TOKEN=... node scripts/growth-snapshot.mjs

const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error(
    'GITHUB_TOKEN is required. The traffic endpoints need push access, or a fine-grained token with Administration read on the repo.',
  )
  process.exit(1)
}
const repo = process.env.GITHUB_REPOSITORY || 'pplytas/good-webhooks'
const pkg = process.env.NPM_PACKAGE || 'good-webhooks'

const githubHeaders = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'good-webhooks-growth-snapshot',
}
const pageHeaders = { 'User-Agent': 'good-webhooks-growth-snapshot', Accept: 'text/html' }

// Fetches a URL and throws on any non-2xx response.
async function request(url, headers) {
  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`GET ${url} failed with status ${response.status}`)
  }
  return response
}

const github = async (path) =>
  (await request(`https://api.github.com/repos/${repo}${path}`, githubHeaders)).json()
const npm = async (url) => (await request(url, {})).json()

// Maps a traffic response to { count, uniques, days }.
function traffic(data, key) {
  return {
    count: data.count,
    uniques: data.uniques,
    days: data[key].map((day) => ({
      date: day.timestamp.slice(0, 10),
      count: day.count,
      uniques: day.uniques,
    })),
  }
}

// Returns a UTC date as YYYY-MM-DD, shifted by a number of days.
function utcDate(from, offsetDays) {
  const date = new Date(from)
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

// The npm last-week alias returns a stale window, so ask for an explicit range.
// npm publishes a day's count during the next day, so the window ends two days ago.
async function npmStats() {
  const now = Date.now()
  const end = utcDate(now, -2)
  const start = utcDate(now, -8)
  const [downloads, registry] = await Promise.all([
    npm(`https://api.npmjs.org/downloads/point/${start}:${end}/${pkg}`),
    npm(`https://registry.npmjs.org/${pkg}`),
  ])
  return {
    package: pkg,
    downloads_7d: downloads.downloads,
    start: downloads.start,
    end: downloads.end,
    latest_version: registry['dist-tags']?.latest ?? null,
  }
}

// GitHub has no API for "Used by" counts, so read the dependents page.
// Each count sits in the page text shortly after its dependent_type link.
async function dependents() {
  const result = { source: 'github-dependents-page', repositories: null, packages: null }
  try {
    const url = `https://github.com/${repo}/network/dependents`
    const html = await (await request(url, pageHeaders)).text()
    const count = (type, word) => {
      const match = html.match(
        new RegExp(`dependent_type=${type}[^>]*>[\\s\\S]{0,2000}?(\\d[\\d,]*)\\s+${word}\\b`),
      )
      return match ? Number(match[1].replace(/,/g, '')) : null
    }
    result.repositories = count('REPOSITORY', 'Repositor(?:y|ies)')
    result.packages = count('PACKAGE', 'Packages?')
    if (result.repositories === null || result.packages === null) {
      result.error = 'Could not parse the dependents counts from the page.'
    }
  } catch (error) {
    result.error = error.message
  }
  if (result.error) console.error(`dependents: ${result.error}`)
  return result
}

const [info, views, clones, referrers, paths, npmData, deps] = await Promise.all([
  github(''),
  github('/traffic/views'),
  github('/traffic/clones'),
  github('/traffic/popular/referrers'),
  github('/traffic/popular/paths'),
  npmStats(),
  dependents(),
])

const snapshot = {
  taken_at: new Date().toISOString(),
  repo,
  stars: info.stargazers_count,
  forks: info.forks_count,
  watchers: info.subscribers_count,
  open_issues: info.open_issues_count,
  views_14d: traffic(views, 'views'),
  clones_14d: traffic(clones, 'clones'),
  referrers_14d: referrers.map(({ referrer, count, uniques }) => ({ referrer, count, uniques })),
  paths_14d: paths.map(({ path, count, uniques }) => ({ path, count, uniques })),
  npm: npmData,
  dependents: deps,
}

process.stdout.write(`${JSON.stringify(snapshot)}\n`)
