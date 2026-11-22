import { describe, expect, it } from 'vitest'
import type { Episode, LibraryEntry, Media } from '../../src/domain/media'
import { libraryStats } from '../../src/domain/stats'

const media = (fields: Partial<Media> & Pick<Media, 'format'>) => ({ id: fields.title ?? 'x', title: 'x', genres: [], description: '', anime: false, ...fields }) as Media
const entry = (m: Media, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({ media: m, status: 'Completed', completions: [], watched: [], unwatched: [], updatedAt: 1, ...extra })
const done = (date: string) => ({ id: date, date })
const ep = (season: number, number: number): Episode => ({ season, number, title: `E${number}` })

describe('libraryStats', () => {
  it('adds hours from runtimes and playtime, and counts what it cannot time instead of guessing', () => {
    const stats = libraryStats([
      entry(media({ title: 'Film', format: 'MOVIE', runtime: 120, genres: ['Drama'], countries: ['FR'], language: 'fr', year: 1999 }), { completions: [done('2026-11-02'), done('2026-11-09')], rating: 5 }),
      entry(media({ title: 'Show', format: 'SERIES', runtime: 30, genres: ['Drama', 'Comedy'], year: 2021 }), { status: 'In progress', watched: [ep(1, 1), ep(1, 2), ep(0, 1)] }),
      entry(media({ title: 'Anime', format: 'SERIES', anime: true, runtime: 24, episodeTotal: 12 } as Partial<Media> & { format: 'SERIES' })),
      entry(media({ title: 'Untimed', format: 'MOVIE' }), { completions: [done('2026-11-09')] }),
      entry(media({ title: 'Game', format: 'GAME' }), { status: 'In progress', playtimeMinutes: 450 }),
      entry(media({ title: 'Planned', format: 'MOVIE', runtime: 90 }), { status: 'Planned' }),
    ], '2026-11-21')
    expect(stats.minutesByKind).toEqual({ Movies: 240, 'TV shows': 60, Anime: 288, Games: 450 }) // rewatch counted twice; specials excluded
    expect(stats.watchMinutes).toBe(588)
    expect(stats.missingRuntime).toBe(1)
    expect(stats.finished).toBe(3)
    expect(stats.episodes).toBe(14)
    expect(stats.genres).toEqual([['Drama', 2], ['Comedy', 1]])
    expect(stats.countries).toEqual([['FR', 1]])
    expect(stats.decades).toEqual([['2020s', 1], ['1990s', 1]])
    expect(stats.ratings).toEqual([['5 stars', 1]])
    expect(stats.gameHours).toEqual([['Game', 450]])
    expect(stats.longestStreakWeeks).toBe(2)
    expect(stats.finishedThisYear).toBe(2)
    expect(stats.rewatched).toBe(1)
    expect(stats.averageRating).toBe(5)
    expect(stats.backlogMinutes).toBe(90) // the planned film, by runtime
    expect(stats.busiestMonth).toEqual(['2026-11', 3])
  })

  it('is empty for an empty library', () => {
    expect(libraryStats([])).toMatchObject({ finished: 0, watchMinutes: 0, genres: [], longestStreakWeeks: 0, averageRating: undefined, busiestMonth: undefined })
  })
})
