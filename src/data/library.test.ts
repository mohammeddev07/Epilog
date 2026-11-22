import 'fake-indexeddb/auto'
import { Dexie } from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { parseBackup } from '../domain/backup-file'
import { episodeWatchState, isWatchlisted, manualEpisode } from '../domain/media'
import type { Media } from '../domain/media'
import { demoCatalog } from './demo'
import { createLibrary } from './library'
import type { LibraryStore } from './library'

const film = demoCatalog.find(({ id }) => id === 'the-last-signal')!
const game = demoCatalog.find(({ format }) => format === 'GAME')!
const anime = demoCatalog.find(({ format, anime }) => format === 'SERIES' && anime)!
const databases: LibraryStore[] = []

function open(name = crypto.randomUUID(), clock?: () => number) {
  const store = createLibrary(name, clock)
  databases.push(store)
  return store
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((store) => store.deleteDatabase()))
})

describe('IndexedDB library', () => {
  it('upgrades a version-one library while preserving its tracking data', async () => {
    const name = crypto.randomUUID()
    const original = new Dexie(name)
    original.version(1).stores({
      media: 'id', entries: 'mediaId,status,updatedAt', completions: 'id,mediaId',
      episodes: '[mediaId+season+number],mediaId', catalog: 'key,&mediaId,expiresAt',
    })
    await original.table('media').put({ id: game.id, format: 'GAME', anime: false })
    await original.table('entries').put({ mediaId: game.id, status: 'In progress', createdAt: 1, updatedAt: 2, playtimeMinutes: 150 })
    original.close()

    const upgraded = open(name)
    expect((await upgraded.read()).get(game.id)).toMatchObject({ status: 'In progress', playtimeMinutes: 150 })
    await upgraded.cacheResponse('search/igdb:game', 'igdb', { items: [] })
    expect((await upgraded.readResponse('search/igdb:game'))?.payload).toEqual({ items: [] })
  })

  it('bounds its cache and ignores expired data', async () => {
    let now = 1000
    const store = open(undefined, () => now)
    for (let index = 0; index < 65; index++) {
      await store.cacheResponse(String(index), 'tmdb', { items: [] })
      now++
    }
    expect(await store.readResponse('0')).toBeUndefined()
    expect(await store.readResponse('64')).toBeDefined()
    now += 24 * 60 * 60_000
    expect(await store.readResponse('64')).toBeUndefined()
    await store.purgeExpired()
  })

  it('reopens persisted entries and stores one completion per operation under concurrent saves', async () => {
    const name = crypto.randomUUID()
    const original = open(name)
    const event = { id: 'operation-1', date: '2026-11-18' }
    await Promise.all([
      original.save(film, { status: 'Completed', completion: event }),
      original.save(film, { status: 'Completed', completion: event }),
    ])
    original.close()
    const reopened = open(name)
    const entries = await reopened.read()
    expect(entries.size).toBe(1)
    expect(entries.get(film.id)?.completions).toEqual([event])
  })

  it('completes a title once with the local date and retains game hours', async () => {
    const store = open(undefined, () => new Date(2026, 10, 19, 23).getTime())
    await store.save(game, { status: 'In progress', playtimeMinutes: 90 })
    const results = await Promise.all([store.completeToday(game), store.completeToday(game)])
    expect(results.map(({ changed }) => changed)).toEqual([true, false])
    const entry = (await store.read()).get(game.id)
    expect(entry).toMatchObject({ status: 'Completed', playtimeMinutes: 90, completions: [{ date: '2026-11-19' }] })
  })

  it('removes the latest watch, keeping earlier ones, progress and preferences', async () => {
    const store = open()
    await store.completeToday(film)
    expect(await store.uncomplete(film)).toMatchObject({ removed: true }) // a lone watch leaves nothing behind
    expect((await store.read()).size).toBe(0)

    await store.save(film, { status: 'Completed', completion: { id: 'first', date: '2024-01-02' } })
    await store.save(film, { status: 'Completed', completion: { id: 'rewatch', date: '2026-03-04' } })
    await store.savePreference(film, { kind: 'like', value: true })
    await store.uncomplete(film)
    expect((await store.read()).get(film.id)).toMatchObject({ status: 'Completed', liked: true, completions: [{ id: 'first' }] })
    await store.uncomplete(film)
    expect((await store.read()).get(film.id)).toMatchObject({ status: undefined, liked: true, completions: [] })

    await store.save(game, { status: 'In progress', playtimeMinutes: 90 })
    await store.completeToday(game)
    await store.uncomplete(game)
    expect((await store.read()).get(game.id)).toMatchObject({ status: 'In progress', playtimeMinutes: 90, completions: [] })
  })

  it('rolls back a new entry when its completion ID conflicts with another title', async () => {
    const store = open()
    const completion = { id: 'shared-event', date: '2026-11-18' }
    await store.save(film, { status: 'Completed', completion })
    await expect(store.save(game, { status: 'Completed', completion })).rejects.toThrow()
    expect([...await store.read()].map(([id]) => id)).toEqual([film.id])
  })

  it('stores likes, ratings, and watchlist choices independently of viewing history', async () => {
    const store = open()
    await Promise.all([
      store.savePreference(film, { kind: 'like', value: true }),
      store.savePreference(film, { kind: 'rating', value: 4 }),
      store.savePreference(film, { kind: 'watchlist', value: true }),
    ])
    const first = (await store.read()).get(film.id)
    expect(first).toMatchObject({ liked: true, rating: 4, watchlisted: true, completions: [] })
    expect(first?.status).toBeUndefined()
    const completion = { id: 'watch-event', date: '2026-11-19' }
    await store.save(film, { status: 'Completed', completion })
    await store.savePreference(film, { kind: 'watchlist', value: false })
    const entry = (await store.read()).get(film.id)
    expect(entry).toMatchObject({ status: 'Completed', completions: [completion], liked: true, rating: 4 })
    expect(isWatchlisted(entry)).toBe(false)
    await store.savePreference(film, { kind: 'rating', value: null })
    expect((await store.read()).get(film.id)?.rating).toBeUndefined()
  })

  it('round-trips preferences in v2 backups and preserves them when applying a v1 backup', async () => {
    const source = open()
    await source.savePreference(game, { kind: 'like', value: true })
    await source.savePreference(game, { kind: 'rating', value: 5 })
    await source.savePreference(game, { kind: 'watchlist', value: false })
    const serialized = JSON.stringify(await source.exportBackup())
    expect(() => parseBackup(serialized.replace('"rating":5', '"rating":6'))).toThrow('supported Epilog backup')
    const target = open()
    await target.applyRestore(await target.previewRestore(parseBackup(serialized)), false)
    const legacy = parseBackup(JSON.stringify({
      format: 'epilog-library', version: 1,
      entries: [{ media: { id: game.id, format: 'GAME', anime: false }, status: 'Planned', createdAt: 1, updatedAt: 2, completions: [], episodes: [] }],
    }))
    await target.applyRestore(await target.previewRestore(legacy), true)
    expect((await target.read()).get(game.id)).toMatchObject({ status: 'Planned', liked: true, rating: 5, watchlisted: false })
  })

  it('stores manual watched and unwatched episode choices and removes dependent records', async () => {
    const store = open()
    await store.save(anime, { status: 'Planned' })
    const episode = manualEpisode({ season: 4, number: 7 })
    await store.setEpisode(anime.id, episode, true)
    expect((await store.read()).get(anime.id)).toMatchObject({ watched: [episode], status: 'In progress' })
    await store.setEpisode(anime.id, episode, false)
    expect((await store.exportBackup()).entries[0].episodes).toEqual([expect.objectContaining({ season: 4, number: 7, watched: false })])
    await store.remove(anime.id)
    expect((await store.exportBackup()).entries).toEqual([])
    await store.save(anime, { status: 'Planned' })
    expect((await store.exportBackup()).entries[0].episodes).toEqual([])
  })

  it('marks a whole season watched or unwatched in one call', async () => {
    const store = open()
    await store.save(anime, { status: 'Planned' })
    const season = [1, 2, 3].map((number) => manualEpisode({ season: 1, number }))
    await store.setEpisode(anime.id, season, true)
    const entry = (await store.read()).get(anime.id)!
    expect(entry.status).toBe('In progress')
    expect(entry.watched.map(({ number }) => number).sort()).toEqual([1, 2, 3])
    await store.setEpisode(anime.id, season, false)
    expect((await store.read()).get(anime.id)!.watched).toEqual([])
    expect((await store.exportBackup()).entries[0].episodes).toHaveLength(3)
  })

  it('restores legacy series completions and retains episode overrides until another completion is logged', async () => {
    const store = open()
    const episode = manualEpisode({ season: 1, number: 2 })
    const completion = { id: 'first-watch', date: '2026-11-18' }
    const legacy = parseBackup(JSON.stringify({
      format: 'epilog-library', version: 1, entries: [{
        media: { id: anime.id, format: 'SERIES', anime: true }, status: 'Completed', createdAt: 1, updatedAt: 2,
        completions: [completion], episodes: [],
      }],
    }))
    await store.applyRestore(await store.previewRestore(legacy), false)
    const readWatched = async () => episodeWatchState((await store.read()).get(anime.id)!)(episode)
    expect(await readWatched()).toBe(true)

    await store.setEpisode(anime.id, episode, false)
    await store.save(anime, { status: 'Completed', completion })
    expect(await readWatched()).toBe(false)
    const snapshot = parseBackup(JSON.stringify(await store.exportBackup()))
    expect(snapshot.entries[0].episodes).toMatchObject([{ season: 1, number: 2, watched: false }])

    const again = { id: 'second-watch', date: '2026-11-19' }
    await store.save(anime, { status: 'Completed', completion: again })
    expect(await readWatched()).toBe(true)
    expect((await store.read()).get(anime.id)?.completions).toEqual([completion, again])
  })

  it('excludes provider material from backups and keeps activity after cached catalog links expire', async () => {
    let now = 1000
    const store = open(undefined, () => now)
    const media: Media = {
      ...game,
      id: 'igdb:game:123',
      identity: { provider: 'igdb', entity: 'game', id: '123' },
      title: 'Provider-supplied title',
      description: 'Provider-supplied description',
      poster: 'https://images.example/cover.jpg',
    }
    const { id } = await store.save(media, { status: 'In progress', label: 'My game', playtimeMinutes: 60 })
    expect(id).not.toBe(media.id)
    expect((await store.save(media, { status: 'In progress', playtimeMinutes: 120 })).id).toBe(id)
    expect((await store.read()).get(id)?.media.title).toBe(media.title)
    const serialized = JSON.stringify(await store.exportBackup())
    expect(serialized).not.toMatch(/Provider-supplied|igdb|images\.example/)
    expect(parseBackup(serialized).entries[0].media).toMatchObject({ id, label: 'My game' })
    now += 24 * 60 * 60_000
    await store.purgeExpired()
    expect((await store.read()).get(id)).toMatchObject({ media: { title: 'My game' }, playtimeMinutes: 120 })
  })

  it('restores history without duplicates and keeps current conflicting fields by default', async () => {
    const source = open()
    await source.save(game, { status: 'Completed', completion: { id: 'first-event', date: '2026-11-18' }, playtimeMinutes: 60 })
    await source.save(game, { status: 'Completed', completion: { id: 'repeat-event', date: '2026-11-18' }, playtimeMinutes: 90 })
    const backup = parseBackup(JSON.stringify(await source.exportBackup()))

    const target = open()
    await target.save(game, { status: 'In progress', playtimeMinutes: 120 })
    const preview = await target.previewRestore(backup)
    expect(preview).toMatchObject({ newCount: 0, duplicateCount: 1, conflicts: [expect.anything(), expect.anything()] })
    expect(await target.applyRestore(preview, false)).toBe(1)
    expect((await target.read()).get(game.id)).toMatchObject({ status: 'In progress', playtimeMinutes: 120, completions: expect.arrayContaining(backup.entries[0].completions) })
    expect(await target.applyRestore(await target.previewRestore(backup), false)).toBe(0)
    expect(await target.applyRestore(await target.previewRestore(backup), true)).toBe(1)
    expect((await target.read()).get(game.id)).toMatchObject({ status: 'Completed', playtimeMinutes: 90 })
  })

  it('rejects stale restore previews and malformed dates without replacing a newer write', async () => {
    const store = open()
    await store.save(film, { status: 'Completed', completion: { id: 'film-event', date: '2026-11-18' } })
    const backup = await store.exportBackup()
    const preview = await store.previewRestore(backup)
    await store.save(film, { status: 'Dropped' })
    await expect(store.applyRestore(preview, true)).rejects.toThrow('changed after the preview')
    expect(() => parseBackup(JSON.stringify(backup).replace('2026-11-18', '2026-11-31'))).toThrow('supported Epilog backup')
    expect((await store.read()).get(film.id)?.status).toBe('Dropped')
  })
})
