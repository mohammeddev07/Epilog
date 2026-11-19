import type { CatalogIdentity } from './identity'

export const categories = ['All', 'Movies', 'TV Shows', 'Anime', 'Games'] as const
export type Category = (typeof categories)[number]

export const statuses = ['Planned', 'In progress', 'Completed', 'Dropped'] as const
export type Status = (typeof statuses)[number]

export const ratings = [1, 2, 3, 4, 5] as const
export type Rating = (typeof ratings)[number]

export interface TitlePreferences {
  liked?: boolean
  rating?: Rating
  watchlisted?: boolean
}

export type PreferenceChange =
  | { kind: 'like'; value: boolean }
  | { kind: 'rating'; value: Rating | null }
  | { kind: 'watchlist'; value: boolean }

export interface EpisodePosition {
  season: number
  number: number
}

export interface Season {
  number: number
  episodeCount?: number
}

export interface Episode extends EpisodePosition {
  title: string
  externalId?: string
  airDate?: string
}

interface MediaFields {
  id: string
  title: string
  year?: number
  genres: readonly string[]
  description: string
  poster?: string
  aliases?: readonly string[]
  identity?: CatalogIdentity
  catalogedAt?: number
}

export type Media = MediaFields & (
  | { format: 'MOVIE'; anime: boolean }
  | { format: 'SERIES'; anime: boolean; episodes?: readonly Episode[]; seasons?: readonly Season[]; episodeTotal?: number }
  | { format: 'GAME'; anime?: never }
)

export interface Completion {
  id: string
  date: string
}

export interface LibraryEntry extends TitlePreferences {
  media: Media
  status?: Status
  completions: readonly Completion[]
  playtimeMinutes?: number
  watched: readonly Episode[]
  unwatched: readonly EpisodePosition[]
  updatedAt: number
  label?: string
}

export interface LogDraft {
  status: Status
  completion?: Completion
  playtimeMinutes?: number
  label?: string
}

export const titleLengthLimit = 180

export function isWatchlisted(entry?: LibraryEntry) {
  return entry?.watchlisted ?? entry?.status === 'Planned'
}

export function primaryCategory(media: Media): Exclude<Category, 'All'> {
  if (media.anime) return 'Anime'
  if (media.format === 'MOVIE') return 'Movies'
  if (media.format === 'SERIES') return 'TV Shows'
  return 'Games'
}

export function inCategory(media: Media, category: Category) {
  return category === 'All' ||
    (category === 'Anime' && media.anime === true) ||
    (category === 'Movies' && media.format === 'MOVIE') ||
    (category === 'TV Shows' && media.format === 'SERIES' && !media.anime) ||
    (category === 'Games' && media.format === 'GAME')
}

export function trackingAction(media: Media, entry?: LibraryEntry) {
  const completed = entry?.status === 'Completed'
  return media.format === 'GAME' ? (completed ? 'Played' : 'Play') : (completed ? 'Watched' : 'Watch')
}

export function formatLabel(media: Media) {
  if (media.anime) return media.format === 'MOVIE' ? 'Anime film' : 'Anime series'
  if (media.format === 'MOVIE') return 'Movie'
  if (media.format === 'SERIES') return 'TV show'
  return 'Game'
}

function normalize(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim()
}

export function matchesQuery(media: Media, query: string) {
  const searchable = normalize([media.title, media.year ?? '', ...(media.aliases ?? [])].join(' '))
  return normalize(query).split(/\s+/).every((word) => searchable.includes(word))
}

export function episodeKey(episode: EpisodePosition) {
  return `${episode.season}:${episode.number}`
}

export function manualEpisode(position: EpisodePosition): Episode {
  return { ...position, title: `Episode ${position.number}` }
}

export function isEpisodePosition(position: EpisodePosition) {
  return Number.isSafeInteger(position.season) && position.season >= 0 &&
    Number.isSafeInteger(position.number) && position.number >= 1
}

function seriesCompletionDate(entry: LibraryEntry) {
  return entry.completions.reduce((latest, { date }) => date > latest ? date : latest, '') ||
    (entry.status === 'Completed' ? localDate(new Date(entry.updatedAt)) : '')
}

export function episodeWatchState(entry: LibraryEntry) {
  const watched = new Set(entry.watched.map(episodeKey))
  const unwatched = new Set(entry.unwatched.map(episodeKey))
  const completedThrough = seriesCompletionDate(entry)
  return (episode: Episode) => {
    const key = episodeKey(episode)
    return watched.has(key) || Boolean(completedThrough && !unwatched.has(key) &&
      (!episode.airDate || episode.airDate <= completedThrough))
  }
}

