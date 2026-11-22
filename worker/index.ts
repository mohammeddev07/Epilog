import { z } from 'zod'
import { BookAdapter } from './books'
import { bookTypes } from '../src/domain/books'
import { browseCatalogPath, cleanQuery, discoverSections, maxCatalogPage, parseReleasePeriod, queryLimit, sectionPaths } from '../src/domain/catalog'
import type { BrowseQuery, CatalogItems } from '../src/domain/catalog'
import { parseCatalogKey } from '../src/domain/identity'
import { createAccountRoutes } from './auth'
import type { D1Database } from './d1'
import { deploymentConfig } from './deployment-config'
import { CatalogFailure, errorResponse, isJson, readJson, record, rejectCrossSite, responseHeaders } from './http'
import type { FetchProvider } from './http'
import { IgdbAdapter } from './igdb'
import { TmdbAdapter } from './tmdb'

export interface Env {
  TMDB_READ_ACCESS_TOKEN?: string
  IGDB_CLIENT_ID?: string
  IGDB_CLIENT_SECRET?: string
  CATALOG_RATE_LIMITER?: RateLimiter
  SYNC_RATE_LIMITER?: RateLimiter
  DB?: D1Database
  GOOGLE_CLIENT_ID?: string
  PRIVACY_CONTACT_EMAIL?: string
}

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

const privacyEmail = z.email().max(254)
const routePrefix = '/api/catalog/'
const cacheAge = 20 * 60_000
const shelfCacheLimit = 64

type Shelf = CatalogItems

function readBrowse(mode: string | undefined, params: URLSearchParams): { query: BrowseQuery; page: number } {
  const allowed = mode === 'release' ? ['page', 'decade', 'year'] : ['page']
  const keys = new Set(params.keys())
  if (keys.size !== params.size || [...keys].some((key) => !allowed.includes(key))) throw new CatalogFailure(400)
  const rawPage = params.get('page') ?? '1'
  const page = Number(rawPage)
  if (!/^[1-9]\d{0,2}$/.test(rawPage) || page > maxCatalogPage) throw new CatalogFailure(400)
  if (mode === 'release') {
    const period = parseReleasePeriod(params.get('decade'), params.get('year'))
    if (!period) throw new CatalogFailure(400)
    return { query: { mode, period }, page }
  }
  if (mode === 'popular' || mode === 'rated' || mode === 'anticipated') return { query: { mode }, page }
  throw new CatalogFailure(404)
}

export function createCatalogWorker(
  fetcher: FetchProvider = (input, init) => fetch(input, init),
  accounts = createAccountRoutes(),
) {
  const books = new BookAdapter(fetcher)
  const tmdb = new TmdbAdapter(fetcher)
  const igdb = new IgdbAdapter(fetcher)
  const shelves = new Map<string, { value: Shelf; until: number }>()

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const account = await accounts.fetch(request, env)
      if (account) return account
      try {
        const url = new URL(request.url)
        if (url.pathname === '/api/privacy-contact') {
          rejectCrossSite(request, url)
          if (request.method !== 'GET') throw new CatalogFailure(405)
          const contact = env.PRIVACY_CONTACT_EMAIL ?? deploymentConfig.privacyContactEmail
          const email = privacyEmail.safeParse(contact?.trim()).data
          return Response.json({ email: email ?? null }, { headers: responseHeaders })
        }
        if (!url.pathname.startsWith(routePrefix)) throw new CatalogFailure(404)
        rejectCrossSite(request, url)
        const path = url.pathname.slice(routePrefix.length).split('/')
        const [action, key, segment] = path
        if (path.length > 3) throw new CatalogFailure(404)
        if (request.method !== (action === 'search' ? 'POST' : 'GET')) throw new CatalogFailure(405)
        const credentials = { clientId: env.IGDB_CLIENT_ID, clientSecret: env.IGDB_CLIENT_SECRET }

        const rate = await env.CATALOG_RATE_LIMITER?.limit({
          key: request.headers.get('CF-Connecting-IP') ?? 'local',
        })
        if (rate && !rate.success) throw new CatalogFailure(429, 60)

        if (action === 'search' && (key === 'tmdb' || key === 'igdb' || key === 'openlibrary') && path.length === 2) {
          const type = bookTypes.find((item) => item === url.searchParams.get('type'))
          if (!isJson(request) ||
            (url.search && (key !== 'openlibrary' || !type || url.searchParams.size !== 1))) throw new CatalogFailure(400)
          const body = record(await readJson(request, 1024, 400))
          if (typeof body?.query !== 'string') throw new CatalogFailure(400)
          const query = cleanQuery(body.query)
          if (!query || query.length > queryLimit) throw new CatalogFailure(400)
          const result = key === 'openlibrary' ? await books.list(query, 1, type) : key === 'tmdb' ? await tmdb.search(env.TMDB_READ_ACCESS_TOKEN, query) : await igdb.search(credentials, query)
          return Response.json(result, { headers: responseHeaders })
        }

        if ((action === 'popular' && path.length === 2) || (action === 'discover' && path.length === 3)) {
          const section = action === 'popular' ? key : segment
          const category = discoverSections.find((item) => sectionPaths[item] === section)
          if (!category) throw new CatalogFailure(404)
          if (action === 'discover' && key === 'popular') throw new CatalogFailure(404)
          const params = new URLSearchParams(url.searchParams)
          const type = bookTypes.find((type) => type === params.get('type'))
          if (category === 'Books') {
            if (params.has('type') && (!type || params.getAll('type').length !== 1)) throw new CatalogFailure(400)
            params.delete('type')
          }
          const { query, page } = readBrowse(action === 'popular' ? action : key, params)
          if (type) query.bookType = type
          const cacheKey = browseCatalogPath(category, query, page)
          const cached = shelves.get(cacheKey)
          if (cached && cached.until > Date.now()) return Response.json(cached.value, { headers: responseHeaders })
          const value: Shelf = category === 'Books' ? await books.browse(query, page, type) : category === 'Games'
            ? await igdb.browse(credentials, query, page)
            : await tmdb.browse(env.TMDB_READ_ACCESS_TOKEN, category, query, page)
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
          const media = identity.provider === 'openlibrary' ? await books.detail(identity.id) : identity.provider === 'tmdb'
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
        return errorResponse(error)
      }
    },
  }
}

export default createCatalogWorker()
