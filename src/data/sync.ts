import type { SyncChange } from '../domain/sync'
import { maxChanges } from '../domain/sync'
import { library, libraryChanged } from './library'
import type { LibraryStore } from './library'
import { demoMode } from './useCatalog'

export type SyncState =
  | { status: 'guest' }
  | { status: 'idle' | 'syncing'; lastSyncAt?: number }
  | { status: 'error'; message: string; lastSyncAt?: number }
  | { status: 'signed-out' }

type SyncResponse = { cursor: number; changes: SyncChange[]; remap: Record<string, string>; more: boolean; reset?: true }

const debounce = 2_000
const backoff = [5_000, 30_000, 120_000]
const failureMessage = 'Sync didn’t finish. Epilog will try again shortly.'

export function createSync(store: LibraryStore, options: { fetch?: typeof fetch; setTimer?: typeof setTimeout } = {}) {
  const send = options.fetch ?? ((input, init) => fetch(input, init))
  const setTimer = options.setTimer ?? setTimeout
  const listeners = new Set<(state: SyncState) => void>()
  let current: SyncState = { status: 'guest' }
  let failures = 0
  let started = false
  // Timers aren't cleared, they're outdated: only the newest one still runs, which also works with any injected timer.
  let timer = 0
  let running: Promise<void> | undefined
  let followUp: Promise<void> | undefined

  function set(state: SyncState) {
    current = state
    for (const listener of listeners) listener(state)
  }

  function schedule(ms: number) {
    const token = ++timer
    if (started) setTimer(() => (token === timer ? syncNow() : undefined), ms)
  }

  /** One cycle: push queued changes a page at a time and apply what comes back, until both sides are caught up. */
  async function cycle() {
    if (demoMode) return
    let lastSyncAt: number | undefined
    try {
      let limit = maxChanges
      for (;;) {
        const account = await store.account()
        if (!account) return set({ status: 'guest' })
        lastSyncAt = account.lastSyncAt
        if (current.status !== 'syncing') set({ status: 'syncing', lastSyncAt })
        const sent = await store.pendingChanges(limit)
        const response = await send('/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cursor: account.cursor, changes: sent }),
        })
        // The session expired: keep the library and its queue for the next sign-in.
        if (response.status === 401) return set({ status: 'signed-out' })
        if (response.status === 413 && limit > 1) {
          limit = Math.ceil(limit / 2)
          continue
        }
        if (!response.ok) throw new Error(`Sync failed with ${response.status}`)
        const body = await response.json() as SyncResponse
        await (body.reset ? store.resetRemote : store.applyRemote)(body.changes, body.remap)
        // After applying: a change the response rewrote stays queued and goes up again next page.
        await store.acknowledge(sent)
        lastSyncAt = Date.now()
        await store.setCursor(body.cursor, lastSyncAt)
        if (!body.more && !(await store.pendingChanges(1)).length) break
      }
      failures = 0
      set({ status: 'idle', lastSyncAt })
    } catch {
      set({ status: 'error', message: failureMessage, lastSyncAt })
      schedule(backoff[Math.min(failures++, backoff.length - 1)])
    }
  }

  /** Runs a cycle now, or once more after the running one; never rejects. */
  function syncNow(): Promise<void> {
    if (!running) {
      running = cycle().finally(() => { running = undefined })
      return running
    }
    followUp ??= running.then(() => {
      followUp = undefined
      return syncNow()
    })
    return followUp
  }

  function start() {
    started = true
    // An expired session waits for the next sign-in, which calls syncNow itself.
    const trigger = () => { if (current.status !== 'signed-out') void syncNow() }
    const changed = () => { if (!failures && current.status !== 'signed-out') schedule(debounce) }
    const visible = () => { if (document.visibilityState === 'visible') trigger() }
    window.addEventListener(libraryChanged, changed)
    window.addEventListener('online', trigger)
    document.addEventListener('visibilitychange', visible)
    void syncNow()
    return () => {
      started = false
      timer++
      window.removeEventListener(libraryChanged, changed)
      window.removeEventListener('online', trigger)
      document.removeEventListener('visibilitychange', visible)
    }
  }

  function subscribe(listener: (state: SyncState) => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  return { start, syncNow, subscribe, state: () => current }
}

export const sync = createSync(library)
