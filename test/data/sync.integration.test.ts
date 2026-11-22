// Two real devices (fake-indexeddb stores and sync loops) against the real Worker sync handler on a node:sqlite D1.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleSync } from '../../worker/sync'
import { createTestD1 } from '../support/test-d1'
import { parseBackup } from '../../src/domain/backup-file'
import { manualEpisode } from '../../src/domain/media'
import type { Media } from '../../src/domain/media'
import { createLibrary } from '../../src/data/library'
import type { LibraryStore } from '../../src/data/library'
import { createSync } from '../../src/data/sync'

const account = { sub: 'sub-ada', email: 'ada@example.test', name: 'Ada' }
const movie = (id: string, title: string): Media => ({
  id: `tmdb:movie:${id}`, identity: { provider: 'tmdb', entity: 'movie', id }, format: 'MOVIE', anime: false,
  title, description: '', genres: [], catalogedAt: start,
})
const start = 1_800_000_000_000
const minute = 60_000
const moon = movie('42', 'Moon')
const show: Media = {
  id: 'tmdb:tv:7', identity: { provider: 'tmdb', entity: 'tv', id: '7' }, format: 'SERIES', anime: false,
  title: 'Harbor Lights', description: '', genres: [], catalogedAt: start,
}
const dune: Media = {
  id: 'openlibrary:work:OL45883W', identity: { provider: 'openlibrary', entity: 'work', id: 'OL45883W' }, format: 'BOOK', bookType: 'Novel',
  title: 'Dune', description: '', genres: [], catalogedAt: start,
}
const notes: Media = { id: 'b-notes', format: 'BOOK', bookType: 'Nonfiction', title: 'Field Notes', description: '', genres: [] }

let now: number
let userId: string
let db: ReturnType<typeof createTestD1>
const stores: LibraryStore[] = []

beforeEach(async () => {
  now = start
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  db = createTestD1()
  userId = await createUser('u1')
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(stores.splice(0).map((store) => store.deleteDatabase()))
})

async function createUser(id: string) {
  await db.prepare('INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, 0)').bind(id, account.sub, account.email, account.name).run()
  return id
}

/** A device whose clock runs `skew` ms off the server's, talking to the real handler. `beforeRequest` runs once, mid-request. */
function device(skew = 0) {
  const store = createLibrary(crypto.randomUUID(), () => now + skew)
  stores.push(store)
  const hooks: { beforeRequest?: () => Promise<unknown> } = {}
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    const hook = hooks.beforeRequest
    hooks.beforeRequest = undefined
    await hook?.()
    return Response.json(await handleSync(db, userId, body, now))
  }) as unknown as typeof globalThis.fetch
  const sync = createSync(store, { fetch, setTimer: (() => 0) as unknown as typeof setTimeout })
  async function syncNow() {
    await sync.syncNow()
    expect(sync.state()).toMatchObject({ status: 'idle' })
    expect(await store.pendingChanges(1)).toEqual([])
  }
  /** What `signIn` in account.ts does once the server accepts the credential. */
  async function signIn() {
    await store.setAccount(account)
    await store.enqueueAll()
    await syncNow()
  }
  return { store, hooks, syncNow, signIn }
}
type Device = ReturnType<typeof device>

async function settle(...devices: Device[]) {
  for (let round = 0; round < 2; round++) for (const item of devices) await item.syncNow()
}

async function summary(store: LibraryStore) {
  return [...(await store.read()).values()].map((entry) => ({
    id: entry.media.id, status: entry.status, liked: entry.liked, rating: entry.rating,
    completions: entry.completions.map(({ id }) => id).sort(),
    watched: entry.watched.map(({ season, number }) => `${season}:${number}`).sort(),
    unwatched: entry.unwatched.map(({ season, number }) => `${season}:${number}`).sort(),
  })).sort((a, b) => (a.id < b.id ? -1 : 1))
}

const only = async (store: LibraryStore) => {
  const entries = [...(await store.read()).values()]
  expect(entries).toHaveLength(1)
  return entries[0]
}
const liveRecords = (kind: string) => db.dump('records').filter((row) => row.kind === kind && row.deleted === 0)

