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
        { id: 99, name: 'Mini episode', season_number: 0, episode_number: 1 },
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
    expect(await season.json()).toEqual({ episodes: [{ season: 0, number: 1, title: 'Mini episode', externalId: '99' }] })
  })

  it('keeps the provider’s game popularity ordering and caches the public shelf', async () => {
    const upstream = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes('/oauth2/')) return Response.json({ access_token: 'fixture-app-token', expires_in: 600 })
      if (url.endsWith('/popularity_primitives')) return Response.json([{ game_id: 22 }, { game_id: 11 }, { game_id: 22 }])
      return Response.json([{ id: 11, name: 'Second' }, { id: 22, name: 'First' }])
    })
    const worker = createCatalogWorker(upstream)
    const request = new Request(`${origin}/api/catalog/popular/games`)
    const initial = await (await worker.fetch(request, env)).json()
    expect(initial).toMatchObject({ items: [{ title: 'First' }, { title: 'Second' }] })
    expect(await (await worker.fetch(request, env)).json()).toEqual(initial)
    expect(upstream).toHaveBeenCalledTimes(3)
  })
})
