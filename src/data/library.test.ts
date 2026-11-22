import 'fake-indexeddb/auto'
import { Dexie } from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseBackup } from '../domain/backup-file'
import { episodeWatchState, isWatchlisted, manualEpisode } from '../domain/media'
import type { Media } from '../domain/media'
import { demoCatalog } from './demo'
import { createLibrary } from './library'
import type { LibraryStore } from './library'

const film = demoCatalog.find(({ id }) => id === 'the-last-signal')!
const game = demoCatalog.find(({ format }) => format === 'GAME')!
const anime = demoCatalog.find(({ format, anime }) => format === 'SERIES' && anime)!
const catalogGame: Media = { ...game, id: 'igdb:game:1942', identity: { provider: 'igdb', entity: 'game', id: '1942' } }
const catalogFilm: Media = { ...film, id: 'tmdb:movie:1', identity: { provider: 'tmdb', entity: 'movie', id: '1' } }
const account = { sub: 's1', email: 'a@example.test', name: 'A' }
const databases: LibraryStore[] = []

function open(name = crypto.randomUUID(), clock?: () => number, changed?: () => void) {
  const store = createLibrary(name, clock, changed)
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
    await original.table('catalog').put({ key: 'igdb:game:7', mediaId: game.id, media: game, expiresAt: 1 })
    original.close()

    const upgraded = open(name)
    expect((await upgraded.read()).get(game.id)).toMatchObject({ status: 'In progress', playtimeMinutes: 150 })
    await upgraded.cacheResponse('search/igdb:game', 'igdb', { items: [] })
    expect((await upgraded.readResponse('search/igdb:game'))?.payload).toEqual({ items: [] })
    expect(await upgraded.missingSnapshots()).toEqual([{ mediaId: game.id, catalogRef: 'igdb:game:7' }])
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

  it('keeps catalog IDs after the snapshot expires', async () => {
    let now = Date.now()
    const store = open(undefined, () => now)
    await store.savePreference(catalogGame, { kind: 'like', value: true })
    now += 2 * 24 * 60 * 60_000
    await store.purgeExpired()
    expect(await store.missingSnapshots()).toEqual([{ mediaId: expect.any(String), catalogRef: 'igdb:game:1942' }])
    const [[id, entry]] = await store.read()
    expect(entry.media.identity).toEqual(catalogGame.identity)
    expect((await store.savePreference(catalogGame, { kind: 'rating', value: 3 })).id).toBe(id)
    await store.storeSnapshot(id, { ...catalogGame, catalogedAt: now })
    expect(await store.missingSnapshots()).toEqual([])
  })

  it('queues changes only while signed in, folding repeat edits into one change', async () => {
    const store = open()
    await store.savePreference(film, { kind: 'like', value: true })
    expect(await store.pendingChanges(500)).toEqual([])
    await store.setAccount(account)
    expect(await store.account()).toMatchObject({ ...account, cursor: 0 })
    await store.savePreference(film, { kind: 'rating', value: 4 })
    await store.savePreference(film, { kind: 'rating', value: 5 })
    const changes = await store.pendingChanges(500)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ kind: 'entry', id: film.id, data: { groups: { liked: { value: true }, rating: { value: 5 } } } })
    await store.setCursor(7, 123)
    expect(await store.account()).toMatchObject({ cursor: 7, lastSyncAt: 123 })
    await store.setAccount(undefined)
    expect(await store.account()).toBeUndefined()
    expect(await store.lastSub()).toBe('s1')
    expect(await store.pendingChanges(500)).toEqual([])
    expect((await store.read()).size).toBe(1)
  })

  it('queues tombstones for a removed title and a removed watch', async () => {
    const store = open()
    await store.setAccount(account)
    await store.completeToday(film)
    const [completion] = (await store.read()).get(film.id)!.completions
    await store.uncomplete(film)
    const changes = await store.pendingChanges(500)
    expect(changes).toHaveLength(2)
    expect(changes).toEqual(expect.arrayContaining([
      { kind: 'completion', id: completion.id, data: null, at: expect.any(Number) },
      { kind: 'entry', id: film.id, data: null, at: expect.any(Number) },
    ]))
  })

  it('applyRemote rewrites a local id to the canonical id', async () => {
    const store = open()
    await store.setAccount(account)
    const completion = { id: 'c1', date: '2026-11-18' }
    const { id } = await store.save(catalogFilm, { status: 'Completed', completion })
    await store.applyRemote([], { [id]: 'm-canon' })
    const entries = await store.read()
    expect(entries.has(id)).toBe(false)
    expect(entries.get('m-canon')).toMatchObject({ status: 'Completed', completions: [completion], media: { title: catalogFilm.title } })
    expect((await store.pendingChanges(500)).map(({ id }) => id).sort()).toEqual(['c1', 'm-canon'])
    expect(await store.missingSnapshots()).toEqual([])
  })

  it('applyRemote merges incoming changes without queuing them', async () => {
    const store = open(undefined, () => 1000)
    await store.setAccount(account)
    await store.savePreference(film, { kind: 'like', value: true })
    await store.acknowledge(await store.pendingChanges(500))
    const groups = { progress: { at: 0 }, liked: { value: false, at: 500 }, rating: { value: 4, at: 2000 }, watchlisted: { at: 0 }, label: { at: 0 } }
    await store.applyRemote([
      { kind: 'entry', id: film.id, data: { format: 'MOVIE', anime: false, createdAt: 10, groups }, at: 2000 },
      { kind: 'completion', id: 'remote-watch', data: { mediaId: film.id, date: '2026-11-20' }, at: 2000 },
    ], {})
    expect((await store.read()).get(film.id)).toMatchObject({ liked: true, rating: 4, completions: [{ id: 'remote-watch' }] })
    expect(await store.pendingChanges(500)).toEqual([])
    await store.applyRemote([{ kind: 'entry', id: film.id, data: null, at: 3000 }], {})
    expect((await store.read()).size).toBe(0)
  })

  it('a later local entry keeps remote values it never set', async () => {
    const store = open(undefined, () => 2000)
    await store.setAccount(account)
    const { id } = await store.savePreference(catalogFilm, { kind: 'like', value: true })
    const groups = { progress: { status: 'Completed' as const, at: 1000 }, liked: { at: 0 }, rating: { value: 4, at: 1000 }, watchlisted: { at: 0 }, label: { at: 0 } }
    await store.applyRemote([
      { kind: 'entry', id: 'm-remote', data: { format: 'MOVIE', anime: false, catalogRef: 'tmdb:movie:1', createdAt: 900, groups }, at: 1000 },
    ], {})
    const entries = await store.read()
    expect(entries.has(id)).toBe(false)
    expect(entries.get('m-remote')).toMatchObject({ status: 'Completed', liked: true, rating: 4 })
  })

  it('an entry saved before v3 does not erase a remote rating', async () => {
    const name = crypto.randomUUID()
    const original = new Dexie(name)
    original.version(2).stores({
      media: 'id', entries: 'mediaId,status,updatedAt', completions: 'id,mediaId',
      episodes: '[mediaId+season+number],mediaId', catalog: 'key,&mediaId,expiresAt', responses: 'key,writtenAt,expiresAt',
    })
    await original.table('media').put({ id: film.id, format: 'MOVIE', anime: false })
    await original.table('entries').put({ mediaId: film.id, createdAt: 1, updatedAt: 5000, liked: true })
    original.close()

    const store = open(name)
    await store.setAccount(account)
    const groups = { progress: { at: 0 }, liked: { at: 0 }, rating: { value: 4, at: 1000 }, watchlisted: { at: 0 }, label: { at: 0 } }
    await store.applyRemote([{ kind: 'entry', id: film.id, data: { format: 'MOVIE', anime: false, createdAt: 1, groups }, at: 1000 }], {})
    expect((await store.read()).get(film.id)).toMatchObject({ liked: true, rating: 4 })
  })

  it('a remap queues moved children under the canonical id', async () => {
    const store = open()
    await store.setAccount(account)
    await store.save(anime, { status: 'Completed', completion: { id: 'c1', date: '2026-11-18' } })
    await store.setEpisode(anime.id, manualEpisode({ season: 1, number: 2 }), true)
    await store.acknowledge(await store.pendingChanges(500))
    expect(await store.pendingChanges(500)).toEqual([])
    await store.applyRemote([], { [anime.id]: 'm-canon' })
    const changes = await store.pendingChanges(500)
    expect(changes).toHaveLength(3)
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'completion', id: 'c1', data: { mediaId: 'm-canon', date: '2026-11-18' } }),
      expect.objectContaining({ kind: 'episode', id: 'm-canon:1:2', data: { mediaId: 'm-canon', season: 1, number: 2, watched: true } }),
      expect.objectContaining({ kind: 'episode', id: `${anime.id}:1:2`, data: null }),
    ]))
  })

  it('acknowledge keeps a change edited after it was read', async () => {
    const store = open()
    await store.setAccount(account)
    await store.savePreference(film, { kind: 'rating', value: 4 })
    const sent = await store.pendingChanges(500)
    await store.savePreference(film, { kind: 'rating', value: 5 })
    await store.acknowledge(sent)
    const pending = await store.pendingChanges(500)
    expect(pending).toMatchObject([{ kind: 'entry', data: { groups: { rating: { value: 5 } } } }])
    await store.acknowledge(pending)
    expect(await store.pendingChanges(500)).toEqual([])
  })

  it('enqueueAll queues every entry, completion and episode', async () => {
    const store = open()
    await store.save(film, { status: 'Completed', completion: { id: 'c1', date: '2026-11-18' } })
    await store.save(anime, { status: 'Planned' })
    await store.setEpisode(anime.id, manualEpisode({ season: 1, number: 2 }), true)
    await store.setAccount(account)
    expect(await store.enqueueAll()).toBe(4)
    const changes = await store.pendingChanges(500)
    expect(changes.map(({ kind, id }) => `${kind} ${id}`).sort()).toEqual(
      ['completion c1', `entry ${anime.id}`, `entry ${film.id}`, `episode ${anime.id}:1:2`])
    expect(changes.find(({ kind }) => kind === 'episode')?.data).toEqual({ mediaId: anime.id, season: 1, number: 2, watched: true })
  })

  it('notifies changed only for writes that queue a change', async () => {
    const changed = vi.fn()
    const store = open(undefined, undefined, changed)
    await store.savePreference(film, { kind: 'like', value: true })
    expect(changed).not.toHaveBeenCalled()
    await store.setAccount(account)
    await store.savePreference(film, { kind: 'rating', value: 4 })
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('resetRemote replaces synced records with the server set and keeps queued ones', async () => {
    const store = open()
    await store.setAccount(account)
    await store.save(film, { status: 'Completed', completion: { id: 'c1', date: '2026-11-18' } })
    await store.save(anime, { status: 'Planned' })
    await store.setEpisode(anime.id, manualEpisode({ season: 1, number: 2 }), true)
    await store.acknowledge(await store.pendingChanges(500))
    await store.savePreference(game, { kind: 'like', value: true })
    const queued = await store.pendingChanges(500)
    const groups = { progress: { status: 'Planned' as const, at: 1000 }, liked: { at: 0 }, rating: { at: 0 }, watchlisted: { at: 0 }, label: { at: 0 } }
    await store.resetRemote([
      { kind: 'entry', id: 'm-remote', data: { format: 'MOVIE', anime: false, createdAt: 900, groups }, at: 1000 },
      { kind: 'entry', id: anime.id, data: { format: 'SERIES', anime: true, createdAt: 900, groups }, at: 1000 },
    ], {})
    const entries = await store.read()
    expect([...entries.keys()].sort()).toEqual([anime.id, game.id, 'm-remote'].sort())
    expect(entries.get(anime.id)?.watched).toEqual([])
    expect((await store.exportBackup()).entries.flatMap(({ completions }) => completions)).toEqual([])
    expect(await store.pendingChanges(500)).toEqual(queued)
  })

  it('keeps a merge snapshot and clears everything but cached responses', async () => {
    let now = Date.now()
    const store = open(undefined, () => now)
    await store.save(film, { status: 'Planned' })
    await store.cacheResponse('search', 'tmdb', { items: [] })
    await store.saveMergeSnapshot()
    expect((await store.mergeSnapshot())?.backup.entries).toHaveLength(1)
    await store.setAccount(account)
    await store.clearAll()
    expect((await store.read()).size).toBe(0)
    expect(await store.account()).toBeUndefined()
    expect(await store.lastSub()).toBeUndefined()
    expect(await store.readResponse('search')).toBeDefined()
    await store.save(film, { status: 'Planned' })
    await store.saveMergeSnapshot()
    now += 31 * 24 * 60 * 60_000
    expect(await store.mergeSnapshot()).toBeUndefined()
  })

  it('backups still exclude catalog IDs', async () => {
    const store = open()
    await store.savePreference(catalogGame, { kind: 'like', value: true })
    expect(JSON.stringify(await store.exportBackup())).not.toContain('catalogRef')
  })
})
