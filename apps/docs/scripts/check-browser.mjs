import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const directory = fileURLToPath(new URL('../', import.meta.url))
const server = spawn(process.execPath, ['scripts/preview.mjs'], {
  cwd: directory,
  env: { ...process.env, PORT: '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
})
const lines = createInterface({ input: server.stdout })
let browser
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Static preview did not start.')), 10_000)
    const finish = (error, value) => {
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    server.once('error', (error) => finish(error))
    server.once('exit', (code) => finish(new Error(`Static preview exited with code ${code}.`)))
    lines.on('line', (line) => {
      const match = /^Static docs preview: (http:\/\/localhost:\d+)$/.exec(line)
      if (match) finish(null, match[1])
    })
  })

  browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: 'light',
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  const landing = await page.goto(url)
  assert.equal(landing.status(), 200)
  await page.getByRole('heading', { level: 1 }).waitFor()
  await page.getByRole('link', { name: 'Documentation', exact: true }).first().click()
  await page.waitForURL((target) => target.pathname === '/docs/')
  await page.getByRole('heading', { name: 'Introduction', exact: true }).waitFor()

  const markdown = await page.goto(`${url}/llms.mdx/quick-start.md`)
  assert.equal(markdown.status(), 200)
  assert.match(await markdown.text(), /^# Quick start/)

  const deep = await page.goto(`${url}/docs/reference/delivery/`)
  assert.equal(deep.status(), 200)
  await page.getByRole('heading', { level: 1 }).waitFor()
  await page.locator('#type-table-reference-types\\.ts-DeliverySettings').waitFor()

  await page.goto(`${url}/docs/`)
  await page.getByRole('button', { name: /^Search/ }).click()
  await page.getByRole('combobox', { name: 'Search', exact: true }).fill('replay')
  const result = page
    .getByRole('listbox', { name: 'Search', exact: true })
    .getByRole('option')
    .first()
  await result.waitFor()
  await result.click()
  await page.waitForURL((target) => target.pathname !== '/docs/')
  await page.getByRole('heading', { level: 1 }).waitFor()

  await page.getByRole('button', { name: 'Toggle Theme', exact: true }).click()
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Open Sidebar', exact: true }).click()
  await page
    .locator('#nd-sidebar-mobile')
    .getByRole('button', { name: 'Close Sidebar', exact: true })
    .waitFor()
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  )

  assert.deepEqual(errors, [], 'Browser page errors occurred.')
  console.log(
    'Verified landing, docs routes, markdown export, generated table, search, theme switch, and mobile sidebar.',
  )
} finally {
  await browser?.close()
  lines.close()
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit')
    server.kill('SIGTERM')
    await exited
  }
}
