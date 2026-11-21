import { describe, expect, it } from 'vitest'
import type { LibraryEntry, Media } from './media'
import { badges, buildProfile, compare, decodeProfile, earned, encodeProfile, itemMedia, streak } from './share'

const movie = (id: string, title: string, extra: Partial<Media> = {}): Media => ({ id, title, format: 'MOVIE', anime: false, genres: [], description: '', ...extra } as Media)
const entry = (media: Media, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({
  media, status: 'Completed', completions: [], watched: [], unwatched: [], updatedAt: 1, ...extra,
})

describe('share', () => {
  const mine = [
    entry(movie('tmdb:movie:1', 'Alpha', { identity: { provider: 'tmdb', entity: 'movie', id: '1' }, poster: 'https://image.tmdb.org/t/p/w342/a.jpg' }), { rating: 5 }),
    entry(movie('tmdb:movie:2', 'Beta', { identity: { provider: 'tmdb', entity: 'movie', id: '2' }, poster: 'https://evil.example/x.jpg' }), { rating: 1 }),
    entry(movie('planned', 'Planned only'), { status: 'Planned' }),
  ]

  it('round-trips a profile through the link and drops unsafe posters and unseen titles', async () => {
    const profile = buildProfile(mine, '  Sam ', () => true)
    expect(profile.n).toBe('Sam')
    expect(profile.i.map((item) => item.k)).toEqual(['tmdb:movie:1', 'tmdb:movie:2'])
    expect(profile.i[1].p).toBeUndefined()
    const decoded = await decodeProfile(await encodeProfile(profile))
    expect(decoded).toEqual(profile)
    expect(itemMedia(decoded.i[0])).toMatchObject({ format: 'MOVIE', identity: { provider: 'tmdb', id: '1' } })
  })

  it('shares only titles a friend can resolve', () => {
    expect(buildProfile([entry(movie('manual-id', 'Manual entry'))]).i).toEqual([])
  })

  it('rejects tampered or hostile links', async () => {
    await expect(decodeProfile('not base64!')).rejects.toThrow('not valid')
    await expect(decodeProfile('AAAA')).rejects.toThrow('not valid')
    const hostile = await encodeProfile({ v: 1, b: [], i: [{ k: 'x', t: 'X', f: 'M', p: 'javascript:alert(1)' }] } as never)
    await expect(decodeProfile(hostile)).rejects.toThrow('not valid')
  })

  it('scores overlap scaled by rating agreement and lists their unseen picks best first', () => {
    const theirs = { v: 1 as const, b: [], i: [
      { k: 'tmdb:movie:1', t: 'Alpha', f: 'M' as const, r: 5 as const },
      { k: 'tmdb:movie:2', t: 'Beta', f: 'M' as const, r: 5 as const },
      { k: 'tmdb:movie:3', t: 'Gamma', f: 'M' as const, r: 3 as const },
      { k: 'tmdb:movie:4', t: 'Delta', f: 'M' as const, r: 5 as const },
    ] }
    const result = compare(mine, theirs)
    expect(result.shared.map((item) => item.t)).toEqual(['Alpha', 'Beta'])
    expect(result.picks.map((item) => item.t)).toEqual(['Delta', 'Gamma'])
    // overlap 2/2 = 1; agreement mean(1, 0) = 0.5 → 100 × 1 × 0.75
    expect(result.match).toBe(75)
    expect(compare([], theirs).match).toBe(0)
  })

  it('earns badges and counts weekly streaks ending this week or last', () => {
    const done = (date: string) => ({ id: date, date })
    const library = [
      entry(movie('a', 'A'), { completions: [done('2026-11-18'), done('2026-11-02')] }),
      entry(movie('b', 'B'), { completions: [done('2026-11-10')] }),
    ]
    expect(earned(badges(library)).map((badge) => badge.id)).toEqual(['first', 'encore'])
    expect(streak(library, '2026-11-21')).toBe(3) // weeks of Nov 16, Nov 9, Nov 2
    expect(streak(library, '2026-11-25')).toBe(3) // nothing yet this week: still counts through last week
    expect(streak(library, '2026-12-02')).toBe(0)
  })
})
