import { describe, expect, it } from 'vitest'
import { demoCatalog } from '../../src/data/demo'
import {
  episodeKey, episodeWatchState, inCategory, isCalendarDate, matchesQuery, nextEpisode, parseHours,
  progressText, updateEntry, updateEpisode,
} from '../../src/domain/media'

const film = demoCatalog.find(({ id }) => id === 'paper-moons')!
const game = demoCatalog.find(({ id }) => id === 'starlight-courier')!
const series = demoCatalog.find(({ format, anime }) => format === 'SERIES' && anime)!

describe('catalog and tracking rules', () => {
  it('finds alternate names and retains anime in both eligible categories', () => {
    expect(inCategory(film, 'All')).toBe(true)
    expect(inCategory(film, 'Anime')).toBe(true)
    expect(inCategory(film, 'Movies')).toBe(true)
    expect(inCategory(film, 'TV Shows')).toBe(false)
    expect(inCategory(series, 'TV Shows')).toBe(false)
    expect(inCategory(series, 'Anime')).toBe(true)
    expect(matchesQuery(series, 'chochin 2026')).toBe(true)
  })

  it('validates calendar dates and converts optional hours to whole minutes', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true)
    expect(isCalendarDate('2025-02-29')).toBe(false)
    expect(isCalendarDate('2024-02-31')).toBe(false)
    expect(parseHours('')).toBeUndefined()
    expect(parseHours('0')).toBe(0)
    expect(parseHours('12.5')).toBe(750)
    expect(() => parseHours('-0.0001')).toThrow('valid total')
    expect(() => parseHours('Infinity')).toThrow('valid total')
  })

  it('deduplicates retries, keeps distinct same-day completions, and preserves history through hours edits', () => {
    const status = 'Completed'
    const first = { id: 'first', date: '2026-11-18' }
    const second = { id: 'second', date: first.date }
    const initial = updateEntry(game, undefined, { status, completion: first }, 1)
    const retry = updateEntry(game, initial, { status, completion: first }, 2)
    const replay = updateEntry(game, retry, { status, completion: second }, 3)
    const edited = updateEntry(game, replay, { status, playtimeMinutes: 750 }, 4)
    expect(edited.completions).toEqual([first, second])
    expect(edited.playtimeMinutes).toBe(750)
  })

  it('updates and reverses series progress without inventing a total or completing a series', () => {
    const entry = updateEntry(series, undefined, { status: 'Planned' }, 1)
    const episode = nextEpisode(entry)!
    const watched = updateEpisode(entry, episode, true, 2)
    expect(watched.status).toBe('In progress')
    expect(progressText(watched)).toBe('1 episode watched')
    expect(episodeKey(nextEpisode(watched)!)).toBe('1:2')
    const reversed = updateEpisode(watched, episode, false, 3)
    expect(reversed.watched).toEqual([])
    expect(nextEpisode(reversed)).toEqual(episode)
  })

  it('uses a completion date for every known season and respects later manual edits', () => {
    const completed = updateEntry(series, undefined, {
      status: 'Completed', completion: { id: 'first-watch', date: '2026-11-18' },
    }, Date.UTC(2026, 10, 19))
    const sameDay = { season: 1, number: 3, title: 'Finale', airDate: '2026-11-18' }
    const olderSecondSeason = { season: 2, number: 1, title: 'Second season', airDate: '2026-11-16' }
    const later = { season: 2, number: 2, title: 'New episode', airDate: '2026-11-21' }
    expect([sameDay, olderSecondSeason, later].map(episodeWatchState(completed))).toEqual([true, true, false])
    expect(nextEpisode(completed)).toBeUndefined()
    expect(progressText(completed)).toBe('Completed')
    const edited = updateEpisode(completed, sameDay, false, completed.updatedAt + 1)
    expect(episodeWatchState(edited)(sameDay)).toBe(false)
    expect(episodeWatchState(edited)(olderSecondSeason)).toBe(true)
  })
})
