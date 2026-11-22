import type { BookType } from '../domain/books'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { browseCatalogPath, cleanQuery, defaultPopularCategory, defaultReleasePeriod, discoverSections } from '../domain/catalog'
import type { BrowseQuery, CatalogPayload, DiscoverSection, Provider } from '../domain/catalog'
import { catalogKey, parseCatalogKey } from '../domain/identity'
import type { CatalogIdentity } from '../domain/identity'
import type { LibraryEntry } from '../domain/media'
import { CatalogResponseError, fetchCatalog, rememberPreview } from './catalog-client'
import { library } from './library'

export const demoMode = import.meta.env.MODE === 'demo'

type Status = 'idle' | 'loading' | 'ready' | 'partial' | 'stale' | 'unavailable' | 'offline' | 'limited' | 'missing'

interface State {
  key: string
  status: Status
  data?: CatalogPayload
  retryAfter?: number
  cacheError?: boolean
}

const statusOnly = (key: string, status: Status): State => ({ key, status })

function subscribe(callback: () => void) {
  window.addEventListener('online', callback)
  window.addEventListener('offline', callback)
  return () => {
    window.removeEventListener('online', callback)
    window.removeEventListener('offline', callback)
  }
}

function online() {
  return navigator.onLine
}

export function useConnection() {
  return useSyncExternalStore(subscribe, online, () => true)
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = window.setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

const resourceKey = (path: string, query?: string, cacheVersion?: string) =>
  cacheVersion ? `${path}:${cacheVersion}` : query === undefined ? path : `${path}:${query.toLowerCase()}`

function useResource(
  path: string,
  provider: Provider,
  enabled: boolean,
  freshness: number,
  retry: number,
  query?: string,
  cacheVersion?: string,
) {
  const key = resourceKey(path, query, cacheVersion)
  const connected = useConnection()
  const [state, setState] = useState<State>(statusOnly('', 'idle'))
  const active = enabled && !demoMode

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const signal = controller.signal
    async function load() {
      let cacheError = false
      const cached = await library.readResponse(key).catch(() => { cacheError = true; return undefined })
      if (signal.aborted) return
      if (cached && 'items' in cached.payload) {
        for (const media of cached.payload.items) rememberPreview(media)
      }
      if (!connected) {
        setState({ key, status: cached ? 'stale' : 'offline', data: cached?.payload, cacheError })
        return
      }
      if (cached && Date.now() - cached.writtenAt < freshness && !retry) {
        setState({ key, status: 'ready', data: cached.payload })
        return
      }
      setState({ key, status: 'loading', data: cached?.payload, cacheError })
      try {
        if (query !== undefined) await wait(250, signal)
        const data = await fetchCatalog(path, provider, query, signal)
        if (signal.aborted) return
        const partial = 'items' in data && data.partial
        setState({ key, data, status: partial ? 'partial' : 'ready', cacheError })
        if (!partial) {
          try {
            await library.cacheResponse(key, provider, data)
          } catch {
            if (!signal.aborted) setState({ key, data, status: 'ready', cacheError: true })
          }
        }
      } catch (cause) {
        if (signal.aborted) return
        const code = cause instanceof CatalogResponseError ? cause.status : undefined
        const retryAfter = cause instanceof CatalogResponseError ? cause.retryAfter : undefined
        const next = code === 429 ? 'limited' : cached ? 'stale' : code === 404 ? 'missing' : 'unavailable'
        setState({ key, status: next, data: cached?.payload, retryAfter, cacheError })
      }
    }
    void load()
    return () => controller.abort()
  }, [active, connected, freshness, key, path, provider, query, retry])

  if (!active) return statusOnly(key, 'idle')
  return state.key === key ? state : statusOnly(key, connected ? 'loading' : 'offline')
}

const minute = 60_000

