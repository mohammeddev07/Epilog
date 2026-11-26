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
  const add = page.getByRole('button', { name: 'Mark Moon Lantern watched' })
  await expect(add).toBeVisible()
  await expect(page.getByText('Checking IGDB…')).toBeVisible()
  await add.press('Shift+Enter')
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
    await expect(page.getByRole('button', { name: 'Mark Moon Lantern Game played' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Mark Moon Lantern watched', exact: true })).toBeVisible()
  } finally {
    releaseObsolete.resolve()
  }
  await expect(page.getByRole('link', { name: /Obsolete result/ })).toHaveCount(0)
})

test('shows all Discover categories and preserves saved identities across them', async ({ page }) => {
  const requested: string[] = []
  await page.route('**/api/catalog/popular/*', async (route) => {
    const suffix = new URL(route.request().url()).pathname.split('/').at(-1)!
    requested.push(suffix)
    if (suffix === 'games') {
      await route.fulfill({ status: 503, json: { error: 'provider_unavailable' } })
      return
    }
    await route.fulfill({ json: { items: suffix === 'tv' ? [] : [moon] } })
  })
  await page.route('**/api/catalog/detail/**', async (route) => route.fulfill({ json: { items: [moon] } }))
  await page.goto('/')
  const shelf = page.getByRole('list', { name: 'Popular This Week', exact: true })
  await expect(shelf.getByRole('link', { name: /Moon Lantern/ })).toHaveCount(1)
  const categories = page.getByRole('group', { name: 'Popular This Week categories' })
  const options = ['Movies', 'TV Shows', 'Books', 'Anime', 'Games']
  await expect(categories.getByRole('button')).toHaveText(options)
  await expect(categories.getByRole('button', { name: 'Movies' })).toHaveAttribute('aria-pressed', 'true')
  expect(requested[0]).toBe('movies') // the visible category loads first; the startup warm-up follows
  await categories.getByRole('button', { name: 'Games' }).click()
  await expect(page.getByRole('region', { name: 'Popular This Week', exact: true }).getByText('Games catalog is unavailable. Try again.')).toBeVisible()
  await categories.getByRole('button', { name: 'Anime' }).click()
  await shelf.getByRole('link', { name: /Moon Lantern/ }).click()
  await expect(page.getByRole('heading', { name: 'Moon Lantern' })).toBeVisible()
  await expect(page).toHaveURL(/category=Anime/) // the carousel opens in the Dashboard's category and has no picker of its own
  await expect(categories).toHaveCount(0)
  await page.getByRole('button', { name: 'Watchlist', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Watchlist', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('link', { name: 'Moon Lantern', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Moon Lantern' })).toBeFocused()
  await page.getByRole('button', { name: 'Watch', exact: true }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('link', { name: 'Moon Lantern', exact: true })).toBeFocused()
  await page.getByRole('link', { name: 'Back to Dashboard' }).click()
  await expect(page.getByRole('button', { name: 'Open saved entry for Moon Lantern' })).toBeVisible()
  const grid = page.getByRole('list', { name: 'Library titles' })
  for (const section of [/^Movies/, /^Anime/]) { // an anime film appears once in each
    await page.getByRole('link', { name: 'Library', exact: true }).first().click()
    await page.getByRole('navigation', { name: 'Library sections' }).getByRole('link', { name: section }).click()
    await expect(grid.getByRole('link')).toHaveCount(1)
  }
})

test('prefetches more titles past 32 and retains the swiped poster across details', async ({ page }) => {
  const movies = Array.from({ length: 36 }, (_, index) => {
    const id = String(100 + index)
    return { ...moon, id: 'tmdb:movie:' + id, identity: { ...moon.identity, id }, title: 'Weekly film ' + (index + 1), anime: false }
  })
  const requested: number[] = []
  const releaseSecondPage = Promise.withResolvers<void>()
  await page.route((url) => url.pathname === '/api/catalog/popular/movies', async (route) => {
    const batch = Number(new URL(route.request().url()).searchParams.get('page') ?? 1)
    requested.push(batch)
    if (batch === 2) await releaseSecondPage.promise
    const items = batch === 1 ? movies.slice(0, 16) : batch === 2 ? movies.slice(15, 32) : movies.slice(32)
    await route.fulfill({ json: { items, hasMore: batch < 3 } })
  })
  await page.route('**/api/catalog/detail/**', (route) => route.fulfill({ json: { items: [movies[32]] } }))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/popular?category=Movies')
  const carousel = page.getByRole('region', { name: 'Popular titles' })
  const stage = carousel.getByRole('group', { name: /Poster/ })
  await expect(carousel.getByRole('heading', { name: 'Weekly film 1', exact: true })).toBeVisible()
  await expect(carousel.getByRole('button', { name: /Next|Previous/ })).toHaveCount(0)
  await stage.focus()
  try {
    for (let index = 1; index < 17; index++) await page.keyboard.press('ArrowRight')
    await expect(carousel.getByRole('heading', { name: 'Weekly film 16' })).toBeVisible()
    await expect(carousel.getByText('Loading more titles…')).toBeVisible()
  } finally {
    releaseSecondPage.resolve()
  }
  await expect(carousel.getByRole('heading', { name: 'Weekly film 17' })).toBeVisible()
  for (let index = 17; index < 33; index++) {
    await page.keyboard.press('ArrowRight')
    await expect(carousel.getByRole('heading', { name: 'Weekly film ' + (index + 1), exact: true })).toBeVisible()
  }
  expect(requested).toEqual([1, 2, 3])
  await page.getByRole('link', { name: 'Weekly film 33', exact: true }).click()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(carousel.getByRole('link', { name: 'Weekly film 33', exact: true })).toBeFocused()
})

