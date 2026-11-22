import { bookTypes } from './books'
// Library stats, computed only from what the library actually holds. Hours need a runtime; titles without
// one are counted in `missingRuntime` instead of being guessed.
import { isWatchlisted, localDate } from './media'
import type { LibraryEntry, Media } from './media'

export const kinds = ['Movies', 'TV shows', 'Anime', 'Games'] as const
export type Kind = (typeof kinds)[number]
export type Ranked = readonly (readonly [string, number])[]

const kindOf = (media: Exclude<Media, { format: 'BOOK' }>): Kind =>
  media.format === 'GAME' ? 'Games' : media.anime ? 'Anime' : media.format === 'MOVIE' ? 'Movies' : 'TV shows'
export const isFinished = (entry: LibraryEntry) => entry.status === 'Completed' || entry.completions.length > 0
const isSeen = (entry: LibraryEntry) => isFinished(entry) || entry.status === 'In progress'

/** Monday-based week number for a YYYY-MM-DD date (1970-01-01 was a Thursday). */
export const week = (date: string) => Math.floor((Date.parse(date + 'T00:00:00Z') / 86_400_000 + 3) / 7)

function episodesSeen(entry: LibraryEntry) {
  const media = entry.media
  if (media.format !== 'SERIES') return 0
  const listed = entry.watched.filter((episode) => episode.season > 0).length
  const total = media.episodeTotal ?? media.episodes?.filter((episode) => episode.season > 0).length
  return entry.status === 'Completed' && total ? Math.max(total, listed) : listed
}

/** Minutes spent, or undefined when the library doesn't know (no runtime, or no hours entered for a game). */
function minutesSpent(entry: LibraryEntry) {
  const { media } = entry
  if (media.format === 'GAME') return entry.playtimeMinutes
  if (!media.runtime) return undefined
  return media.format === 'MOVIE' ? media.runtime * Math.max(1, entry.completions.length) : media.runtime * episodesSeen(entry)
}

function rank(values: readonly string[], limit = 8): Ranked {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)
}

function longestRun(numbers: Set<number>) {
  let best = 0
  for (const start of numbers) {
    if (numbers.has(start - 1)) continue
    let length = 1
    while (numbers.has(start + length)) length++
    best = Math.max(best, length)
  }
  return best
}

export function libraryStats(entries: readonly LibraryEntry[], today = localDate()) {
  const seen = entries.filter(isSeen)
  const minutesByKind = Object.fromEntries(kinds.map((kind) => [kind, 0])) as Record<Kind, number>
  let missingRuntime = 0
  for (const entry of seen) {
    if (entry.media.format === 'BOOK') continue
    const minutes = minutesSpent(entry)
    if (minutes === undefined) {
      if (entry.media.format !== 'GAME') missingRuntime++
      continue
    }
    minutesByKind[kindOf(entry.media)] += minutes
  }
  const dates = entries.flatMap((entry) => entry.completions.map((completion) => completion.date))
  const rated = entries.flatMap((entry) => entry.rating ?? [])
  const backlog = entries.filter((entry) => isWatchlisted(entry) && !isFinished(entry))
  const backlogMinutes = backlog.reduce((sum, { media }) =>
    sum + (media.format === 'MOVIE' && media.runtime ? media.runtime
      : media.format === 'SERIES' && media.runtime && (media.episodeTotal ?? media.episodes?.length) ? media.runtime * (media.episodeTotal ?? media.episodes?.length ?? 0) : 0), 0)

  const books = entries.filter((entry) => entry.media.format === 'BOOK')
  const units = { page: 0, chapter: 0, volume: 0 }
  for (const { reading } of books) {
    if (reading) units[reading.unit] += reading.count
  }
  const reading = {
    units, titles: books.length, completed: books.filter(isFinished).length,
    byType: bookTypes.map((type) => {
      const titles = books.filter(({ media }) => media.format === 'BOOK' && media.bookType === type)
      return { type, titles: titles.length, completed: titles.filter(isFinished).length }
    }),
  }
  return {
    reading,
    finished: entries.filter(isFinished).length,
    watchMinutes: minutesByKind.Movies + minutesByKind['TV shows'] + minutesByKind.Anime,
    playMinutes: minutesByKind.Games,
    minutesByKind,
    missingRuntime,
    episodes: seen.reduce((sum, entry) => sum + episodesSeen(entry), 0),
    longestStreakWeeks: longestRun(new Set(dates.map(week))),
    finishedThisYear: new Set(entries.filter((entry) => entry.completions.some(({ date }) => date.slice(0, 4) === today.slice(0, 4))).map((entry) => entry.media.id)).size,
    rewatched: entries.filter((entry) => entry.media.format !== 'BOOK' && entry.completions.length > 1).length,
    averageRating: rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : undefined,
    backlogMinutes,
    busiestMonth: rank(dates.map((date) => date.slice(0, 7)), 1)[0] as readonly [string, number] | undefined,
    genres: rank(seen.flatMap((entry) => entry.media.genres)),
    countries: rank(seen.flatMap((entry) => entry.media.countries ?? [])),
    languages: rank(seen.flatMap((entry) => entry.media.language ?? [])),
    decades: rank(seen.flatMap((entry) => entry.media.year ? [`${Math.floor(entry.media.year / 10) * 10}s`] : []))
      .toSorted((a, b) => b[0].localeCompare(a[0])),
    ratings: ([5, 4, 3, 2, 1] as const).map((stars) => [`${stars} star${stars === 1 ? '' : 's'}`, entries.filter((entry) => entry.rating === stars).length] as const)
      .filter(([, count]) => count > 0),
    gameHours: entries.flatMap((entry) => entry.media.format === 'GAME' && entry.playtimeMinutes ? [[entry.media.title, entry.playtimeMinutes] as const] : [])
      .toSorted((a, b) => b[1] - a[1]).slice(0, 8),
  }
}
export type LibraryStats = ReturnType<typeof libraryStats>
