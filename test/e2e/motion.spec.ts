import { expect, test } from '@playwright/test'

test('an interrupted hold leaves the title unwatched and the next tap works', async ({ page }) => {
  await page.goto('/popular')
  const watch = page.getByRole('button', { name: 'Watch', exact: true })
  await watch.scrollIntoViewIfNeeded()
  const bounds = (await watch.boundingBox())!
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await expect(watch.locator('.hold-ring')).toBeAttached()
  await page.mouse.move(x + 16, y)
  await expect(watch.locator('.hold-ring')).toHaveCount(0)
  await page.mouse.up()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(watch).toBeVisible()
  await watch.dblclick()
  await expect(page.getByRole('button', { name: 'Watched', exact: true })).toBeFocused()
  await page.getByRole('link', { name: 'The Last Signal', exact: true }).click()
  await expect(page.locator('.history-list time')).toHaveCount(1)
})

test('an aborted Watchlist transaction keeps the poster, focus and previous state', async ({ page }) => {
  await page.goto('/popular')
  const watchlist = page.getByRole('button', { name: 'Watchlist', exact: true })
  await watchlist.focus()
  const stage = page.locator('.popular-stage')
  const bounds = await stage.boundingBox()
  const scrollY = await page.evaluate(() => window.scrollY)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'entries') {
        IDBObjectStore.prototype.put = put
        this.transaction.abort()
      }
      return put.apply(this, args)
    }
  })
  await watchlist.press('Space')
  await expect(page.getByRole('alert')).toContainText('Press Watchlist to retry')
  await expect(watchlist).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.save-announcement')).toBeEmpty()
  await expect(watchlist).toBeFocused()
  await watchlist.press('Enter')
  await expect(watchlist).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('alert')).toBeHidden()
  await watchlist.press('Enter')
  await expect(watchlist).toHaveAttribute('aria-pressed', 'false')
  await expect(watchlist).toBeFocused()
  expect(await stage.boundingBox()).toEqual(bounds)
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY)
})

test('stored appearance is applied with the application bundle blocked', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('epilog:appearance:v1', 'dark'))
  await page.route('**/src/main.tsx*', (route) => route.abort())
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/settings')
  expect(await page.locator('#root').innerHTML()).toBe('')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark')
})

for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  test(`returns to the selected poster by keyboard with ${reducedMotion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion })
    await page.goto('/popular')
    const poster = page.getByRole('group', { name: /^Poster\./ })
    await poster.press('ArrowRight')
    await expect(page.getByRole('heading', { name: 'Paper Moons' })).toBeVisible()
    await page.locator('.popular-cover[data-slot="0"] .poster-art img').evaluate((img) => (img as HTMLImageElement).decode())
    // Record even a short flight that finishes between Playwright assertions.
    await page.evaluate(() => {
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node instanceof Element && node.matches('.poster-flight')) {
              document.body.dataset.flights = String(Number(document.body.dataset.flights ?? 0) + 1)
            }
          }
        }
      })
      observer.observe(document.body, { subtree: true, childList: true })
    })
    await poster.press('Enter')
    await expect(page.getByRole('heading', { level: 1, name: 'Paper Moons' })).toBeFocused()
    await page.goBack()
    await expect(poster).toBeFocused()
    await expect(page.getByRole('heading', { name: 'Paper Moons' })).toBeVisible()
    if (reducedMotion === 'reduce') await expect(page.locator('body')).not.toHaveAttribute('data-flights')
    else await expect(page.locator('body')).toHaveAttribute('data-flights', '2')
    await expect(page.locator('[data-landing], .poster-flight')).toHaveCount(0)
  })
}