describe('two devices against the real sync handler', () => {
  it('merges the same title logged on two devices into one entry with both completions', async () => {
    const a = device()
    const b = device()
    await a.store.completeToday(moon)
    now += minute
    await b.store.completeToday(moon)
    await b.store.savePreference(moon, { kind: 'like', value: true })
    await a.signIn()
    await b.signIn()
    await settle(a, b)
    const [left, right] = [await summary(a.store), await summary(b.store)]
    expect(left).toEqual(right)
    expect(left).toHaveLength(1)
    expect(left[0]).toMatchObject({ status: 'Completed', liked: true })
    expect(left[0].completions).toHaveLength(2)
    expect(liveRecords('entry')).toHaveLength(1)
  })

  it('carries a removed watch to the other device and keeps the rest of the entry', async () => {
    const a = device()
    const b = device()
    await a.store.completeToday(moon)
    await a.store.savePreference(moon, { kind: 'rating', value: 4 })
    await a.signIn()
    await b.signIn()
    expect((await only(b.store)).completions).toHaveLength(1)

    now += minute
    const removed = await b.store.uncomplete((await only(b.store)).media)
    expect(removed).toMatchObject({ removed: false })
    await settle(b, a)
    for (const store of [a.store, b.store]) expect(await only(store)).toMatchObject({ rating: 4, completions: [] })
    expect(liveRecords('completion')).toHaveLength(0)
  })

  it('lets a later edit revive a removed title, and a later removal stay removed', async () => {
    const a = device()
    const b = device()
    await a.store.savePreference(moon, { kind: 'rating', value: 3 })
    await a.signIn()
    await b.signIn()
    const { id } = (await only(a.store)).media

    now += minute
    await a.store.remove(id)
    now += minute
    await b.store.savePreference((await only(b.store)).media, { kind: 'rating', value: 5 }) // offline, after the removal
    await settle(a, b)
    for (const store of [a.store, b.store]) expect(await only(store)).toMatchObject({ rating: 5 })

    now += minute
    await b.store.savePreference((await only(b.store)).media, { kind: 'like', value: true }) // offline, before the removal
    now += minute
    await a.store.remove(id)
    await settle(b, a)
    expect((await a.store.read()).size).toBe(0)
    expect((await b.store.read()).size).toBe(0)
    expect(liveRecords('entry')).toHaveLength(0)
  })

  it('keeps a later rewatch attached when another device concurrently removes the completed title', async () => {
    const a = device()
    const b = device()
    await a.store.completeToday(moon)
    await a.signIn()
    await b.signIn()
    const { media } = await only(b.store)
    now += minute
    await a.store.remove(media.id)
    now += 1 // both edits are pending independently, but the rewatch happened later
    await b.store.save(media, { status: 'Completed', completion: { id: 'rewatch', date: '2026-11-22' } })
    await settle(a, b)
    for (const { store } of [a, b]) {
      expect(await only(store)).toMatchObject({ status: 'Completed', completions: [{ id: 'rewatch' }] })
    }
    expect(liveRecords('entry')).toHaveLength(1)
    expect(liveRecords('completion')).toHaveLength(1)
  })

  it('does not let a device with a clock a year fast win conflicts it re-pushes', async () => {
    const a = device()
    const fast = device(365 * 24 * 60 * minute)
    await a.store.savePreference(moon, { kind: 'rating', value: 5 })
    await a.signIn()
    await fast.signIn()
    await fast.store.savePreference((await only(fast.store)).media, { kind: 'rating', value: 2 })
    await fast.syncNow()

    now += 10 * minute // an honest later edit
    await a.syncNow()
    await a.store.savePreference((await only(a.store)).media, { kind: 'rating', value: 4 })
    await a.syncNow()

    now += 10 * minute // the fast device touches another group, which pushes the whole entry again
    await fast.syncNow()
    await fast.store.savePreference((await only(fast.store)).media, { kind: 'like', value: true })
    await settle(fast, a)
    for (const store of [a.store, fast.store]) expect(await only(store)).toMatchObject({ rating: 4, liked: true })
    expect(JSON.parse(liveRecords('entry')[0].data as string)).toMatchObject({ groups: { rating: { value: 4 }, liked: { value: true } } })
  })

  it('exports a valid backup after receiving episode activity that leaves series status unchanged', async () => {
    const a = device()
    const b = device()
    const { id } = await a.store.save(show, { status: 'In progress' })
    await a.signIn()
    await b.signIn()

    now += minute
    const second = manualEpisode({ season: 1, number: 2 })
    await a.store.setEpisode(id, second, true)
    await settle(a, b)
    const saved = (await b.store.read()).get(id)
    expect(saved).toMatchObject({ updatedAt: now, status: 'In progress', watched: [second] })
    const backup = parseBackup(JSON.stringify(await b.store.exportBackup()))
    expect(backup.entries[0]).toMatchObject({ updatedAt: now, episodes: [{ number: 2, watched: true, updatedAt: now }] })
    // Recording episode activity must not turn the unchanged status into a new sync edit.
    await b.store.enqueueAll()
    expect((await b.store.pendingChanges(10)).find(({ kind }) => kind === 'entry'))
      .toMatchObject({ data: { groups: { progress: { at: start } } } })
  })

  it('pages a first merge of more than 500 changes on push and pull', async () => {
    const a = device()
    const b = device()
    for (const index of [1, 2, 3]) await a.store.completeToday(movie(String(index), `Film ${index}`))
    const { id } = await a.store.save(show, { status: 'In progress' })
    await a.store.setEpisode(id, Array.from({ length: 500 }, (_, index) => manualEpisode({ season: 1, number: index + 1 })), true)
    await a.store.setAccount(account)
    expect(await a.store.enqueueAll()).toBe(507)
    await a.syncNow()
    expect(db.dump('records')).toHaveLength(507)
    await b.signIn()
    expect(await summary(b.store)).toEqual(await summary(a.store))
    expect((await b.store.read()).get(id)?.watched).toHaveLength(500)
  })

  it('pulls the whole account again after it was deleted and created anew', async () => {
    const a = device()
    const b = device()
    await a.store.savePreference(moon, { kind: 'like', value: true })
    await b.signIn()
    for (let index = 0; index < 5; index++) await b.store.savePreference(movie(String(100 + index), `B ${index}`), { kind: 'like', value: true })
    await b.syncNow()
    expect((await b.store.account())?.cursor).toBe(5)

    // Settings → Delete account (the Worker's statements), then the same Google account signs in again.
    await db.batch(['records', 'aliases', 'sessions'].map((table) => db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId))
      .concat(db.prepare('DELETE FROM users WHERE id = ?').bind(userId)))
    userId = await createUser('u2')
    for (let index = 0; index < 6; index++) await a.store.savePreference(movie(String(200 + index), `A ${index}`), { kind: 'like', value: true })
    await a.signIn()
    await b.signIn()
    await settle(a, b)
    expect((await b.store.read()).size).toBe(12)
    expect(await summary(a.store)).toEqual(await summary(b.store))
  })

  it('restoring an old backup and signing in keeps newer edits, removals and catalog IDs', async () => {
    const b = device()
    const a = device()
    await b.store.completeToday(moon)
    await b.store.savePreference(moon, { kind: 'rating', value: 3 })
    await b.signIn()
    const backup = await b.store.exportBackup()
    now += 60 * minute
    await b.store.savePreference(moon, { kind: 'rating', value: 5 })
    await b.store.uncomplete(moon) // a removed watch the old backup still holds
    await b.syncNow()

    now += 60 * minute
    await a.store.applyRestore(await a.store.previewRestore(backup), false)
    await a.signIn()
    await settle(b, a)
    for (const store of [a.store, b.store]) expect(await only(store)).toMatchObject({ rating: 5, completions: [] })
    expect(liveRecords('entry')[0]).toMatchObject({ catalog_ref: moon.id })
    now += 31 * 24 * 60 * minute // past every snapshot: both devices still know the title's catalog ID
    for (const store of [a.store, b.store]) expect((await store.missingSnapshots()).map(({ catalogRef }) => catalogRef)).toEqual([moon.id])
  })

  it('never sends a catalog book’s title to the server, and the other device fills it in from the catalog', async () => {
    const a = device()
    const b = device()
    await a.store.save(dune, { status: 'In progress' })
    await a.store.save(notes, { status: 'Planned' })
    await a.signIn()
    now += minute
    await a.store.save(dune, { status: 'Completed', completion: { id: 'c-dune', date: '2026-11-21' } })
    await a.syncNow()
    const server = JSON.stringify(db.dump('records'))
    expect(server).not.toContain('Dune')
    expect(server).toContain('Field Notes') // a manual book's title is the person's own label, and syncs

    await b.signIn()
    const books = () => b.store.read().then((entries) => [...entries.values()].map(({ media }) => media.title).sort())
    expect(await books()).toEqual(['Field Notes', 'Saved book'])
    const backup = parseBackup(JSON.stringify(await b.store.exportBackup()))
    expect(backup.entries).toHaveLength(2)
    expect(backup.entries.find(({ media }) => media.id === dune.id)?.media.label).toBeUndefined()
    const restored = device()
    await restored.store.applyRestore(await restored.store.previewRestore(backup), false)
    expect((await restored.store.read()).get(dune.id)).toMatchObject({ status: 'Completed', completions: [{ id: 'c-dune' }] })
    expect(await restored.store.missingSnapshots()).toEqual([{ mediaId: dune.id, catalogRef: dune.id }])
    await restored.store.storeSnapshot(dune.id, dune)
    expect((await restored.store.read()).get(dune.id)?.media.title).toBe('Dune')
    await b.store.storeSnapshot(dune.id, dune) // the background lookup
    now += 2 * 24 * 60 * minute // past the snapshot: the stored label carries the title
    expect(await books()).toEqual(['Dune', 'Field Notes'])
    expect(parseBackup(JSON.stringify(await b.store.exportBackup())).entries.map(({ media }) => media.label).sort()).toEqual(['Dune', 'Field Notes'])
    // The device that logged it keeps its own title when the entry comes back from the server.
    await b.store.savePreference((await b.store.read()).get(dune.id)!.media, { kind: 'rating', value: 5 })
    await settle(b, a)
    expect((await a.store.read()).get(dune.id)).toMatchObject({ rating: 5, media: { title: 'Dune' } })
    expect(JSON.stringify(db.dump('records'))).not.toContain('Dune')
  })

  it('restores a pending catalog book under its remapped id and repairs an old fallback label', async () => {
    const a = device()
    const b = device()
    const id = 'remapped-book'
    const groups = { progress: { status: 'In progress' as const, at: now }, liked: { at: 0 },
      rating: { at: 0 }, watchlisted: { at: 0 }, label: { at: 0 } }
    await a.store.applyRemote([{ kind: 'entry', id, at: now, data: {
      format: 'BOOK', anime: false, bookType: 'Novel', catalogRef: dune.id, createdAt: now, groups,
    } }], {})
    await a.store.savePreference((await only(a.store)).media, { kind: 'rating', value: 4 })
    const raw = await a.store.exportBackup()
    expect(raw.entries[0].media).toMatchObject({ id, catalogRef: dune.id, label: undefined })
    const legacy = { ...raw, entries: [{ ...raw.entries[0], media: { ...raw.entries[0].media, label: 'Saved book' } }] }
    const backup = parseBackup(JSON.stringify(legacy))
    await b.store.applyRestore(await b.store.previewRestore(backup), true)
    expect(await b.store.missingSnapshots()).toEqual([{ mediaId: id, catalogRef: dune.id }])
    await b.store.storeSnapshot(id, dune)
    expect(await only(b.store)).toMatchObject({ media: { id, title: 'Dune' }, rating: 4 })
    await b.store.applyRestore(await b.store.previewRestore(backup), true)
    expect((await only(b.store)).media.title).toBe('Dune')
  })

  it('adopts the other device’s id for a twin logged while a request was out', async () => {
    const a = device()
    const b = device()
    await a.store.completeToday(moon)
    await a.signIn()
    const { id } = (await only(a.store)).media
    now += minute
    b.hooks.beforeRequest = () => b.store.completeToday(moon) // logged after the request read the outbox
    await b.signIn()
    await settle(a, b)
    expect(await summary(b.store)).toEqual(await summary(a.store))
    expect(await only(b.store)).toMatchObject({ media: { id } })
    expect((await only(b.store)).completions).toHaveLength(2)
    expect(db.dump('aliases')).toEqual([]) // the client merged it; the server never had to remap
  })

  it('remaps an id into a target this device already holds', async () => {
    const a = device()
    const b = device()
    await b.store.completeToday(moon)
    await b.store.savePreference(moon, { kind: 'rating', value: 3 })
    const backup = await b.store.exportBackup()
    await b.signIn()

    now += minute
    await a.store.completeToday(moon)
    await a.store.savePreference(moon, { kind: 'like', value: true })
    now += minute
    await a.store.applyRestore(await a.store.previewRestore(backup), false) // the same title under B's id, without its catalog ID
    expect((await a.store.read()).size).toBe(2)
    await a.signIn()
    await settle(a, b)
    expect(await summary(a.store)).toEqual(await summary(b.store))
    expect(await only(a.store)).toMatchObject({ media: { id: (await only(b.store)).media.id }, liked: true, rating: 3 })
    expect((await only(a.store)).completions).toHaveLength(2)
    expect(liveRecords('entry')).toEqual([expect.objectContaining({ catalog_ref: moon.id })])
  })

  it('settles an episode logged on both twins by the later change', async () => {
    const a = device()
    const b = device()
    const first = manualEpisode({ season: 1, number: 1 })
    const second = manualEpisode({ season: 1, number: 2 })
    const { id: aId } = await a.store.save(show, { status: 'In progress' })
    const { id: bId } = await b.store.save(show, { status: 'In progress' })
    await a.store.setEpisode(aId, first, true)
    now += minute
    await b.store.setEpisode(bId, [first, second], false)
    now += minute
    await a.store.setEpisode(aId, second, true)
    await a.signIn()
    await b.signIn()
    await settle(a, b)
    const [left, right] = [await summary(a.store), await summary(b.store)]
    expect(left).toEqual(right)
    expect(left).toEqual([expect.objectContaining({ id: aId, watched: ['1:2'], unwatched: ['1:1'] })])
  })
})
