import { catalogKey } from './identity'
import type { CatalogIdentity } from './identity'
import type { Media } from './media'

export const providerNames = ['tmdb', 'igdb'] as const
export type Provider = (typeof providerNames)[number]
export const discoverSections = ['Movies', 'TV Shows', 'Anime', 'Games'] as const
export type DiscoverSection = (typeof discoverSections)[number]

export const sectionPaths = {
  Movies: 'movies',
  'TV Shows': 'tv',
  Anime: 'anime',
  Games: 'games',
} as const

export const queryLimit = 120
export const searchResultLimit = 16
export const discoverResultLimit = 32
export const popularPageSize = 8
export const popularTitle = 'Popular This Week'

export function cleanQuery(query: string) {
  return query.trim().replace(/\s+/g, ' ')
}

export function mediaKey(media: Media) {
  return media.identity ? catalogKey(media.identity) : media.id
}

export function uniqueMedia(items: readonly Media[]) {
  return [...new Map(items.map((item) => [mediaKey(item), item])).values()]
}

export function interleave<T>(groups: readonly (readonly T[])[]) {
  const result: T[] = []
  const length = Math.max(0, ...groups.map((group) => group.length))
  for (let index = 0; index < length; index++) {
    for (const group of groups) {
      if (index < group.length) result.push(group[index])
    }
  }
  return result
}

export function providerDisplayName(provider: CatalogIdentity['provider']) {
  return provider === 'tmdb' ? 'TMDB' : 'IGDB'
}

export interface CatalogItems {
  items: Media[]
  partial?: boolean
}

export type CatalogPayload = CatalogItems | { episodes: import('./media').Episode[] }
