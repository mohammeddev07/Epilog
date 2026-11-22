import { describe, expect, it, vi } from 'vitest'
import { createCatalogWorker } from './index'
import type { Env } from './index'

const env: Env = {
  TMDB_READ_ACCESS_TOKEN: 'fixture-tmdb-token',
  IGDB_CLIENT_ID: 'fixture-client',
  IGDB_CLIENT_SECRET: 'fixture-secret',
}

const origin = 'https://epilog.test'

function search(provider: string, query: string, options?: RequestInit) {
  return new Request(`${origin}/api/catalog/search/${provider}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    ...options,
  })
}

it('serves only the configured privacy address without requiring sign-in', async () => {
  const worker = createCatalogWorker()
  const url = `${origin}/api/privacy-contact`
  const contact = { ...env, PRIVACY_CONTACT_EMAIL: ' privacy@example.test ' }
  const response = await worker.fetch(new Request(url), contact)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(await response.json()).toEqual({ email: 'privacy@example.test' })
  expect(await (await worker.fetch(new Request(url), env)).json()).toEqual({ email: null })
  expect(await (await worker.fetch(new Request(url), { PRIVACY_CONTACT_EMAIL: 'invalid' })).json()).toEqual({ email: null })
  expect((await worker.fetch(new Request(url, { method: 'POST' }), contact)).status).toBe(405)
  expect(await (await worker.fetch(new Request(`${origin}/api/config`), contact)).json()).toEqual({ googleClientId: '' })
})

describe('catalog Worker', () => {
  it('searches and browses Open Library books by type, and rejects unknown types', async () => {
    const urls: URL[] = []
    const upstream = vi.fn<typeof fetch>(async (input) => {
      urls.push(new URL(String(input)))
      return Response.json({ numFound: 2, docs: [
        { key: '/works/OL1W', title: 'Tower Diaries', subject: ['Manhwa', 'Fantasy'], cover_i: 9, author_name: ['Kim'] },
        { key: '/works/OL2W', title: 'Plain Novel', subject: ['Fiction'] },
      ] })
    })
    const worker = createCatalogWorker(upstream)
    const found = await worker.fetch(new Request(`${origin}/api/catalog/search/openlibrary?type=Manhwa`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'Tower' }),
    }), env)
    expect(await found.json()).toEqual({ hasMore: false, items: [expect.objectContaining({
      id: 'openlibrary:work:OL1W', format: 'BOOK', bookType: 'Manhwa', poster: 'https://covers.openlibrary.org/b/id/9-L.jpg?default=false',
    })] })
    expect(urls[0].searchParams.get('q')).toBe('subject:(manhwa) AND title:("Tower")')
    const shelf = await (await worker.fetch(new Request(`${origin}/api/catalog/popular/books`), env)).json()
    expect(shelf.items.map((item: { bookType: string }) => item.bookType)).toEqual(['Manhwa', 'Novel'])
    expect(urls[1].searchParams.get('sort')).toBe('trending')
    expect(urls[1].searchParams.get('q')).toMatch(/^subject:\(.+\) AND cover_i:\[1 TO \*\]$/)
    expect((await worker.fetch(new Request(`${origin}/api/catalog/popular/books?type=Comics`), env)).status).toBe(400)
    expect(upstream).toHaveBeenCalledTimes(2)

    // Nonfiction is tagged by topic, so a title search isn't narrowed by subject.
    upstream.mockImplementationOnce(async (input) => {
      urls.push(new URL(String(input)))
      return Response.json({ numFound: 1, docs: [{ key: '/works/OL3W', title: 'Atomic Habits', subject: ['Habit', 'Self-help'] }] })
    })
    const habits = await worker.fetch(new Request(`${origin}/api/catalog/search/openlibrary`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'Atomic Habits' }),
    }), env)
    expect(urls[2].searchParams.get('q')).toBe('title:("Atomic" AND "Habits")')
    expect(await habits.json()).toMatchObject({ items: [{ title: 'Atomic Habits', bookType: 'Nonfiction' }] })

    // Every Dashboard shelf works for books, narrowed by type.
    for (const path of ['discover/rated/books?type=Manga', 'discover/anticipated/books', 'discover/release/books?decade=1990&year=1997']) {
      expect((await worker.fetch(new Request(`${origin}/api/catalog/${path}`), env)).status).toBe(200)
    }
    const [rated, anticipated, release] = urls.slice(3)
    expect([rated, anticipated, release].map((url) => url.searchParams.get('sort'))).toEqual(['rating', 'want_to_read', 'readinglog'])
    expect(rated.searchParams.get('q')).toBe('subject:(manga) AND cover_i:[1 TO *] AND ratings_count:[10 TO *]')
    expect(anticipated.searchParams.get('q')).toContain(`first_publish_year:[${new Date().getUTCFullYear()} TO *]`)
    expect(release.searchParams.get('q')).toContain('first_publish_year:[1997 TO 1997]')
  })

  it('rejects malformed, cross-site, and over-budget requests before contacting providers', async () => {
    const upstream = vi.fn<typeof fetch>()
    const worker = createCatalogWorker(upstream)
    expect((await worker.fetch(search('tmdb', 'x'.repeat(1001)), env)).status).toBe(400)
    expect((await worker.fetch(search('tmdb', 'Hello', { headers: { Origin: 'https://unrelated.test' } }), env)).status).toBe(403)
    const blocked = { ...env, CATALOG_RATE_LIMITER: { limit: async () => ({ success: false }) } }
    const response = await worker.fetch(search('tmdb', 'Hello'), blocked)
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(upstream).not.toHaveBeenCalled()
  })

  it('normalizes watch results, keeps film and TV identities distinct, and holds credentials in headers', async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('query')).toBe('Moon "Light"')
      expect(url.searchParams.get('api_key')).toBeNull()
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-tmdb-token')
      const fields = { id: 12, original_language: 'ja', genre_ids: [16], poster_path: null }
      return Response.json({ results: url.pathname.endsWith('/movie')
        ? [{ ...fields, title: 'Moon Light', release_date: '2025-01-01' }]
        : [{ ...fields, name: 'Moon Light', first_air_date: '2026-01-01' }] })
    })
    const response = await createCatalogWorker(upstream).fetch(search('tmdb', ' Moon  "Light" '), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ items: [
      { id: 'tmdb:movie:12', anime: true, format: 'MOVIE', year: 2025 },
      { id: 'tmdb:tv:12', anime: true, format: 'SERIES', year: 2026 },
    ] })
  })

  it('keeps a partial watch result and honors upstream throttling on subsequent calls', async () => {
    const upstream = vi.fn<typeof fetch>(async (input) => String(input).includes('/search/tv')
      ? new Response('', { status: 429, headers: { 'Retry-After': '19' } })
      : Response.json({ results: [{ id: 17, title: 'A film' }] }))
    const worker = createCatalogWorker(upstream)
    expect(await (await worker.fetch(search('tmdb', 'A film'), env)).json()).toMatchObject({ partial: true, items: [{ id: 'tmdb:movie:17' }] })
    const blocked = await worker.fetch(search('tmdb', 'Second'), env)
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('Retry-After')).toBe('19')
    expect(upstream).toHaveBeenCalledTimes(2)
  })

  it('exchanges the Twitch secret in the request body and keeps distinct matching game releases', async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (url.hostname === 'id.twitch.tv') {
        expect(url.search).toBe('')
        expect((init?.body as URLSearchParams).get('client_secret')).toBe('fixture-secret')
        return Response.json({ access_token: 'fixture-app-token', expires_in: 600 })
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-app-token')
      const dialect = String(init?.body)
      expect(dialect).toMatch(/^search "Prey\s+subtitle"; fields /)
      return Response.json([
        { id: 77, name: 'Prey', first_release_date: Date.UTC(2017, 0, 1) / 1000 },
        { id: 88, name: 'Prey', first_release_date: Date.UTC(2006, 0, 1) / 1000 },
      ])
    })
    const response = await createCatalogWorker(upstream).fetch(search('igdb', 'Prey"; subtitle'), env)
    expect(await response.json()).toMatchObject({
      items: [{ id: 'igdb:game:77', year: 2017 }, { id: 'igdb:game:88', year: 2006 }],
    })
  })

  it('returns unambiguous specials and omits totals while a series is airing', async () => {
    const upstream = vi.fn<typeof fetch>(async (input) => String(input).includes('/season/')
      ? Response.json({ episodes: [
        { id: 99, name: 'Mini episode', season_number: 0, episode_number: 1, air_date: '2026-10-05' },
        { id: 100, season_number: 0, episode_number: 2 },
        { id: 101, season_number: 0, episode_number: 2 },
        { id: 102, season_number: 2, episode_number: 1 },
      ] })
      : Response.json({ id: 15, name: 'A series', status: 'Returning Series', number_of_episodes: 10, seasons: [{ season_number: 0, episode_count: 2 }] }))
    const worker = createCatalogWorker(upstream)
    const detail = await worker.fetch(new Request(`${origin}/api/catalog/detail/tmdb%3Atv%3A15`), env)
    const body = await detail.json()
    expect(body).toMatchObject({ items: [{ id: 'tmdb:tv:15', seasons: [{ number: 0, episodeCount: 2 }] }] })
    expect(body.items[0]).not.toHaveProperty('episodeTotal')
    const season = await worker.fetch(new Request(`${origin}/api/catalog/season/tmdb%3Atv%3A15/0`), env)
    expect(await season.json()).toEqual({ episodes: [{ season: 0, number: 1, title: 'Mini episode', externalId: '99', airDate: '2026-10-05' }] })
  })

  it('maps runtime, countries and original language from details and rejects malformed values', async () => {
    const upstream = vi.fn<typeof fetch>(async (input) => String(input).includes('/movie/')
      ? Response.json({ id: 7, title: 'A film', runtime: 128, original_language: 'fr', production_countries: [{ iso_3166_1: 'FR' }, { iso_3166_1: 'bad' }] })
      : Response.json({ id: 8, name: 'A show', episode_run_time: [], last_episode_to_air: { runtime: 44 }, origin_country: ['KR'], original_language: 'Korean!' }))
    const worker = createCatalogWorker(upstream)
    const film = await (await worker.fetch(new Request(`${origin}/api/catalog/detail/tmdb%3Amovie%3A7`), env)).json()
    expect(film.items[0]).toMatchObject({ runtime: 128, countries: ['FR'], language: 'fr' })
    const show = await (await worker.fetch(new Request(`${origin}/api/catalog/detail/tmdb%3Atv%3A8`), env)).json()
    expect(show.items[0]).toMatchObject({ runtime: 44, countries: ['KR'] })
    expect(show.items[0]).not.toHaveProperty('language')
  })

  it('keeps the provider’s game popularity ordering and caches the public shelf', async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes('/oauth2/')) return Response.json({ access_token: 'fixture-app-token', expires_in: 600 })
      if (url.endsWith('/popularity_primitives')) {
        const query = String(init?.body)
        if (query.includes('offset 32;')) return Response.json([])
        expect(query).toContain('limit 32; offset 0;')
        return Response.json(Array.from({ length: 32 }, (_, index) => ({ game_id: index % 2 === 0 ? 22 : 11 })))
      }
      return Response.json([{ id: 11, name: 'Second' }, { id: 22, name: 'First' }])
    })
    const worker = createCatalogWorker(upstream)
    const request = new Request(`${origin}/api/catalog/popular/games`)
    const initial = await (await worker.fetch(request, env)).json()
    expect(initial).toMatchObject({ items: [{ title: 'First' }, { title: 'Second' }], hasMore: true })
    expect(await (await worker.fetch(request, env)).json()).toEqual(initial)
    const next = await worker.fetch(new Request(request.url + '?page=2'), env)
    expect(await next.json()).toEqual({ items: [], hasMore: false })
    expect(upstream).toHaveBeenCalledTimes(4)
  })

  it('paginates weekly TV trends, excludes anime and rejects invalid pages', async () => {
    const upstream = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/3/trending/tv/week')
      const page = Number(url.searchParams.get('page'))
      return Response.json({ total_pages: 2, results: [
        { id: 10, name: 'Anime', original_language: 'ja', genre_ids: [16] },
        { id: 20 + page, name: 'Weekly show ' + page },
      ] })
    })
    const worker = createCatalogWorker(upstream)
    const url = `${origin}/api/catalog/popular/tv`
    const first = await worker.fetch(new Request(url), env)
    expect(await first.json()).toMatchObject({ items: [{ title: 'Weekly show 1' }], hasMore: true })
    const second = await worker.fetch(new Request(url + '?page=2'), env)
    expect(await second.json()).toMatchObject({ items: [{ title: 'Weekly show 2' }], hasMore: false })
    for (const query of ['page=0', 'page=501', 'page=2&page=1', 'page=1&unknown=true']) {
      expect((await worker.fetch(new Request(url + '?' + query), env)).status).toBe(400)
    }
    expect(upstream).toHaveBeenCalledTimes(2)
  })
})

describe('catalog browsing', () => {
  it('uses whole decades and single years for movies and TV and rejects mismatched periods', async () => {
    const upstream = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/movie')) {
        expect(url.searchParams.get('primary_release_date.gte')).toBe('2010-01-01')
        expect(url.searchParams.get('primary_release_date.lte')).toBe('2019-12-31')
        expect(url.searchParams.get('sort_by')).toBe('primary_release_date.desc')
        return Response.json({ total_pages: 1, results: [{ id: 42, title: '2012 film', release_date: '2012-07-01' }] })
      }
      expect(url.searchParams.get('first_air_date.gte')).toBe('1984-01-01')
      expect(url.searchParams.get('first_air_date.lte')).toBe('1984-12-31')
      expect(url.searchParams.get('sort_by')).toBe('first_air_date.desc')
      return Response.json({ total_pages: 3, results: [{ id: 43, name: '1984 show', first_air_date: '1984-05-10' }] })
    })
    const worker = createCatalogWorker(upstream)
    const browse = (suffix: string) => worker.fetch(new Request(origin + '/api/catalog/discover/' + suffix), env)
    const movies = await browse('release/movies?decade=2010')
    expect(await movies.json()).toMatchObject({ items: [{ title: '2012 film', year: 2012 }], hasMore: false })
    const tv = await browse('release/tv?decade=1980&year=1984&page=2')
    expect(await tv.json()).toMatchObject({ items: [{ title: '1984 show', year: 1984 }], hasMore: true })
    for (const path of ['release/movies?decade=1980&year=1990', 'release/movies?decade=2010&year=2012&year=2011', 'rated/movies?year=2012']) {
      expect((await browse(path)).status).toBe(400)
    }
    expect(upstream).toHaveBeenCalledTimes(2)
  })

  it('ranks both anime formats and uses popularity for upcoming TMDB titles', async () => {
    const upstream = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      const movie = url.pathname.endsWith('/movie')
      const sort = url.searchParams.get('sort_by')
      if (sort === 'popularity.desc') {
        expect(url.searchParams.get('primary_release_date.gte')).toBe(new Date().toISOString().slice(0, 10))
        return Response.json({ total_pages: 1, results: [{ id: 10, title: 'Upcoming film' }] })
      }
      expect(sort).toBe('vote_average.desc')
      expect(Number(url.searchParams.get('vote_count.gte'))).toBeGreaterThan(0)
      expect(url.searchParams.get('with_original_language')).toBe('ja')
      expect(url.searchParams.get('with_genres')).toBe('16')
      const japanese = { original_language: 'ja', genre_ids: [16] }
      return Response.json({ total_pages: 1, results: movie
        ? [{ ...japanese, id: 1, title: 'Anime film', vote_average: 8.2 }]
        : [{ ...japanese, id: 2, name: 'Anime series', vote_average: 9 }] })
    })
    const worker = createCatalogWorker(upstream)
    const rated = await worker.fetch(new Request(origin + '/api/catalog/discover/rated/anime'), env)
    expect(await rated.json()).toMatchObject({ items: [{ title: 'Anime series' }, { title: 'Anime film' }] })
    const anticipated = await worker.fetch(new Request(origin + '/api/catalog/discover/anticipated/movies'), env)
    expect(await anticipated.json()).toMatchObject({ items: [{ title: 'Upcoming film' }] })
  })

  it('uses IGDB scores, pre-release follows and UTC release boundaries', async () => {
    const queries: string[] = []
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/oauth2/')) return Response.json({ access_token: 'fixture-app-token', expires_in: 600 })
      expect(String(input)).toBe('https://api.igdb.com/v4/games')
      queries.push(String(init?.body))
      return Response.json([{ id: 1, name: 'A game' }])
    })
    const worker = createCatalogWorker(upstream)
    for (const path of ['rated/games', 'anticipated/games', 'release/games?decade=2000&year=2000&page=2']) {
      const response = await worker.fetch(new Request(origin + '/api/catalog/discover/' + path), env)
      expect(await response.json()).toMatchObject({ items: [{ title: 'A game' }], hasMore: false })
    }
    expect(queries[0]).toContain('sort total_rating desc;')
    expect(queries[0]).toContain('total_rating_count >=')
    expect(queries[1]).toContain('hypes > 0; sort hypes desc;')
    expect(queries[1]).toContain('first_release_date >=')
    expect(queries[2]).toContain('first_release_date >= 946684800 & first_release_date < 978307200;')
    expect(queries[2]).toContain('offset 32;')
  })
})