export function nextEpisode(entry: LibraryEntry) {
  if (entry.media.format !== 'SERIES' || entry.status === 'Completed') return undefined
  const isWatched = episodeWatchState(entry)
  return entry.media.episodes?.find((episode) => episode.season > 0 && !isWatched(episode))
}

const hoursFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

export function progressText(entry: LibraryEntry) {
  if (entry.media.format === 'GAME' && entry.playtimeMinutes !== undefined) {
    return `${hoursFormatter.format(entry.playtimeMinutes / 60)} hr played`
  }
  if (entry.media.format === 'SERIES') {
    const episodes = entry.media.episodes ?? []
    const hasCompletion = entry.completions.length > 0
    if (entry.status === 'Completed' || (!episodes.length && hasCompletion)) return entry.status ?? 'Saved'
    const watchedKeys = new Set(entry.watched.filter((episode) => episode.season > 0).map(episodeKey))
    if (hasCompletion) {
      const isWatched = episodeWatchState(entry)
      for (const episode of episodes) {
        if (episode.season > 0 && isWatched(episode)) watchedKeys.add(episodeKey(episode))
      }
    }
    const watched = watchedKeys.size
    return entry.media.episodeTotal === undefined || watched > entry.media.episodeTotal
      ? `${watched} ${watched === 1 ? 'episode' : 'episodes'} watched`
      : `${watched} of ${entry.media.episodeTotal} episodes`
  }
  return entry.status ?? 'Saved'
}

export function localDate(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

export function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function displayDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00Z`))
}

export function parseHours(value: string) {
  if (!value.trim()) return undefined
  const hours = Number(value)
  const minutes = Math.round(hours * 60)
  if (hours < 0 || !Number.isSafeInteger(minutes)) {
    throw new Error('Enter a valid total number of hours.')
  }
  return minutes
}

export function updateEntry(media: Media, current: LibraryEntry | undefined, draft: LogDraft, now: number): LibraryEntry {
  const completions = current?.completions ?? []
  const completion = draft.completion
  if (draft.status === 'Completed' && completion && !isCalendarDate(completion.date)) {
    throw new Error('Choose a valid completion date.')
  }
  if (draft.playtimeMinutes !== undefined &&
    (!Number.isSafeInteger(draft.playtimeMinutes) || draft.playtimeMinutes < 0)) {
    throw new Error('Enter a valid total number of hours.')
  }
  const label = draft.label === undefined ? current?.label : draft.label.trim() || undefined
  if (label && label.length > titleLengthLimit) throw new Error('Choose a shorter backup label.')
  const addsCompletion = draft.status === 'Completed' && completion && !completions.some(({ id }) => id === completion.id)
  const completesSeries = media.format === 'SERIES' && draft.status === 'Completed' && (current?.status !== 'Completed' || addsCompletion)
  return {
    liked: current?.liked,
    rating: current?.rating,
    watchlisted: current?.watchlisted,
    media,
    status: draft.status,
    completions: addsCompletion ? [...completions, completion] : completions,
    playtimeMinutes: media.format === 'GAME' ? draft.playtimeMinutes : undefined,
    watched: current?.watched ?? [],
    unwatched: completesSeries ? [] : current?.unwatched ?? [],
    updatedAt: now,
    label,
  }
}

export function updatePreference(media: Media, current: LibraryEntry | undefined, change: PreferenceChange, now: number): LibraryEntry {
  const entry = current ?? { media, completions: [], watched: [], unwatched: [], updatedAt: now }
  switch (change.kind) {
    case 'like': return { ...entry, liked: change.value, updatedAt: now }
    case 'watchlist': return { ...entry, watchlisted: change.value, updatedAt: now }
    case 'rating':
      if (change.value !== null && !ratings.includes(change.value)) throw new Error('Choose a rating from 1 to 5 stars.')
      return { ...entry, rating: change.value ?? undefined, updatedAt: now }
  }
}

export function updateEpisode(entry: LibraryEntry, episode: Episode, watched: boolean, now: number): LibraryEntry {
  if (entry.media.format !== 'SERIES') throw new Error('Only series have episodes.')
  if (!isEpisodePosition(episode)) throw new Error('Choose a valid episode.')
  const key = episodeKey(episode)
  const episodes = entry.watched.filter((item) => episodeKey(item) !== key)
  const unwatched = entry.unwatched.filter((item) => episodeKey(item) !== key)
  return {
    ...entry,
    status: watched && (!entry.status || entry.status === 'Planned') ? 'In progress' : entry.status,
    watched: watched ? [...episodes, episode] : episodes,
    unwatched: watched ? unwatched : [...unwatched, { season: episode.season, number: episode.number }],
    updatedAt: now,
  }
}
