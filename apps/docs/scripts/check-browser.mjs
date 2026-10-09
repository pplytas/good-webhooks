import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startServer } from './server.mjs'

const { url, stop } = await startServer()
let browser
try {
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
  await page.waitForURL((target) => target.pathname === '/docs')
  await page.getByRole('heading', { name: 'Introduction', exact: true }).waitFor()

  const markdown = await page.goto(`${url}/docs/quick-start.md`)
  assert.equal(markdown.status(), 200)
  assert.match(await markdown.text(), /^# Quick start/)
  const introduction = await page.goto(`${url}/docs.md`)
  assert.equal(introduction.status(), 200)
  assert.match(await introduction.text(), /^# Introduction/)

  const deep = await page.goto(`${url}/docs/reference/delivery`)
  assert.equal(deep.status(), 200)
  await page.getByRole('heading', { level: 1 }).waitFor()
  await page.locator('#type-table-reference-types\\.ts-DeliverySettings').waitFor()

  await page.goto(`${url}/docs`)
  await page.getByRole('button', { name: /^Search/ }).click()
  await page.getByRole('combobox', { name: 'Search', exact: true }).fill('replay')
  const result = page
    .getByRole('listbox', { name: 'Search', exact: true })
    .getByRole('option')
    .first()
  await result.waitFor()
  await result.click()
  await page.waitForURL((target) => target.pathname !== '/docs')
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
  await stop()
}
