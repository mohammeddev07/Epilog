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
export const browsePreviewSize = 12
export const maxCatalogPage = 500
export const popularTitle = 'Popular This Week'
export const defaultPopularCategory = discoverSections[0]

export const browseModes = ['popular', 'rated', 'anticipated', 'release'] as const
export type BrowseMode = (typeof browseModes)[number]
export const browseLabels = {
  popular: popularTitle,
  rated: 'Highest Rated',
  anticipated: 'Most Anticipated',
  release: 'Release Date',
} satisfies Record<BrowseMode, string>

export const releaseDecades = [2020, 2010, 2000, 1990, 1980, 1970] as const
export interface ReleasePeriod {
  decade: (typeof releaseDecades)[number]
  year?: number
}

export type DiscoverQuery = { mode: 'rated' } | { mode: 'anticipated' } | { mode: 'release'; period: ReleasePeriod }
export type BrowseQuery = DiscoverQuery | { mode: 'popular' }
export const defaultReleasePeriod: ReleasePeriod = { decade: releaseDecades[0] }
const yearsPerDecade = 10

export function parseReleasePeriod(decade: string | null, year: string | null): ReleasePeriod | undefined {
  const start = releaseDecades.find((value) => String(value) === decade)
  if (start === undefined) return
  if (year === null) return { decade: start }
  const selected = Number(year)
  if (/^\d{4}$/.test(year) && selected >= start && selected < start + yearsPerDecade) return { decade: start, year: selected }
}

export function releaseYearRange({ decade, year }: ReleasePeriod) {
  return { first: year ?? decade, last: year ?? decade + yearsPerDecade - 1 }
}

export function browseCatalogPath(category: DiscoverSection, query: BrowseQuery, page: number) {
  const section = sectionPaths[category]
  const pathname = query.mode === 'popular' ? `popular/${section}` : `discover/${query.mode}/${section}`
  const params = new URLSearchParams()
  if (query.mode === 'release') {
    params.set('decade', String(query.period.decade))
    if (query.period.year !== undefined) params.set('year', String(query.period.year))
  }
  if (page > 1) params.set('page', String(page))
  return params.size ? `${pathname}?${params}` : pathname
}

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
  hasMore?: boolean
}

export type CatalogPayload = CatalogItems | { episodes: import('./media').Episode[] }
