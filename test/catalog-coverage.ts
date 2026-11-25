import assert from 'node:assert/strict'
import { test } from 'node:test'

type RecordData = Record<string, unknown>

const timeout = 10_000
const tmdbRoot = 'https://api.themoviedb.org/3'
const igdbRoot = 'https://api.igdb.com/v4'

function credential(name: string) {
  const value = process.env[name]?.trim()
  assert.ok(value, `Set ${name} in the local environment to run this provider check.`)
  return value
}

function object(value: unknown): RecordData {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Expected a provider object')
  return value as RecordData
}

function objects(value: unknown) {
  assert.ok(Array.isArray(value), 'Expected a provider array')
  return value.map((item: unknown) => object(item))
}

async function request(provider: string, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeout) })
  assert.ok(response.ok, `${provider} returned HTTP ${response.status}`)
  return response.json()
}

async function tmdb(path: string, query?: Record<string, string>) {
  const url = new URL(tmdbRoot + path)
  url.search = new URLSearchParams({ language: 'en-US', ...query }).toString()
  return object(await request('TMDB', url.href, {
    headers: { Authorization: `Bearer ${credential('TMDB_READ_ACCESS_TOKEN')}`, Accept: 'application/json' },
  }))
}

async function appToken(clientId: string, clientSecret: string) {
  const result = object(await request('Twitch app token', 'https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  }))
  const token = result.access_token
  assert.ok(typeof token === 'string' && token, 'Twitch did not return an application token')
  return token
}

async function igdb(clientId: string, token: string, statement: string) {
  return objects(await request('IGDB', `${igdbRoot}/games`, {
    method: 'POST',
    headers: { 'Client-ID': clientId, Authorization: `Bearer ${token}`, Accept: 'application/json' },
    body: statement,
  }))
}

function tmdbYear(date: unknown) {
  return typeof date === 'string' ? date.slice(0, 4) : undefined
}

function igdbYear(date: unknown) {
  return typeof date === 'number' ? new Date(date * 1000).getUTCFullYear() : undefined
}

function isJapaneseAnimation(item: RecordData) {
  const genres: unknown = item.genre_ids
  return item.original_language === 'ja' && Array.isArray(genres) && genres.includes(16)
}

test('TMDB distinguishes two adaptations with the same title', async () => {
  const { results } = await tmdb('/search/movie', { query: 'Dune', include_adult: 'false' })
  const versions = objects(results).filter((item) => item.title === 'Dune')
  assert.ok(versions.some((item) => item.id === 841 && tmdbYear(item.release_date) === '1984'), 'Missing Dune (1984)')
  assert.ok(versions.some((item) => item.id === 438631 && tmdbYear(item.release_date) === '2021'), 'Missing Dune (2021)')
})

test('TMDB finds the anime film and series by their original titles', async () => {
  const film = await tmdb('/search/movie', { query: '千と千尋の神隠し', include_adult: 'false' })
  const series = await tmdb('/search/tv', { query: '葬送のフリーレン', include_adult: 'false' })
  assert.ok(objects(film.results).some((item) => item.id === 129 && isJapaneseAnimation(item)), 'Missing Spirited Away or its classification fields')
  assert.ok(objects(series.results).some((item) => item.id === 209867 && isJapaneseAnimation(item)), 'Missing Frieren or its classification fields')
})

test('TMDB returns numbered specials and regular episodes with provider IDs', async () => {
  const series = await tmdb('/tv/57243')
  const seasons = objects(series.seasons).map((item) => item.season_number)
  assert.ok(seasons.includes(0) && seasons.includes(1) && seasons.includes(2), 'Doctor Who needs specials and multiple regular seasons')
  for (const [id, season] of [[57243, 0], [57243, 2], [209867, 0]]) {
    const { episodes } = await tmdb(`/tv/${id}/season/${season}`)
    assert.ok(objects(episodes).some((item) => (
      item.season_number === season && Number.isInteger(item.id) && Number.isInteger(item.episode_number)
    )), `No numbered episodes for TMDB series ${id}, season ${season}`)
  }
})

test('TMDB catalog permits absent artwork and unavailable regular episode counts', async () => {
  const { results } = await tmdb('/discover/tv', {
    sort_by: 'first_air_date.desc',
    'first_air_date.gte': new Date().toISOString().slice(0, 10),
    include_adult: 'false',
  })
  const withoutPoster = objects(results).filter((item) => Number.isInteger(item.id) && !item.poster_path)
  assert.ok(withoutPoster.length, 'No missing-poster series in this sample. Refresh the representative sample.')
  let foundUnknownTotal = false
  for (const item of withoutPoster.slice(0, 3)) {
    const series = await tmdb(`/tv/${item.id}`)
    if (Number(series.number_of_episodes ?? 0) === 0 ||
      series.status === 'In Production' || series.status === 'Planned') {
      foundUnknownTotal = true
      break
    }
  }
  assert.ok(foundUnknownTotal, 'No missing-poster series without a known final total in this sample.')
})

test('IGDB distinguishes same-name games and supports a missing cover', async () => {
  const clientId = credential('IGDB_CLIENT_ID')
  const token = await appToken(clientId, credential('IGDB_CLIENT_SECRET'))
  const games = await igdb(clientId, token, 'search "Prey"; fields name,first_release_date,cover; limit 30;')
  const exact = games.filter((game) => game.name === 'Prey' && Number.isInteger(game.id))
  const original = exact.find((game) => igdbYear(game.first_release_date) === 2006)
  const reboot = exact.find((game) => igdbYear(game.first_release_date) === 2017)
  assert.ok(original && reboot && original.id !== reboot.id, 'Expected distinct IGDB IDs for Prey (2006) and Prey (2017)')
  const missing = await igdb(clientId, token, 'fields name,cover; where cover = null & first_release_date != null; limit 1;')
  assert.ok(missing.some((game) => Number.isInteger(game.id) && !game.cover), 'No missing-cover game in this sample')
})