test('completing a series from Popular checks episodes in every season as details load', async ({ page }) => {
  const series = {
    id: 'tmdb:tv:72', identity: { provider: 'tmdb', entity: 'tv', id: '72' },
    format: 'SERIES', anime: false, title: 'North Star', description: '', genres: [], catalogedAt: Date.now(),
  }
  await page.route('**/api/catalog/popular/tv', (route) => route.fulfill({ json: { items: [series] } }))
  await page.route('**/api/catalog/detail/**', (route) => route.fulfill({
    json: { items: [{ ...series, seasons: [{ number: 1, episodeCount: 1 }, { number: 2, episodeCount: 2 }] }] },
  }))
  await page.route('**/api/catalog/season/**', (route) => route.fulfill({
    json: { episodes: route.request().url().endsWith('/1')
      ? [{ season: 1, number: 1, title: 'First light', airDate: '2025-05-02' }]
      : [{ season: 2, number: 1, title: 'Second light', airDate: '2026-11-12' },
        { season: 2, number: 2, title: 'Upcoming finale', airDate: '2026-12-01' }] },
  }))
  await page.clock.setFixedTime(new Date('2026-11-18T12:00:00'))
  await page.goto('/popular?category=TV+Shows')
  await page.getByRole('button', { name: 'Watch', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Watched', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toBeHidden()
  await page.getByRole('link', { name: 'North Star', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Watched First light' })).toBeChecked()
  await expect(page.getByText(/Next up ·/)).toHaveCount(0)
  const season = page.getByRole('combobox', { name: 'Season' })
  await season.selectOption('2')
  const secondLight = page.getByRole('checkbox', { name: 'Watched Second light' })
  await expect(secondLight).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Watched Upcoming finale' })).not.toBeChecked()
  await secondLight.click()
  await expect(secondLight).not.toBeChecked()
  await page.reload()
  await expect(page.getByRole('checkbox', { name: 'Watched First light' })).toBeChecked()
  await season.selectOption('2')
  await expect(secondLight).not.toBeChecked()
  await expect(page.locator('.history-list time')).toHaveAttribute('datetime', '2026-11-18')
})

test('browses the new Dashboard shelves by category, decade and year', async ({ page }) => {
  const requested = new Set<string>()
  const releases = [
    { ...moon, title: 'Decade premiere', year: 2010 },
    { ...moon, id: 'tmdb:movie:43', identity: { ...moon.identity, id: '43' }, title: 'Late decade premiere', year: 2019 },
  ]
  await page.route((url) => url.pathname.startsWith('/api/catalog/popular/'), (route) => route.fulfill({ json: { items: [moon] } }))
  await page.route((url) => url.pathname.startsWith('/api/catalog/discover/'), (route) => {
    const url = new URL(route.request().url())
    const year = url.searchParams.get('year')
    const decade = url.searchParams.get('decade')
    requested.add(url.pathname + url.search)
    const items = url.pathname.endsWith('/games') ? [game]
      : url.pathname.includes('/release/') ? (decade === '2010' ? releases.filter((item) => !year || String(item.year) === year) : [])
        : [{ ...moon, title: url.pathname.includes('/rated/') ? 'Top rated movie' : 'Upcoming movie' }]
    return route.fulfill({ json: { items, hasMore: false } })
  })
  await page.goto('/')
  for (const heading of ['Popular This Week', 'Highest Rated', 'Most Anticipated', 'Release Date']) {
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  }
  const rated = page.getByRole('region', { name: 'Highest Rated', exact: true })
  await rated.scrollIntoViewIfNeeded()
  await expect(rated.getByRole('link', { name: /Top rated movie/ })).toBeVisible()
  const anticipated = page.getByRole('region', { name: 'Most Anticipated', exact: true })
  await anticipated.scrollIntoViewIfNeeded()
  await expect(anticipated.getByRole('link', { name: /Upcoming movie/ })).toBeVisible()

  const filter = page.getByRole('group', { name: 'Release date filters' })
  const decade = filter.getByRole('combobox', { name: 'Decade' })
  const year = filter.getByRole('combobox', { name: 'Year' })
  await expect(decade.locator('option')).toHaveText(['2020s', '2010s', '2000s', '1990s', '1980s', '1970s'])
  await expect(year.locator('option')).toHaveText(['Any year', ...Array.from({ length: 10 }, (_, index) => String(2020 + index))])
  await decade.selectOption('2010')
  const release = page.getByRole('list', { name: 'Release Date', exact: true })
  await expect(year).toHaveValue('')
  await expect(release.getByRole('link')).toHaveCount(2)
  await year.selectOption('2019')
  await expect(release.getByRole('link')).toHaveCount(1)
  await release.getByRole('link', { name: /Late decade premiere/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Release Date' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Late decade premiere' })).toBeVisible()
  expect(requested.has('/api/catalog/discover/release/movies?decade=2010')).toBe(true)
  expect(requested.has('/api/catalog/discover/release/movies?decade=2010&year=2019')).toBe(true)

  // The carousel has no switchers of its own: category and collection are chosen on the Dashboard.
  await expect(page.getByRole('group', { name: /categories|Browse collections|Release date filters/ })).toHaveCount(0)
  await page.getByRole('link', { name: 'Back to Dashboard' }).click()
  await page.getByRole('group', { name: 'Popular This Week categories' }).getByRole('button', { name: 'Games' }).click()
  await page.getByRole('link', { name: 'Browse Most Anticipated' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Most Anticipated' })).toBeAttached()
  await expect(page.getByRole('heading', { name: game.title })).toBeVisible()
  expect(requested.has('/api/catalog/discover/anticipated/games')).toBe(true)
})
