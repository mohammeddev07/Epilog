import { expect, test } from '@playwright/test'

const localApp = 'http://127.0.0.1:4178'

const moon = {
  id: 'tmdb:movie:42',
  identity: { provider: 'tmdb', entity: 'movie', id: '42' },
  format: 'MOVIE',
  anime: true,
  title: 'Moon Lantern',
  description: 'Test film',
  genres: ['Animation'],
  year: 2025,
  catalogedAt: Date.now(),
}

const game = {
  id: 'igdb:game:55',
  identity: { provider: 'igdb', entity: 'game', id: '55' },
  format: 'GAME',
  title: 'Moon Lantern Game',
  description: 'Test game',
  genres: [],
  year: 2026,
  catalogedAt: Date.now(),
}

test.use({ baseURL: localApp })

test('keeps an early provider result usable while the other provider returns a 429', async ({ page }) => {
  const released = Promise.withResolvers<void>()
  await page.route('**/api/catalog/search/tmdb', async (route) => {
    expect(route.request().url()).not.toContain('?')
    expect(route.request().postDataJSON()).toEqual({ query: 'Moon Lantern' })
    await route.fulfill({ json: { items: [moon] } })
  })
  await page.route('**/api/catalog/search/igdb', async (route) => {
    await released.promise
    await route.fulfill({ status: 429, headers: { 'Retry-After': '12' }, json: { error: 'rate_limited' } })
  })
  await page.goto('/search')
  await page.getByRole('searchbox').fill('Moon Lantern')
  const add = page.getByRole('button', { name: 'Log Moon Lantern' })
  await expect(add).toBeVisible()
  await expect(page.getByText('Checking IGDB…')).toBeVisible()
  await add.click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save to library' }).click()
  const saved = page.getByRole('button', { name: 'Open saved entry for Moon Lantern' })
  await expect(saved).toBeFocused()
  released.resolve()
  await expect(page.getByText('IGDB is busy. Try again in about 12 seconds.')).toBeVisible()
  await expect(saved).toBeVisible()
})

test('ignores superseded searches and keeps a distinct game in the unified results', async ({ page }) => {
  const obsolete = Promise.withResolvers<void>()
  const releaseObsolete = Promise.withResolvers<void>()
  const ancient = { ...moon, title: 'Obsolete result' }
  await page.route('**/api/catalog/search/tmdb', async (route) => {
    if (route.request().postDataJSON().query === 'Obsolete') {
      obsolete.resolve()
      await releaseObsolete.promise
      await route.fulfill({ json: { items: [ancient] } }).catch(() => undefined)
    } else {
      await route.fulfill({ json: { items: [moon] } })
    }
  })
  await page.route('**/api/catalog/search/igdb', async (route) => {
    await route.fulfill({ json: { items: route.request().postDataJSON().query === 'Obsolete' ? [] : [game] } })
  })
  await page.goto('/search')
  const field = page.getByRole('searchbox')
  await field.fill('Obsolete')
  try {
    await obsolete.promise
    await field.fill('Moon')
    await expect(page.getByRole('button', { name: 'Log Moon Lantern Game' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Log Moon Lantern', exact: true })).toBeVisible()
  } finally {
    releaseObsolete.resolve()
  }
  await expect(page.getByRole('link', { name: /Obsolete result/ })).toHaveCount(0)
})

test('deduplicates cross-listed Discover titles, preserves saved identities, and labels an unavailable category', async ({ page }) => {
  await page.route('**/api/catalog/popular/*', async (route) => {
    const suffix = route.request().url().split('/').at(-1)
    if (suffix === 'games') {
      await route.fulfill({ status: 503, json: { error: 'provider_unavailable' } })
      return
    }
    await route.fulfill({ json: { items: suffix === 'tv' ? [] : [moon] } })
  })
  await page.route('**/api/catalog/detail/**', async (route) => route.fulfill({ json: { items: [moon] } }))
  await page.goto('/')
  const shelf = page.getByRole('list', { name: 'Popular now', exact: true })
  await expect(shelf.getByRole('link', { name: /Moon Lantern/ })).toHaveCount(1)
  await expect(page.getByText('Games catalog is unavailable. Try again.')).toBeVisible()
  await shelf.getByRole('link', { name: /Moon Lantern/ }).click()
  await expect(page.getByRole('heading', { name: 'Moon Lantern' })).toBeVisible()
  await page.getByRole('button', { name: 'Log this title' }).click()
  await page.getByRole('button', { name: 'Save to library' }).click()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('button', { name: 'Open saved entry for Moon Lantern' })).toBeVisible()
  await page.getByRole('link', { name: 'Library', exact: true }).click()
  const grid = page.getByRole('list', { name: 'Library titles' })
  await expect(grid.getByRole('link')).toHaveCount(1)
  await page.getByRole('button', { name: 'Movies', exact: true }).click()
  await expect(grid.getByRole('link')).toHaveCount(1)
  await page.getByRole('button', { name: 'Anime', exact: true }).click()
  await expect(grid.getByRole('link')).toHaveCount(1)
})
