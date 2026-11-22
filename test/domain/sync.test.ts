import { describe, expect, it } from 'vitest'
import { clampTime, mergeChange, syncChangeSchema } from '../../src/domain/sync'
import type { EntryData, SyncChange } from '../../src/domain/sync'

const empty = { at: 0 }
function entryData(groups: Partial<EntryData['groups']> = {}, extra: Partial<EntryData> = {}): EntryData {
  return {
    format: 'MOVIE', anime: false, createdAt: 100,
    groups: { progress: { ...empty }, liked: { ...empty }, rating: { ...empty }, watchlisted: { ...empty }, label: { ...empty }, ...groups },
    ...extra,
  }
}
const entryChange = (extra: Partial<EntryData> = {}, groups: Partial<EntryData['groups']> = {}): SyncChange =>
  ({ kind: 'entry', id: 'm1', data: entryData(groups, extra), at: 0 })
const entry = (groups: Partial<EntryData['groups']> = {}, extra: Partial<EntryData> = {}): SyncChange => {
  const data = entryData(groups, extra)
  return { kind: 'entry', id: 'm1', data, at: Math.max(...Object.values(data.groups).map((g) => g.at)) }
}

const groupsOf = (change: SyncChange) => (change.data as EntryData).groups

describe('mergeChange', () => {
  it('keeps each group from whichever side changed it last', () => {
    const a = entry({ liked: { value: true, at: 10 }, rating: { value: 3, at: 5 } })
    const b = entry({ liked: { value: false, at: 4 }, rating: { value: 5, at: 9 } })
    const merged = mergeChange(a, b)
    expect(groupsOf(merged)).toMatchObject({ liked: { value: true, at: 10 }, rating: { value: 5, at: 9 } })
    expect(merged.at).toBe(10)
  })

  it('keeps incoming on a group tie', () => {
    const merged = mergeChange(entry({ rating: { value: 3, at: 5 } }), entry({ rating: { value: 4, at: 5 } }))
    expect(groupsOf(merged).rating.value).toBe(4)
  })

  it('takes top-level fields from the side with the highest group time and the earliest createdAt', () => {
    const a = entry({ rating: { value: 3, at: 5 } }, { format: 'SERIES', createdAt: 50 })
    const b = entry({ rating: { value: 4, at: 9 } }, { format: 'MOVIE', createdAt: 70 })
    expect(mergeChange(a, b).data).toMatchObject({ format: 'MOVIE', createdAt: 50 })
    expect(mergeChange(b, a).data).toMatchObject({ format: 'MOVIE', createdAt: 50 })
  })

  it('keeps a catalogRef that only the older side has', () => {
    const known = entry({ rating: { value: 3, at: 5 } }, { catalogRef: 'tmdb:movie:1' })
    const restored = entry({ rating: { value: 4, at: 9 } })
    expect(mergeChange(known, restored).data).toMatchObject({ catalogRef: 'tmdb:movie:1' })
    expect(mergeChange(restored, known).data).toMatchObject({ catalogRef: 'tmdb:movie:1' })
  })

  it('tombstone versus later edit', () => {
    const removed = { kind: 'entry', id: 'm1', data: null, at: 20 } as const
    expect(mergeChange(removed, entry({ rating: { value: 4, at: 30 } })).data).not.toBeNull()
    expect(mergeChange(entry({ rating: { value: 4, at: 10 } }), removed).data).toBeNull()
    expect(mergeChange(removed, entry({ rating: { value: 4, at: 10 } })).data).toBeNull()
    expect(mergeChange(entry({ rating: { value: 4, at: 30 } }), removed).data).not.toBeNull()
  })

  it('takes incoming when there is no current change', () => {
    const incoming = entry({ rating: { value: 4, at: 3 } })
    expect(mergeChange(undefined, incoming)).toEqual(incoming)
  })

  it('never resurrects or drops a completion except by its own tombstone', () => {
    const done = { kind: 'completion', id: 'c1', data: { mediaId: 'm1', date: '2026-11-21' }, at: 5 } as const
    expect(mergeChange(done, { ...done, at: 1 })).toEqual(done)
    expect(mergeChange(done, { ...done, data: { mediaId: 'm1', date: '2026-11-22' } })).toEqual(done)
    expect(mergeChange(done, { ...done, data: null, at: 6 }).data).toBeNull()
  })

  it('lets the later episode change win', () => {
    const watched = { kind: 'episode', id: 'm1:1:2', data: { mediaId: 'm1', season: 1, number: 2, watched: true }, at: 5 } as const
    const unwatched = { ...watched, data: { ...watched.data, watched: false }, at: 8 }
    expect(mergeChange(watched, unwatched)).toEqual(unwatched)
    expect(mergeChange(unwatched, watched)).toEqual(unwatched)
  })
})

describe('clampTime', () => {
  it('clamps future timestamps', () => {
    expect(clampTime(10_000_000, 1_000)).toBe(61_000)
    expect(clampTime(500, 1_000)).toBe(500)
  })
})

describe('syncChangeSchema', () => {
  it('accepts valid changes', () => {
    expect(syncChangeSchema.safeParse(entryChange({ catalogRef: 'tmdb:movie:603' })).success).toBe(true)
    expect(syncChangeSchema.safeParse(entryChange({ format: 'BOOK', bookType: 'Manga' })).success).toBe(true)
    expect(syncChangeSchema.safeParse({ kind: 'entry', id: 'm1', data: null, at: 1 }).success).toBe(true)
    expect(syncChangeSchema.safeParse({ kind: 'completion', id: 'c1', data: { mediaId: 'm1', date: '2026-11-21' }, at: 1 }).success).toBe(true)
    expect(syncChangeSchema.safeParse({ kind: 'episode', id: 'm1:1:2', data: { mediaId: 'm1', season: 1, number: 2, watched: true }, at: 1 }).success).toBe(true)
  })

  it('rejects a malformed catalogRef and an over-long label', () => {
    expect(syncChangeSchema.safeParse(entryChange({ catalogRef: 'tmdb:nope' })).success).toBe(false)
    expect(syncChangeSchema.safeParse(entryChange({}, { label: { value: 'x'.repeat(181), at: 0 } })).success).toBe(false)
    expect(syncChangeSchema.safeParse(entryChange({}, { label: { value: 'x'.repeat(180), at: 0 } })).success).toBe(true)
  })

  it('rejects an unknown bookType, bad rating, bad date and unknown fields', () => {
    expect(syncChangeSchema.safeParse(entryChange({ bookType: 'Poem' as never })).success).toBe(false)
    expect(syncChangeSchema.safeParse(entryChange({}, { rating: { value: 6, at: 0 } })).success).toBe(false)
    expect(syncChangeSchema.safeParse({ kind: 'completion', id: 'c1', data: { mediaId: 'm1', date: '2026-02-31' }, at: 1 }).success).toBe(false)
    expect(syncChangeSchema.safeParse({ ...entryChange(), extra: 1 }).success).toBe(false)
  })
})
