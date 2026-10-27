// Collects a weekly growth snapshot and prints it as one JSON line.
// Usage: GITHUB_TOKEN=... node scripts/growth-snapshot.mjs

const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error('GITHUB_TOKEN is required. Set it to a token with push access to the repo.')
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
const browserHeaders = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Accept: 'text/html',
}

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
function utcDate(offsetDays) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

// The npm last-week alias returns a stale window, so ask for an explicit range.
async function npmStats() {
  const end = utcDate(-1)
  const start = utcDate(-7)
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

// Turns HTML into plain text with single spaces.
function htmlToText(html) {
  const entities = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_, name) => entities[name])
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
}

// GitHub has no API for "Used by" counts, so read the dependents page.
async function dependents() {
  const result = { source: 'github-dependents-page', repositories: null, packages: null }
  try {
    const url = `https://github.com/${repo}/network/dependents`
    const text = htmlToText(await (await request(url, browserHeaders)).text())
    const parse = (pattern) => {
      const match = text.match(pattern)
      return match ? Number(match[1].replace(/,/g, '')) : null
    }
    result.repositories = parse(/(\d[\d,]*)\s+Repositor(?:y|ies)\b/)
    result.packages = parse(/(\d[\d,]*)\s+Packages?\b/)
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
