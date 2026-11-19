import { useEffect, useState, useSyncExternalStore } from 'react'
import { cleanQuery, sectionPaths } from '../domain/catalog'
import type { CatalogPayload, DiscoverSection, Provider } from '../domain/catalog'
import { catalogKey } from '../domain/identity'
import type { CatalogIdentity } from '../domain/identity'
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

function useResource(
  path: string,
  provider: Provider,
  enabled: boolean,
  freshness: number,
  retry: number,
  query?: string,
  cacheVersion?: string,
) {
  const key = cacheVersion ? `${path}:${cacheVersion}` : query === undefined ? path : `${path}:${query.toLowerCase()}`
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

export function useProviderSearch(provider: Provider, rawQuery: string, retry: number) {
  const query = cleanQuery(rawQuery)
  return useResource(`search/${provider}`, provider, Boolean(query), 10 * minute, retry, query)
}

export function usePopularity(section: DiscoverSection, retry: number, enabled: boolean) {
  return useResource(`popular/${sectionPaths[section]}`, section === 'Games' ? 'igdb' : 'tmdb', enabled, 20 * minute, retry, undefined, 'weekly-v1')
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
