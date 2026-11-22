export type CatalogIdentity =
  | { provider: 'tmdb'; entity: 'movie' | 'tv'; id: string }
  | { provider: 'openlibrary'; entity: 'work'; id: string }
  | { provider: 'igdb'; entity: 'game'; id: string }

export function catalogKey(identity: CatalogIdentity) {
  return `${identity.provider}:${identity.entity}:${identity.id}`
}

export function parseCatalogKey(key: string): CatalogIdentity | undefined {
  const [provider, entity, id, extra] = key.split(':')
  if (extra === undefined && provider === 'openlibrary' && entity === 'work' && /^OL[1-9]\d{0,11}W$/.test(id)) return { provider, entity, id }
  if (extra !== undefined || !id || !/^[1-9]\d{0,11}$/.test(id)) return
  if (provider === 'tmdb' && (entity === 'movie' || entity === 'tv')) return { provider, entity, id }
  if (provider === 'igdb' && entity === 'game') return { provider, entity, id }
}

export function catalogCacheAge(provider: CatalogIdentity['provider']) {
  return provider === 'tmdb' ? 30 * 24 * 60 * 60_000 : 24 * 60 * 60_000
}
