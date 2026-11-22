import { bookTypes } from '../domain/books'
import { queryLimit } from '../domain/catalog'
import type { CatalogPayload, Provider } from '../domain/catalog'
import { catalogCacheAge, parseCatalogKey } from '../domain/identity'
import { isCalendarDate, isEpisodePosition } from '../domain/media'
import type { Episode, Media } from '../domain/media'

export class CatalogResponseError extends Error {
  constructor(readonly status: number, readonly retryAfter?: number) {
    super('The catalog could not be reached.')
  }
}

/** Worth retrying later: offline, timeouts, throttling and server errors. Anything else about one title is permanent. */
export const isTransient = (cause: unknown) =>
  !(cause instanceof CatalogResponseError) || cause.status === 429 || cause.status >= 500

const backoffs = new Map<Provider, number>()
const previews = new Map<string, Media>()

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function strings(value: unknown) {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

function season(value: unknown) {
  return isObject(value) && typeof value.number === 'number' && Number.isSafeInteger(value.number) && value.number >= 0 &&
    (value.episodeCount === undefined || (typeof value.episodeCount === 'number' && Number.isSafeInteger(value.episodeCount) && value.episodeCount >= 0))
}

function isEpisode(value: unknown): value is Episode {
  return isObject(value) && typeof value.title === 'string' && typeof value.season === 'number' && typeof value.number === 'number' &&
    (value.externalId === undefined || typeof value.externalId === 'string') &&
    (value.airDate === undefined || (typeof value.airDate === 'string' && isCalendarDate(value.airDate))) &&
    isEpisodePosition({ season: value.season, number: value.number })
}

function isMedia(value: unknown): value is Media {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.title !== 'string' ||
    typeof value.description !== 'string' || !strings(value.genres) ||
    (value.aliases !== undefined && !strings(value.aliases)) ||
    (value.year !== undefined && (typeof value.year !== 'number' || !Number.isInteger(value.year))) ||
    (value.poster !== undefined && (typeof value.poster !== 'string' ||
      !/^https:\/\/(image\.tmdb\.org|images\.igdb\.com|covers\.openlibrary\.org)\//.test(value.poster))) ||
    (value.runtime !== undefined && (typeof value.runtime !== 'number' || !Number.isInteger(value.runtime) || value.runtime < 1 || value.runtime > 1500)) ||
    (value.countries !== undefined && (!strings(value.countries) || (value.countries as string[]).some((code) => !/^[A-Z]{2}$/.test(code)))) ||
    (value.language !== undefined && (typeof value.language !== 'string' || !/^[a-z]{2,3}$/.test(value.language)))) return false
  const identity = parseCatalogKey(value.id)
  if (!identity || !isObject(value.identity) || value.identity.provider !== identity.provider ||
    value.identity.entity !== identity.entity || value.identity.id !== identity.id ||
    typeof value.catalogedAt !== 'number' || !Number.isSafeInteger(value.catalogedAt)) return false
  if (identity.entity === 'work') return value.format === 'BOOK' && bookTypes.some((type) => type === value.bookType)
  if (identity.entity === 'game') return value.format === 'GAME'
  if (identity.entity === 'movie') return value.format === 'MOVIE' && typeof value.anime === 'boolean'
  return value.format === 'SERIES' && typeof value.anime === 'boolean' &&
    (value.seasons === undefined || (Array.isArray(value.seasons) && value.seasons.every(season))) &&
    (value.episodeTotal === undefined || (typeof value.episodeTotal === 'number' && Number.isSafeInteger(value.episodeTotal) && value.episodeTotal >= 0))
}

export function rememberPreview(media: Media) {
  if (!media.identity) return
  if (previews.size >= 64) {
    const oldest = previews.keys().next().value
    if (oldest) previews.delete(oldest)
  }
  previews.set(media.id, media)
}

export function peekPreview(id: string | undefined) {
  if (!id) return
  const media = previews.get(id)
  if (media?.identity && media.catalogedAt && media.catalogedAt + catalogCacheAge(media.identity.provider) > Date.now()) return media
}

const inflight = new Map<string, Promise<CatalogPayload>>()

/** Reads (shelves, details, seasons) are shared: concurrent callers such as the startup warm-up and a shelf get one request. */
export function fetchCatalog(path: string, provider: Provider, query: string | undefined, signal: AbortSignal): Promise<CatalogPayload> {
  if (query !== undefined) return requestCatalog(path, provider, query, signal)
  let shared = inflight.get(path)
  if (!shared) {
    shared = requestCatalog(path, provider, undefined, AbortSignal.timeout(17_000)).finally(() => inflight.delete(path))
    inflight.set(path, shared)
  }
  const request = shared
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    request.then(resolve, reject)
  })
}

async function requestCatalog(path: string, provider: Provider, query: string | undefined, signal: AbortSignal): Promise<CatalogPayload> {
  const until = backoffs.get(provider) ?? 0
  if (until > Date.now()) throw new CatalogResponseError(429, Math.ceil((until - Date.now()) / 1000))
  if (query !== undefined && (!query || query.length > queryLimit)) throw new CatalogResponseError(400)
  const response = await fetch(`/api/catalog/${path}`, {
    method: query === undefined ? 'GET' : 'POST',
    headers: query === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: query === undefined ? undefined : JSON.stringify({ query }),
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(17_000)]),
  })
  if (!response.ok) {
    const header = Number(response.headers.get('Retry-After') ?? 4)
    const delay = response.status === 429 && Number.isFinite(header) ? Math.max(1, Math.min(60, header)) : undefined
    if (delay) backoffs.set(provider, Date.now() + delay * 1000)
    throw new CatalogResponseError(response.status, delay)
  }
  const body: unknown = await response.json()
  if (!isObject(body)) throw new CatalogResponseError(502)
  if (Array.isArray(body.items) && body.items.every(isMedia) && (body.hasMore === undefined || typeof body.hasMore === 'boolean')) {
    for (const item of body.items) rememberPreview(item)
    return { items: body.items, partial: body.partial === true, hasMore: body.hasMore === true }
  }
  if (Array.isArray(body.episodes) && body.episodes.every(isEpisode)) return { episodes: body.episodes }
  throw new CatalogResponseError(502)
}
