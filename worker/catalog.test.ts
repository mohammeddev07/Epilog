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

describe('catalog Worker', () => {
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
