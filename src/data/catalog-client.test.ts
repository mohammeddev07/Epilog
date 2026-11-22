import { afterEach, expect, it, vi } from 'vitest'
import { fetchCatalog } from './catalog-client'

afterEach(() => vi.unstubAllGlobals())

const movie = { id: 'tmdb:movie:1', identity: { provider: 'tmdb', entity: 'movie', id: '1' }, format: 'MOVIE', anime: false,
  title: 'Shared', description: '', genres: [], catalogedAt: Date.now() }

it('shares one in-flight read between callers, and one caller leaving does not cancel the others', async () => {
  let respond!: (response: Response) => void
  const upstream = vi.fn(() => new Promise<Response>((resolve) => { respond = resolve }))
  vi.stubGlobal('fetch', upstream)
  const leaving = new AbortController()
  const first = fetchCatalog('popular/movies', 'tmdb', undefined, leaving.signal)
  const second = fetchCatalog('popular/movies', 'tmdb', undefined, new AbortController().signal)
  leaving.abort()
  respond(Response.json({ items: [movie] }))
  await expect(first).rejects.toBeDefined()
  await expect(second).resolves.toMatchObject({ items: [{ title: 'Shared' }] })
  expect(upstream).toHaveBeenCalledTimes(1)

  // Once settled, the next read goes to the network again; searches are never shared.
  upstream.mockImplementation(async () => Response.json({ items: [movie] }))
  await fetchCatalog('popular/movies', 'tmdb', undefined, new AbortController().signal)
  await Promise.all([1, 2].map(() => fetchCatalog('search/tmdb', 'tmdb', 'Shared', new AbortController().signal)))
  expect(upstream).toHaveBeenCalledTimes(4)
})
