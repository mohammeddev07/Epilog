import type { CatalogIdentity } from './identity'

export const categories = ['All', 'Movies', 'TV Shows', 'Anime', 'Games'] as const
export type Category = (typeof categories)[number]

export const statuses = ['Planned', 'In progress', 'Completed', 'Dropped'] as const
export type Status = (typeof statuses)[number]

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

export interface LibraryEntry {
  media: Media
  status: Status
  completions: readonly Completion[]
  playtimeMinutes?: number
  watched: readonly Episode[]
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
    (category === 'TV Shows' && media.format === 'SERIES') ||
    (category === 'Games' && media.format === 'GAME')
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

export function nextEpisode(entry: LibraryEntry) {
  if (entry.media.format !== 'SERIES') return undefined
  const watched = new Set(entry.watched.map(episodeKey))
  return entry.media.episodes?.find((episode) => episode.season > 0 && !watched.has(episodeKey(episode)))
}

const hoursFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

export function progressText(entry: LibraryEntry) {
  if (entry.media.format === 'GAME' && entry.playtimeMinutes !== undefined) {
    return `${hoursFormatter.format(entry.playtimeMinutes / 60)} hr played`
  }
  if (entry.media.format === 'SERIES') {
    const watched = entry.watched.filter((episode) => episode.season > 0).length
    return entry.media.episodeTotal === undefined || watched > entry.media.episodeTotal
      ? `${watched} ${watched === 1 ? 'episode' : 'episodes'} watched`
      : `${watched} of ${entry.media.episodeTotal} episodes`
  }
  return entry.status
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
  return {
    media,
    status: draft.status,
    completions: addsCompletion ? [...completions, completion] : completions,
    playtimeMinutes: media.format === 'GAME' ? draft.playtimeMinutes : undefined,
    watched: current?.watched ?? [],
    updatedAt: now,
    label,
  }
}

export function updateEpisode(entry: LibraryEntry, episode: Episode, watched: boolean, now: number): LibraryEntry {
  if (entry.media.format !== 'SERIES') throw new Error('Only series have episodes.')
  if (!isEpisodePosition(episode)) throw new Error('Choose a valid episode.')
  const episodes = entry.watched.filter((item) => episodeKey(item) !== episodeKey(episode))
  return {
    ...entry,
    status: watched && entry.status === 'Planned' ? 'In progress' : entry.status,
    watched: watched ? [...episodes, episode] : episodes,
    updatedAt: now,
  }
}
