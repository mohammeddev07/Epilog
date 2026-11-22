import { interleave, maxCatalogPage, releaseYearRange, searchResultLimit, uniqueMedia } from '../src/domain/catalog'
import type { BrowseQuery, DiscoverQuery, DiscoverSection } from '../src/domain/catalog'
import { catalogKey } from '../src/domain/identity'
import { episodeKey, inCategory, isCalendarDate } from '../src/domain/media'
import type { Episode, Media } from '../src/domain/media'
import { CatalogFailure, Cooldown, externalId, nonnegativeInteger, plainText, providerJson, record, records, validYear } from './http'
import type { FetchProvider, JsonObject } from './http'

type WatchEntity = 'movie' | 'tv'
interface TmdbList {
  items: Media[]
  totalPages?: number
  partial?: boolean
  ranks?: ReadonlyMap<string, number>
}
const animationGenre = 16
const minimumVotes = 50
const animeFilters = { with_genres: String(animationGenre), with_original_language: 'ja' }
const genres: Record<number, string> = {
  12: 'Adventure', 14: 'Fantasy', 16: 'Animation', 18: 'Drama', 27: 'Horror', 28: 'Action',
  35: 'Comedy', 36: 'History', 37: 'Western', 53: 'Thriller', 80: 'Crime', 99: 'Documentary',
  878: 'Science fiction', 9648: 'Mystery', 10402: 'Music', 10749: 'Romance', 10751: 'Family',
  10752: 'War', 10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
  10765: 'Sci-fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics', 10770: 'TV Movie',
}

const minutes = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1500 ? value : undefined
const countryCodes = (value: unknown) => Array.isArray(value)
  ? value.flatMap((item: unknown) => typeof item === 'string' && /^[A-Z]{2}$/.test(item) ? [item] : []).slice(0, 10)
  : []

// Details carry runtime and production countries; list results carry only the original language (and TV origin).
function extras(raw: JsonObject, entity: WatchEntity) {
  const episodeRuntimes = Array.isArray(raw.episode_run_time) ? raw.episode_run_time.flatMap((value: unknown) => minutes(value) ?? []) : []
  const runtime = entity === 'movie' ? minutes(raw.runtime)
    : episodeRuntimes.length ? episodeRuntimes.toSorted((a, b) => a - b)[Math.floor(episodeRuntimes.length / 2)]
      : minutes(record(raw.last_episode_to_air)?.runtime)
  const countries = countryCodes(raw.origin_country).length ? countryCodes(raw.origin_country)
    : countryCodes(records(raw.production_countries).map((country) => country.iso_3166_1))
  const language = typeof raw.original_language === 'string' && /^[a-z]{2,3}$/.test(raw.original_language) ? raw.original_language : undefined
  return { ...(runtime ? { runtime } : {}), ...(countries.length ? { countries } : {}), ...(language ? { language } : {}) }
}

function watchMedia(raw: JsonObject, entity: WatchEntity): Media | undefined {
  const id = externalId(raw.id)
  const title = plainText(entity === 'movie' ? raw.title : raw.name, 220)
  if (!id || !title || raw.adult === true) return
  const identity = { provider: 'tmdb', entity, id } as const
  const listedGenres = Array.isArray(raw.genre_ids) ? raw.genre_ids : records(raw.genres).map((genre) => genre.id)
  const date = entity === 'movie' ? raw.release_date : raw.first_air_date
  const poster = plainText(raw.poster_path, 180)
  const original = plainText(entity === 'movie' ? raw.original_title : raw.original_name, 220)
  const base = {
    id: catalogKey(identity),
    identity,
    catalogedAt: Date.now(),
    title,
    year: typeof date === 'string' ? validYear(Number(date.slice(0, 4))) : undefined,
    genres: listedGenres.flatMap((id: unknown) => typeof id === 'number' && genres[id] ? [genres[id]] : []),
    description: plainText(raw.overview, 1600),
    poster: /^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(poster) ? `https://image.tmdb.org/t/p/w500${poster}` : undefined,
    aliases: original && original !== title ? [original] : undefined,
    anime: raw.original_language === 'ja' && listedGenres.includes(animationGenre),
    ...extras(raw, entity),
  }
  if (entity === 'movie') return { ...base, format: 'MOVIE' }
  const seasons = records(raw.seasons).flatMap((season) => {
    const number = nonnegativeInteger(season.season_number)
    return number === undefined ? [] : [{ number, episodeCount: nonnegativeInteger(season.episode_count) }]
  }).sort((a, b) => a.number - b.number)
  const episodeTotal = raw.status === 'Ended' || raw.status === 'Canceled'
    ? nonnegativeInteger(raw.number_of_episodes)
    : undefined
  return { ...base, format: 'SERIES', seasons: seasons.length ? seasons : undefined, episodeTotal: episodeTotal || undefined }
}

export class TmdbAdapter {
  private readonly cooldown = new Cooldown()

  constructor(private readonly fetcher: FetchProvider) {}

