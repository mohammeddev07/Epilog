import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { manualEpisode } from '../domain/media'
import type { SyncChange } from '../domain/sync'
import { demoCatalog } from './demo'
import { createLibrary, libraryChanged } from './library'
import type { LibraryStore } from './library'
import { createSync } from './sync'

const film = demoCatalog.find(({ id }) => id === 'the-last-signal')!
const anime = demoCatalog.find(({ format, anime }) => format === 'SERIES' && anime)!
const account = { sub: 's1', email: 'a@example.test', name: 'A' }
const stores: LibraryStore[] = []
let timers: { run: () => unknown; ms: number }[]
let documentTarget: EventTarget & { visibilityState: string }

type Reply = { status?: number; body?: Partial<{ cursor: number; changes: SyncChange[]; remap: Record<string, string>; more: boolean; reset: true }> }

function open() {
  const store = createLibrary(crypto.randomUUID(), undefined, () => window.dispatchEvent(new Event(libraryChanged)))
  stores.push(store)
  return store
}

/** A fetch stub that records each request body and answers with the next reply (or an empty success). */
function server(...replies: (Reply | (() => Promise<Reply>))[]) {
  const requests: { url: string; init: RequestInit; body: { cursor: number; changes: SyncChange[] } }[] = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init, body: JSON.parse(init.body as string) })
    const next = replies.shift()
    const reply = typeof next === 'function' ? await next() : next ?? {}
    if (reply.status === 0) throw new TypeError('Failed to fetch')
    return Response.json({ cursor: 1, changes: [], remap: {}, more: false, ...reply.body }, { status: reply.status ?? 200 })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests }
}

function create(store: LibraryStore, fetch: typeof globalThis.fetch) {
  const setTimer = ((run: () => unknown, ms: number) => timers.push({ run, ms })) as unknown as typeof setTimeout
  return createSync(store, { fetch, setTimer })
}

/** A reply that stays open until released, to change the device while a request is out. */
function hold() {
  let entered!: () => void
  let release!: (reply: Reply) => void
  const inside = new Promise<void>((resolve) => { entered = resolve })
  const reply = () => {
    entered()
    return new Promise<Reply>((resolve) => { release = resolve })
  }
  return { inside, reply, release: (value: Reply) => release(value) }
}

async function runTimer() {
  await timers.shift()!.run()
}

beforeEach(() => {
  timers = []
  documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', documentTarget)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(stores.splice(0).map((store) => store.deleteDatabase()))
})

