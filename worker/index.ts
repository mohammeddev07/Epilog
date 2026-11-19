import { cleanQuery, discoverSections, maxCatalogPage, queryLimit, sectionPaths } from '../src/domain/catalog'
import type { CatalogItems } from '../src/domain/catalog'
import { parseCatalogKey } from '../src/domain/identity'
import { CatalogFailure, readJson, record } from './http'
import type { FetchProvider } from './http'
import { IgdbAdapter } from './igdb'
import { TmdbAdapter } from './tmdb'

export interface Env {
  TMDB_READ_ACCESS_TOKEN?: string
  IGDB_CLIENT_ID?: string
  IGDB_CLIENT_SECRET?: string
  CATALOG_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> }
}

const routePrefix = '/api/catalog/'
const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const cacheAge = 20 * 60_000
const shelfCacheLimit = 64
const errors = {
  400: 'invalid_request',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  429: 'rate_limited',
  502: 'provider_unavailable',
  503: 'provider_unavailable',
  504: 'provider_timeout',
} as const

type Shelf = CatalogItems

export function createCatalogWorker(fetcher: FetchProvider = (input, init) => fetch(input, init)) {
  const tmdb = new TmdbAdapter(fetcher)
  const igdb = new IgdbAdapter(fetcher)
  const shelves = new Map<string, { value: Shelf; until: number }>()

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      try {
        const url = new URL(request.url)
        if (!url.pathname.startsWith(routePrefix)) throw new CatalogFailure(404)
        const origin = request.headers.get('origin')
        if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
          throw new CatalogFailure(403)
        }
        const path = url.pathname.slice(routePrefix.length).split('/')
        const [action, key, segment] = path
        if (path.length > 3) throw new CatalogFailure(404)
        if (request.method !== (action === 'search' ? 'POST' : 'GET')) throw new CatalogFailure(405)
        const credentials = { clientId: env.IGDB_CLIENT_ID, clientSecret: env.IGDB_CLIENT_SECRET }

        const rate = await env.CATALOG_RATE_LIMITER?.limit({
          key: request.headers.get('CF-Connecting-IP') ?? 'local',
        })
        if (rate && !rate.success) throw new CatalogFailure(429, 60)

        if (action === 'search' && (key === 'tmdb' || key === 'igdb') && path.length === 2) {
          if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json') || url.search) throw new CatalogFailure(400)
          const body = record(await readJson(request, 1024, 400))
          if (typeof body?.query !== 'string') throw new CatalogFailure(400)
          const query = cleanQuery(body.query)
          if (!query || query.length > queryLimit) throw new CatalogFailure(400)
          const result = key === 'tmdb' ? await tmdb.search(env.TMDB_READ_ACCESS_TOKEN, query) : await igdb.search(credentials, query)
          return Response.json(result, { headers: responseHeaders })
        }

        if (action === 'popular' && path.length === 2) {
          const category = discoverSections.find((item) => sectionPaths[item] === key)
          if (!category) throw new CatalogFailure(404)
          const rawPage = url.searchParams.get('page') ?? '1'
          const page = Number(rawPage)
          if (!/^[1-9]\d{0,2}$/.test(rawPage) || page > maxCatalogPage || url.searchParams.size > Number(url.searchParams.has('page'))) {
            throw new CatalogFailure(400)
          }
          const cacheKey = `${category}:${page}`
          const cached = shelves.get(cacheKey)
          if (cached && cached.until > Date.now()) return Response.json(cached.value, { headers: responseHeaders })
          const value: Shelf = category === 'Games' ? await igdb.popular(credentials, page) : await tmdb.popular(env.TMDB_READ_ACCESS_TOKEN, category, page)
          if (!value.partial) {
            shelves.delete(cacheKey)
            const oldest = shelves.keys().next().value
            if (oldest && shelves.size >= shelfCacheLimit) shelves.delete(oldest)
            shelves.set(cacheKey, { value, until: Date.now() + cacheAge })
          }
          return Response.json(value, { headers: responseHeaders })
        }

        const identity = key ? parseCatalogKey(decodeURIComponent(key)) : undefined
        if (action === 'detail' && path.length === 2 && identity) {
          const media = identity.provider === 'tmdb'
            ? await tmdb.detail(env.TMDB_READ_ACCESS_TOKEN, identity.entity, identity.id)
            : await igdb.detail(credentials, identity.id)
          return Response.json({ items: [media] }, { headers: responseHeaders })
        }
        if (action === 'season' && identity?.entity === 'tv' && segment && /^\d{1,5}$/.test(segment)) {
          const episodes = await tmdb.season(env.TMDB_READ_ACCESS_TOKEN, identity.id, Number(segment))
          return Response.json({ episodes }, { headers: responseHeaders })
        }

        throw new CatalogFailure(404)
      } catch (error) {
        const failureStatus = error instanceof CatalogFailure ? error.status : error instanceof URIError ? 400 : 502
        const status = failureStatus in errors ? failureStatus as keyof typeof errors : 503
        const headers = new Headers(responseHeaders)
        if (error instanceof CatalogFailure && error.retryAfter) headers.set('Retry-After', String(error.retryAfter))
        return Response.json({ error: errors[status] }, { status, headers })
      }
    },
  }
}

export default createCatalogWorker()