  private async request(token: string | undefined, path: string, params?: Record<string, string>) {
    if (!token) throw new CatalogFailure(503)
    const url = new URL(`https://api.themoviedb.org/3${path}`)
    url.search = new URLSearchParams({ language: 'en-US', ...params }).toString()
    return this.cooldown.run(async () => {
      const raw = record(await providerJson(this.fetcher, url.href, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      }))
      if (!raw) throw new CatalogFailure(502)
      return raw
    })
  }

  private async list(token: string | undefined, entity: WatchEntity, path: string, params: Record<string, string>, rankField?: string): Promise<TmdbList> {
    const { results, total_pages: totalPages } = await this.request(token, path, { ...params, include_adult: 'false' })
    if (!Array.isArray(results)) throw new CatalogFailure(502)
    const ranks = rankField ? new Map<string, number>() : undefined
    const items = records(results).flatMap((item) => {
      const media = watchMedia(item, entity)
      if (media && rankField) ranks?.set(media.id, catalogRank(item[rankField]))
      return media ?? []
    })
    return { items, ranks, totalPages: nonnegativeInteger(totalPages) }
  }

  async search(token: string | undefined, query: string) {
    const results = await Promise.allSettled([
      this.list(token, 'movie', '/search/movie', { query }),
      this.list(token, 'tv', '/search/tv', { query }),
    ])
    const { items, partial } = combine(results)
    return { items: items.slice(0, searchResultLimit), partial }
  }

  async browse(token: string | undefined, category: Exclude<DiscoverSection, 'Games' | 'Books'>, query: BrowseQuery, page: number) {
    const params = { page: String(page) }
    const today = new Date().toISOString().slice(0, 10)
    const shelf = (entity: WatchEntity) => {
      if (query.mode === 'popular' && category !== 'Anime') return this.list(token, entity, `/trending/${entity}/week`, params)
      const options = query.mode === 'popular'
        ? { filters: { sort_by: 'popularity.desc' }, rankField: undefined }
        : discoverFilters(entity, query, today)
      const filters = category === 'Anime' ? { ...animeFilters, ...options.filters } : options.filters
      return this.list(token, entity, `/discover/${entity}`, { ...params, ...filters }, options.rankField)
    }
    const { items, partial, totalPages } = category === 'Anime'
      ? combine(await Promise.allSettled([shelf('movie'), shelf('tv')]), query.mode !== 'popular')
      : await shelf(category === 'Movies' ? 'movie' : 'tv')
    return { items: items.filter((media) => inCategory(media, category)), partial, hasMore: page < Math.min(totalPages ?? page, maxCatalogPage) }
  }

  async detail(token: string | undefined, entity: WatchEntity, id: string) {
    const media = watchMedia(await this.request(token, `/${entity}/${id}`), entity)
    if (!media || media.identity?.id !== id) throw new CatalogFailure(404)
    return media
  }

  async season(token: string | undefined, id: string, season: number) {
    const raw = await this.request(token, `/tv/${id}/season/${season}`)
    if (!Array.isArray(raw.episodes)) throw new CatalogFailure(502)
    const byPosition = new Map<string, Episode | null>()
    for (const item of records(raw.episodes)) {
      const number = nonnegativeInteger(item.episode_number)
      const date = item.air_date
      if (!number || nonnegativeInteger(item.season_number) !== season) continue
      const position = { season, number }
      const key = episodeKey(position)
      const instance: Episode = {
        ...position,
        title: plainText(item.name, 220) || `Episode ${number}`,
        externalId: externalId(item.id),
        airDate: typeof date === 'string' && isCalendarDate(date) ? date : undefined,
      }
      byPosition.set(key, byPosition.has(key) ? null : instance)
    }
    return [...byPosition.values()].flatMap((episode) => episode ?? []).sort((a, b) => a.number - b.number)
  }
}

function discoverFilters(entity: WatchEntity, query: DiscoverQuery, today: string): { filters: Record<string, string>; rankField: string } {
  const dateFilter = entity === 'movie' ? 'primary_release_date' : 'first_air_date'
  if (query.mode === 'rated') return { filters: { sort_by: 'vote_average.desc', 'vote_count.gte': String(minimumVotes) }, rankField: 'vote_average' }
  if (query.mode === 'anticipated') return { filters: { sort_by: 'popularity.desc', [dateFilter + '.gte']: today }, rankField: 'popularity' }
  const { first, last } = releaseYearRange(query.period)
  return {
    filters: { sort_by: `${dateFilter}.desc`, [dateFilter + '.gte']: `${first}-01-01`, [dateFilter + '.lte']: `${last}-12-31` },
    rankField: entity === 'movie' ? 'release_date' : 'first_air_date',
  }
}

function catalogRank(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return typeof value === 'string' && isCalendarDate(value) ? Date.parse(value) : 0
}

function combine(results: PromiseSettledResult<TmdbList>[], ranked = false): TmdbList {
  const available = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  if (!available.length) {
    const first = results.find((result) => result.status === 'rejected')
    throw first?.reason ?? new CatalogFailure(502)
  }
  const items = uniqueMedia(interleave(available.map((list) => list.items)))
  if (ranked) {
    const ranks = new Map(available.flatMap((list) => list.ranks ? [...list.ranks] : []))
    items.sort((a, b) => (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0))
  }
  return {
    items,
    partial: available.length < results.length || undefined,
    totalPages: Math.max(...available.map(({ totalPages }) => totalPages ?? 0)),
  }
}