export function useProviderSearch(provider: Provider, rawQuery: string, retry: number, bookType?: BookType) {
  const query = cleanQuery(rawQuery)
  return useResource(`search/${provider}${bookType ? '?' + new URLSearchParams({ type: bookType }) : ''}`, provider, Boolean(query), 10 * minute, retry, query)
}

const browseFreshness = 20 * minute

function browseResource(section: DiscoverSection, query: BrowseQuery, page = 1) {
  const path = browseCatalogPath(section, query, page)
  const cacheVersion = query.mode === 'popular' ? 'weekly-v2' : 'browse-v1'
  const provider: Provider = section === 'Books' ? 'openlibrary' : section === 'Games' ? 'igdb' : 'tmdb'
  return { path, provider, cacheVersion, key: resourceKey(path, undefined, cacheVersion) }
}

export function useBrowsePage(section: DiscoverSection, query: BrowseQuery, page: number, retry: number, enabled: boolean) {
  const { path, provider, cacheVersion } = browseResource(section, query, page)
  return useResource(path, provider, enabled, browseFreshness, retry, undefined, cacheVersion)
}

const startupShelves: readonly (readonly [DiscoverSection, BrowseQuery])[] = [
  ...discoverSections.map((section) => [section, { mode: 'popular' }] as const),
  [defaultPopularCategory, { mode: 'rated' }],
  [defaultPopularCategory, { mode: 'anticipated' }],
  [defaultPopularCategory, { mode: 'release', period: defaultReleasePeriod }],
]

/**
 * After startup, refresh the shelves people see first (every category's Popular shelf and the default category's
 * other Dashboard shelves) so switching tabs or scrolling shows titles at once. Only missing or stale shelves are
 * fetched, one at a time, and the first failure stops it. Skipped offline, with Data Saver, and in the demo.
 */
export async function warmCatalog(signal: AbortSignal) {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  if (demoMode || !navigator.onLine || connection?.saveData) return
  for (const [section, query] of startupShelves) {
    const { path, provider, key } = browseResource(section, query)
    const cached = await library.readResponse(key).catch(() => undefined)
    if (cached && Date.now() - cached.writtenAt < browseFreshness) continue
    try {
      const data = await fetchCatalog(path, provider, undefined, signal)
      if ('items' in data && !data.partial) await library.cacheResponse(key, provider, data)
    } catch {
      return // Offline, throttled, or closed: each shelf still loads normally when opened.
    }
  }
}

export function useCatalogDetail(identity: CatalogIdentity | undefined, retry: number) {
  const key = identity ? catalogKey(identity) : ''
  const resource = useResource(`detail/${encodeURIComponent(key)}`, identity?.provider ?? 'tmdb', Boolean(identity), 10 * minute, retry)
  const [snapshotError, setSnapshotError] = useState<string>()
  const item = resource.data && 'items' in resource.data ? resource.data.items[0] : undefined

  useEffect(() => {
    if (!item || resource.status !== 'ready') return
    let active = true
    void library.refreshSnapshot(item).catch(() => {
      if (active) setSnapshotError(key)
    })
    return () => { active = false }
  }, [item, key, resource.status])

  return { ...resource, item, cacheError: resource.cacheError || (Boolean(key) && snapshotError === key) }
}

export function useCatalogSeason(identity: CatalogIdentity | undefined, season: number | undefined, retry: number) {
  const key = identity ? catalogKey(identity) : ''
  const enabled = identity?.entity === 'tv' && season !== undefined
  const resource = useResource(`season/${encodeURIComponent(key)}/${season}`, 'tmdb', enabled, 30 * minute, retry)
  const episodes = resource.data && 'episodes' in resource.data ? resource.data.episodes : undefined
  return { ...resource, episodes }
}

const backfillLimit = 25

/**
 * Titles saved before runtimes were stored have no runtime, so Stats can't count their hours. While Stats is open
 * and online, fetch their details one at a time and refresh the saved snapshot; the live library re-renders itself.
 * Stops at the first failure (offline, rate limited) so it never hammers the catalog.
 * ponytail: 25 titles per visit, sequential; batch on the Worker if libraries grow into the hundreds.
 */