describe('sync loop', () => {
  it('stays idle for guests and makes no requests', async () => {
    const store = open()
    await store.savePreference(film, { kind: 'like', value: true })
    const { fetch } = server()
    const sync = create(store, fetch)
    const stop = sync.start()
    await sync.syncNow()
    window.dispatchEvent(new Event('online'))
    document.dispatchEvent(new Event('visibilitychange'))
    await sync.syncNow()
    expect(fetch).not.toHaveBeenCalled()
    expect(sync.state()).toEqual({ status: 'guest' })
    stop()
  })

  it('pushes, applies the response, acknowledges and stores the cursor', async () => {
    const other = open()
    await other.setAccount(account)
    await other.save({ ...anime, id: 'remote-anime' }, { status: 'Planned' })
    const remote = await other.pendingChanges(500)

    const store = open()
    await store.setAccount(account)
    await store.savePreference(film, { kind: 'like', value: true })
    const local = await store.pendingChanges(500)
    const { fetch, requests } = server({ body: { cursor: 7, changes: remote } })
    const sync = create(store, fetch)
    const states: string[] = []
    sync.subscribe((state) => states.push(state.status))
    await sync.syncNow()

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/api/sync')
    expect(requests[0].init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
    expect(requests[0].body).toEqual({ cursor: 0, changes: local })
    const entries = await store.read()
    expect(entries.get('remote-anime')).toMatchObject({ status: 'Planned' })
    expect(entries.get(film.id)).toMatchObject({ liked: true })
    expect(await store.pendingChanges(500)).toEqual([])
    const { cursor, lastSyncAt } = (await store.account())!
    expect(cursor).toBe(7)
    expect(states).toEqual(['syncing', 'idle'])
    expect(sync.state()).toEqual({ status: 'idle', lastSyncAt })
  })

  it('pages a large first merge', async () => {
    const store = open()
    await store.setAccount(account)
    await store.save(anime, { status: 'Planned' })
    const episodes = Array.from({ length: 1199 }, (_, index) => manualEpisode({ season: 1, number: index + 1 }))
    await store.setEpisode(anime.id, episodes, true)
    const pending: number[] = []
    const count = async () => {
      pending.push((await store.pendingChanges(2000)).length)
      return {}
    }
    const { fetch, requests } = server(count, count, count)
    const sync = create(store, fetch)
    await sync.syncNow()
    expect(requests.map(({ body }) => body.changes.length)).toEqual([500, 500, 200])
    expect(pending).toEqual([1200, 700, 200])
    expect(await store.pendingChanges(2000)).toEqual([])
  })

  it('keeps the outbox on 401 and reports signed-out', async () => {
    const store = open()
    await store.setAccount(account)
    await store.savePreference(film, { kind: 'like', value: true })
    const queued = await store.pendingChanges(500)
    const { fetch, requests } = server({ status: 401 })
    const sync = create(store, fetch)
    await sync.syncNow()
    expect(sync.state()).toEqual({ status: 'signed-out' })
    expect(await store.account()).toMatchObject(account)
    expect(await store.pendingChanges(500)).toEqual(queued)
    expect((await store.read()).get(film.id)).toMatchObject({ liked: true })
    expect(timers).toEqual([])

    // Signing in again with the same account pushes the kept edits.
    await store.setAccount(account)
    await sync.syncNow()
    expect(requests.at(-1)!.body.changes).toEqual(queued)
    expect(await store.pendingChanges(500)).toEqual([])
    expect(sync.state().status).toBe('idle')
  })

  it('backs off 5 s, 30 s, 120 s after failures, then resets after a success', async () => {
    const store = open()
    await store.setAccount(account)
    await store.savePreference(film, { kind: 'like', value: true })
    const { fetch } = server({ status: 0 }, { status: 503 }, { status: 429 }, { status: 500 }, {}, { status: 502 })
    const sync = create(store, fetch)
    sync.start()
    await vi.waitFor(() => expect(timers).toHaveLength(1))
    expect(sync.state()).toMatchObject({ status: 'error', message: expect.any(String) })
    expect(await store.pendingChanges(500)).toHaveLength(1)
    const delays = [timers[0].ms]
    for (let attempt = 0; attempt < 3; attempt++) {
      await runTimer()
      delays.push(timers[0].ms)
    }
    expect(delays).toEqual([5_000, 30_000, 120_000, 120_000])
    await runTimer()
    expect(sync.state().status).toBe('idle')
    expect(timers).toEqual([])
    expect(await store.pendingChanges(500)).toEqual([])
    await sync.syncNow()
    expect(timers.map(({ ms }) => ms)).toEqual([5_000])
  })

  it('coalesces triggers during a running cycle into one follow-up', async () => {
    const store = open()
    await store.setAccount(account)
    let release!: () => void
    let entered!: () => void
    const inside = new Promise<void>((resolve) => { entered = resolve })
    const { fetch } = server(() => {
      entered()
      return new Promise((resolve) => { release = () => resolve({}) })
    })
    const sync = create(store, fetch)
    const first = sync.syncNow()
    await inside
    const followUps = [sync.syncNow(), sync.syncNow(), sync.syncNow()]
    release()
    await Promise.all([first, ...followUps])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('syncs 2 s after a change, on online and when the tab becomes visible, until stopped', async () => {
    const store = open()
    await store.setAccount(account)
    const { fetch } = server()
    const sync = create(store, fetch)
    const stop = sync.start()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(sync.state().status).toBe('idle'))

    await store.savePreference(film, { kind: 'like', value: true })
    await store.savePreference(film, { kind: 'rating', value: 4 })
    expect(timers.map(({ ms }) => ms)).toEqual([2_000, 2_000])
    await runTimer()
    await runTimer()
    expect(fetch).toHaveBeenCalledTimes(2)

    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    documentTarget.visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    documentTarget.visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
    await vi.waitFor(() => expect(sync.state().status).toBe('idle'))

    stop()
    window.dispatchEvent(new Event('online'))
    await store.savePreference(film, { kind: 'rating', value: 5 })
    expect(timers).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('signing out with clearAll mid-cycle leaves the library empty after the response lands', async () => {
    const other = open()
    await other.setAccount(account)
    await other.save({ ...anime, id: 'remote-anime' }, { status: 'Planned' })
    const remote = await other.pendingChanges(500)
    const store = open()
    await store.setAccount(account)
    await store.savePreference(film, { kind: 'like', value: true })
    const held = hold()
    const { fetch } = server(held.reply)
    const sync = create(store, fetch)
    const cycle = sync.syncNow()
    await held.inside
    await store.clearAll()
    held.release({ body: { cursor: 7, changes: remote } })
    await cycle
    expect((await store.read()).size).toBe(0)
    expect(await store.account()).toBeUndefined()
    expect(sync.state()).toEqual({ status: 'guest' })
    expect(timers).toEqual([])
  })

  it('switching to another account mid-cycle leaves B’s library, cursor and outbox untouched', async () => {
    const other = open()
    await other.setAccount(account)
    await other.save({ ...anime, id: 'remote-anime' }, { status: 'Planned' })
    const remote = await other.pendingChanges(500)
    const store = open()
    await store.setAccount(account)
    await store.savePreference(film, { kind: 'like', value: true })
    const held = hold()
    const { fetch } = server(held.reply)
    const sync = create(store, fetch)
    const cycle = sync.syncNow()
    await held.inside
    await store.setAccount(undefined)
    await store.setAccount({ sub: 's2', email: 'b@example.test', name: 'B' })
    await store.enqueueAll() // B's queue now holds the same film change A sent
    const before = { entries: [...(await store.read()).keys()], account: await store.account(), pending: await store.pendingChanges(500) }
    held.release({ body: { cursor: 7, changes: remote } })
    await cycle
    expect({ entries: [...(await store.read()).keys()], account: await store.account(), pending: await store.pendingChanges(500) }).toEqual(before)
    expect(before.pending).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sync.state()).toEqual({ status: 'idle' })
    expect(timers).toEqual([])
  })

  it('halves the page after a 413', async () => {
    const store = open()
    await store.setAccount(account)
    await store.save(anime, { status: 'Planned' })
    await store.setEpisode(anime.id, Array.from({ length: 599 }, (_, index) => manualEpisode({ season: 1, number: index + 1 })), true)
    const { fetch, requests } = server({ status: 413 })
    const sync = create(store, fetch)
    await sync.syncNow()
    expect(requests.map(({ body }) => body.changes.length)).toEqual([500, 250, 250, 100])
    expect(await store.pendingChanges(1000)).toEqual([])
  })

  it('replaces synced state on a reset', async () => {
    const store = open()
    await store.setAccount(account)
    await store.savePreference(film, { kind: 'like', value: true })
    const { fetch } = server({}, { body: { cursor: 9, changes: [], reset: true } })
    const sync = create(store, fetch)
    await sync.syncNow()
    await sync.syncNow()
    expect((await store.read()).size).toBe(0)
    expect((await store.account())!.cursor).toBe(9)
  })
})
