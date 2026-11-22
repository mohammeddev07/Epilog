import { expect, test } from '@playwright/test'

test.use({ baseURL: 'http://127.0.0.1:4178' })

const base = { description: '', genres: [], year: 2025 }
const titles = {
  movies: { ...base, id: 'tmdb:movie:1', identity: { provider: 'tmdb', entity: 'movie', id: '1' }, format: 'MOVIE', anime: false, title: 'Warm movie' },
  tv: { ...base, id: 'tmdb:tv:2', identity: { provider: 'tmdb', entity: 'tv', id: '2' }, format: 'SERIES', anime: false, title: 'Warm show' },
  anime: { ...base, id: 'tmdb:tv:3', identity: { provider: 'tmdb', entity: 'tv', id: '3' }, format: 'SERIES', anime: true, title: 'Warm anime' },
  games: { ...base, id: 'igdb:game:4', identity: { provider: 'igdb', entity: 'game', id: '4' }, format: 'GAME', title: 'Warm game' },
  books: { ...base, id: 'openlibrary:work:OL5W', identity: { provider: 'openlibrary', entity: 'work', id: 'OL5W' }, format: 'BOOK', bookType: 'Novel', title: 'Warm book' },
}

test('warms each category and the first Dashboard shelves at startup, so they open without waiting', async ({ page }) => {
  const requested: string[] = []
  let catalogUp = true
  await page.route((url) => url.pathname.startsWith('/api/catalog/'), async (route) => {
    const url = new URL(route.request().url())
    requested.push(url.pathname.replace('/api/catalog/', '') + url.search)
    if (!catalogUp) return route.fulfill({ status: 503, json: { error: 'provider_unavailable' } })
    const section = url.pathname.split('/').at(-1) as keyof typeof titles
    return route.fulfill({ json: { items: [{ ...titles[section], catalogedAt: Date.now() }], hasMore: false } })
  })

  await page.goto('/')
  await expect(page.getByRole('list', { name: 'Popular This Week', exact: true }).getByRole('link', { name: /Warm movie/ })).toBeVisible()
  const startup = ['popular/movies', 'popular/tv', 'popular/books', 'popular/anime', 'popular/games',
    'discover/rated/movies', 'discover/anticipated/movies', 'discover/release/movies?decade=2020']
  await expect.poll(() => requested.toSorted()).toEqual(startup.toSorted()) // each fetched once, nothing twice

  // The catalog goes down, yet Books and a lower shelf open straight from the warmed cache.
  catalogUp = false
  await page.getByRole('group', { name: 'Popular This Week categories' }).getByRole('button', { name: 'Books' }).click()
  await expect(page.getByRole('list', { name: 'Popular This Week', exact: true }).getByRole('link', { name: /Warm book/ })).toBeVisible()
  await page.getByRole('group', { name: 'Popular This Week categories' }).getByRole('button', { name: 'Movies' }).click()
  const rated = page.getByRole('region', { name: 'Highest Rated', exact: true })
  await rated.scrollIntoViewIfNeeded()
  await expect(rated.getByRole('link', { name: /Warm movie/ })).toBeVisible()

  // A reload within the 20-minute freshness window serves everything from the cache.
  const before = requested.length
  await page.reload()
  await expect(page.getByRole('list', { name: 'Popular This Week', exact: true }).getByRole('link', { name: /Warm movie/ })).toBeVisible()
  await page.waitForTimeout(2000) // past the warm-up delay
  expect(requested.length).toBe(before)
})
