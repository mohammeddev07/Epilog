import { discoverResultLimit, interleave, searchResultLimit } from '../src/domain/catalog'
import type { DiscoverSection } from '../src/domain/catalog'
import { catalogKey } from '../src/domain/identity'
import { episodeKey } from '../src/domain/media'
import type { Episode, Media } from '../src/domain/media'
import { CatalogFailure, Cooldown, externalId, nonnegativeInteger, plainText, providerJson, record, records, validYear } from './http'
import type { FetchProvider, JsonObject } from './http'

type WatchEntity = 'movie' | 'tv'
const animationGenre = 16
const genres: Record<number, string> = {
  12: 'Adventure', 14: 'Fantasy', 16: 'Animation', 18: 'Drama', 27: 'Horror', 28: 'Action',
  35: 'Comedy', 36: 'History', 37: 'Western', 53: 'Thriller', 80: 'Crime', 99: 'Documentary',
  878: 'Science fiction', 9648: 'Mystery', 10402: 'Music', 10749: 'Romance', 10751: 'Family',
  10752: 'War', 10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
  10765: 'Sci-fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics', 10770: 'TV Movie',
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

  private async list(token: string | undefined, entity: WatchEntity, path: string, params: Record<string, string>) {
    const { results } = await this.request(token, path, { ...params, include_adult: 'false' })
    if (!Array.isArray(results)) throw new CatalogFailure(502)
    return records(results).flatMap((item) => watchMedia(item, entity) ?? [])
  }

  async search(token: string | undefined, query: string) {
    const results = await Promise.allSettled([
      this.list(token, 'movie', '/search/movie', { query }),
      this.list(token, 'tv', '/search/tv', { query }),
    ])
    return combine(results, searchResultLimit)
  }

  async popular(token: string | undefined, category: Exclude<DiscoverSection, 'Games'>) {
    const sort = { sort_by: 'popularity.desc' }
    if (category === 'Anime') {
      const filters = { ...sort, with_genres: String(animationGenre), with_original_language: 'ja' }
      const results = await Promise.allSettled([
        this.list(token, 'movie', '/discover/movie', filters),
        this.list(token, 'tv', '/discover/tv', filters),
      ])
      return combine(results, discoverResultLimit)
    }
    const entity = category === 'Movies' ? 'movie' : 'tv'
    const items = await this.list(token, entity, `/discover/${entity}`, sort)
    return { items: items.slice(0, discoverResultLimit) }
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
      if (!number || nonnegativeInteger(item.season_number) !== season) continue
      const position = { season, number }
      const key = episodeKey(position)
      const instance: Episode = {
        ...position,
        title: plainText(item.name, 220) || `Episode ${number}`,
        externalId: externalId(item.id),
      }
      byPosition.set(key, byPosition.has(key) ? null : instance)
    }
    return [...byPosition.values()].flatMap((episode) => episode ?? []).sort((a, b) => a.number - b.number)
  }
}

function combine(results: PromiseSettledResult<Media[]>[], limit: number) {
  const available = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  if (!available.length) {
    const first = results.find((result) => result.status === 'rejected')
    throw first?.reason ?? new CatalogFailure(502)
  }
  return { items: interleave(available).slice(0, limit), partial: available.length < results.length || undefined }
}
