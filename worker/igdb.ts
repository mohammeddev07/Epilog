import { maxCatalogPage, releaseYearRange, searchResultLimit } from '../src/domain/catalog'
import type { BrowseQuery } from '../src/domain/catalog'
import { catalogKey } from '../src/domain/identity'
import type { Media } from '../src/domain/media'
import { CatalogFailure, Cooldown, externalId, nonnegativeInteger, plainText, providerJson, record, records, validYear } from './http'
import type { FetchProvider, JsonObject } from './http'

export interface GameCredentials {
  clientId?: string
  clientSecret?: string
}

const gameFields = 'fields name,summary,first_release_date,cover.image_id,genres.name,alternative_names.name;'
const requestSpacing = 260
const browsePageSize = 32
const minimumRatings = 10
const secondsPerMillisecond = 1 / 1000

function wait(duration: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, duration))
}

function gameMedia(raw: JsonObject): Media | undefined {
  const id = externalId(raw.id)
  const title = plainText(raw.name, 220)
  if (!id || !title) return
  const identity = { provider: 'igdb', entity: 'game', id } as const
  const release = nonnegativeInteger(raw.first_release_date)
  const cover = plainText(record(raw.cover)?.image_id, 120)
  return {
    id: catalogKey(identity),
    identity,
    catalogedAt: Date.now(),
    format: 'GAME',
    title,
    year: release === undefined ? undefined : validYear(new Date(release * 1000).getUTCFullYear()),
    description: plainText(raw.summary, 1600),
    poster: /^[A-Za-z0-9_-]+$/.test(cover) ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${cover}.jpg` : undefined,
    genres: records(raw.genres).map((genre) => plainText(genre.name, 80)).filter(Boolean).slice(0, 12),
    aliases: records(raw.alternative_names).map((alias) => plainText(alias.name, 220)).filter(Boolean).slice(0, 12),
  }
}

export class IgdbAdapter {
  private readonly cooldown = new Cooldown()
  private token?: { clientId: string; value: string; expiresAt: number }
  private acquiringUntil = 0
  private nextRequest = 0

  constructor(private readonly fetcher: FetchProvider) {}

  private async accessToken(clientId: string, secret: string) {
    for (let attempt = 0; attempt < 8 && this.acquiringUntil > Date.now(); attempt++) {
      await wait(100)
      if (this.token?.clientId === clientId && this.token.expiresAt > Date.now()) return this.token.value
    }
    if (this.token?.clientId === clientId && this.token.expiresAt > Date.now()) return this.token.value
    if (this.acquiringUntil > Date.now()) throw new CatalogFailure(429, 1)
    const lease = Date.now() + 8_000
    this.acquiringUntil = lease
    try {
      const body = new URLSearchParams({ client_id: clientId, client_secret: secret, grant_type: 'client_credentials' })
      const response = record(await providerJson(this.fetcher, 'https://id.twitch.tv/oauth2/token', { method: 'POST', body }))
      const value = response?.access_token
      const expires = nonnegativeInteger(response?.expires_in)
      if (typeof value !== 'string' || !value || !expires) throw new CatalogFailure(502)
      this.token = { clientId, value, expiresAt: Date.now() + Math.max(1, expires - 60) * 1000 }
      return value
    } finally {
      if (this.acquiringUntil === lease) this.acquiringUntil = 0
    }
  }

  private async request(config: GameCredentials, path: string, body: string) {
    const { clientId, clientSecret } = config
    if (!clientId || !clientSecret) throw new CatalogFailure(503)
    const token = await this.cooldown.run(() => this.accessToken(clientId, clientSecret))
    const now = Date.now()
    const delay = Math.max(0, this.nextRequest - now)
    if (delay > 1800) throw new CatalogFailure(429, 2)
    this.nextRequest = now + delay + requestSpacing
    if (delay) await wait(delay)
    try {
      return await this.cooldown.run(async () => {
        const response = await providerJson(this.fetcher, `https://api.igdb.com/v4/${path}`, {
          method: 'POST',
          headers: { 'Client-ID': clientId, Authorization: `Bearer ${token}`, Accept: 'application/json' },
          body,
        })
        if (!Array.isArray(response)) throw new CatalogFailure(502)
        return records(response)
      })
    } catch (error) {
      if (error instanceof CatalogFailure && error.status === 401) this.token = undefined
      throw error
    }
  }

  async search(config: GameCredentials, query: string) {
    const phrase = query.replace(/["\\;]/g, ' ').replace(/\p{Cc}/gu, ' ').trim()
    if (!phrase) return { items: [] }
    const output = await this.request(config, 'games', `search "${phrase}"; ${gameFields} limit ${searchResultLimit};`)
    return { items: output.flatMap((item) => gameMedia(item) ?? []) }
  }

  async browse(config: GameCredentials, query: BrowseQuery, page: number) {
    if (query.mode === 'popular') return this.popular(config, page)
    const offset = (page - 1) * browsePageSize
    let filters: string
    switch (query.mode) {
      case 'rated':
        filters = `where total_rating_count >= ${minimumRatings}; sort total_rating desc;`
        break
      case 'anticipated': {
        const today = new Date().toISOString().slice(0, 10)
        const start = Date.parse(today) * secondsPerMillisecond
        filters = `where first_release_date >= ${start} & hypes > 0; sort hypes desc;`
        break
      }
      case 'release': {
        const { first, last } = releaseYearRange(query.period)
        const start = Date.UTC(first, 0, 1) * secondsPerMillisecond
        const end = Date.UTC(last + 1, 0, 1) * secondsPerMillisecond
        filters = `where first_release_date >= ${start} & first_release_date < ${end}; sort first_release_date desc;`
        break
      }
    }
    const results = await this.request(config, 'games', `${gameFields} ${filters} limit ${browsePageSize}; offset ${offset};`)
    return { items: results.flatMap((item) => gameMedia(item) ?? []), hasMore: results.length === browsePageSize && page < maxCatalogPage }
  }

  private async popular(config: GameCredentials, page: number) {
    const offset = (page - 1) * browsePageSize
    const results = await this.request(config, 'popularity_primitives',
      `fields game_id; where popularity_type = 1; sort value desc; limit ${browsePageSize}; offset ${offset};`)
    const hasMore = results.length === browsePageSize && page < maxCatalogPage
    const ids = [...new Set(results.flatMap((item) => externalId(item.game_id) ?? []))]
    if (!ids.length) return { items: [], hasMore }
    const games = await this.request(config, 'games', `${gameFields} where id = (${ids.join(',')}); limit ${ids.length};`)
    const byId = new Map(games.map((item) => [externalId(item.id), gameMedia(item)]))
    return { items: ids.flatMap((id) => byId.get(id) ?? []), hasMore }
  }

  async detail(config: GameCredentials, id: string) {
    const games = await this.request(config, 'games', `${gameFields} where id = ${id}; limit 1;`)
    const media = games[0] && gameMedia(games[0])
    if (!media || media.identity?.id !== id) throw new CatalogFailure(404)
    return media
  }
}