export function useRuntimeBackfill(identities: readonly CatalogIdentity[]) {
  const connected = useConnection()
  const keys = identities.slice(0, backfillLimit).map(catalogKey).join(',')
  const [done, setDone] = useState('')
  useEffect(() => {
    if (demoMode || !connected || !keys) return
    const controller = new AbortController()
    void (async () => {
      for (const key of keys.split(',')) {
        try {
          const payload = await fetchCatalog(`detail/${encodeURIComponent(key)}`, key.startsWith('igdb') ? 'igdb' : 'tmdb', undefined, controller.signal)
          const item = 'items' in payload ? payload.items[0] : undefined
          if (item) await library.refreshSnapshot(item)
        } catch {
          break
        }
      }
      if (!controller.signal.aborted) setDone(keys)
    })()
    return () => controller.abort()
  }, [connected, keys])
  return { working: !demoMode && connected && Boolean(keys) && done !== keys }
}

const hydrationPerMinute = 40
const hydrationSent: number[] = []

/**
 * Entries that arrive by sync carry only a catalog ID, and snapshots expire, so some library titles have no name or
 * poster to show. While online, fetch their details one at a time, most recently updated first, and store each
 * snapshot; the live library re-renders itself. Stops at the first failure and tries again once the set of missing
 * titles changes or the connection returns. Skipped in the demo.
 * ponytail: 40 detail requests per rolling minute (the Worker allows 60, the rest is for interactive use); add a
 * batch detail endpoint to the Worker if libraries are large enough that this takes too long.
 */
export function useSnapshotHydration(entries: ReadonlyMap<string, LibraryEntry>) {
  const connected = useConnection()
  const gate = useRef<AbortController>(undefined)
  const running = useRef<AbortSignal>(undefined)
  const failedOn = useRef('')

  useEffect(() => {
    if (demoMode || !connected) return
    const controller = new AbortController()
    gate.current = controller
    failedOn.current = ''
    return () => {
      controller.abort()
      gate.current = undefined
    }
  }, [connected])

  useEffect(() => {
    const signal = gate.current?.signal
    if (!signal || running.current === signal) return
    running.current = signal
    const tried = new Set<string>() // a snapshot that can't be stored must not be fetched again
    void (async () => {
      try {
        for (;;) {
          const missing = (await library.missingSnapshots()).filter(({ catalogRef }) => !tried.has(catalogRef))
            .sort((a, b) => (entries.get(b.mediaId)?.updatedAt ?? 0) - (entries.get(a.mediaId)?.updatedAt ?? 0))
          const key = missing.map(({ catalogRef }) => catalogRef).join(',')
          if (!missing.length || key === failedOn.current) return
          while (hydrationSent.length && Date.now() - hydrationSent[0] >= minute) hydrationSent.shift()
          if (hydrationSent.length >= hydrationPerMinute) {
            await wait(hydrationSent[0] + minute - Date.now(), signal)
            continue
          }
          hydrationSent.push(Date.now())
          const { mediaId, catalogRef } = missing[0]
          tried.add(catalogRef)
          try {
            const payload = await fetchCatalog(`detail/${encodeURIComponent(catalogRef)}`, parseCatalogKey(catalogRef)!.provider, undefined, signal)
            const item = 'items' in payload ? payload.items[0] : undefined
            if (!item) throw new Error('No details returned.')
            await library.storeSnapshot(mediaId, item)
          } catch (cause) {
            if (!signal.aborted) failedOn.current = key
            throw cause
          }
        }
      } catch {
        // Offline, throttled, closed, or unknown title: retried when the missing set changes or the connection returns.
      } finally {
        if (running.current === signal) running.current = undefined
      }
    })()
  }, [connected, entries])
}
