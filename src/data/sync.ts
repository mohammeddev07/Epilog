import type { SyncChange } from '../domain/sync'
import { maxChanges, syncAccountHeader, syncChangeSchema } from '../domain/sync'
import { library, libraryChanged } from './library'
import type { LibraryStore } from './library'
import { demoMode } from './useCatalog'

export type SyncState = (
  | { status: 'guest' }
  | { status: 'idle' | 'syncing'; lastSyncAt?: number }
  | { status: 'error'; message: string; lastSyncAt?: number }
  | { status: 'signed-out' }
) & { parkedCount?: number }

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
    let parkedCount = 0
    const parked = () => parkedCount ? { parkedCount } : {}
    try {
      let limit = maxChanges
      for (;;) {
        const account = await store.account()
        if (!account) return set({ status: 'guest' })
        lastSyncAt = account.lastSyncAt
        parkedCount = await store.parkedChanges()
        if (current.status !== 'syncing' || (current.parkedCount ?? 0) !== parkedCount) {
          set({ status: 'syncing', lastSyncAt, ...parked() })
        }
        const sent = await store.pendingChanges(limit)
        const invalid = sent.filter((change) => !syncChangeSchema.safeParse(change).success)
        if (invalid.length) {
          if (!await store.parkChanges(account.sub, invalid)) break
          continue
        }
        const response = await send('/api/sync', {
          method: 'POST',
          signal: AbortSignal.timeout(15_000),
          headers: { 'Content-Type': 'application/json', [syncAccountHeader]: account.sub },
          body: JSON.stringify({ cursor: account.cursor, changes: sent }),
        })
        // A missing or mismatched session leaves the library and its queue for the next sign-in.
        if ((await store.account())?.sub !== account.sub) break
        if (response.status === 401) return set({ status: 'signed-out', ...parked() })
        if ((response.status === 400 || response.status === 413) && sent.length) {
          // Isolate a single rejected change so a batch error doesn't park healthy changes.
          if (sent.length > 1) limit = Math.ceil(sent.length / 2)
          else {
            if (!await store.parkChanges(account.sub, sent)) break
            limit = maxChanges
          }
          continue
        }
        if (!response.ok) throw new Error(`Sync failed with ${response.status}`)
        const body = await response.json() as SyncResponse
        // Signed out or switched accounts while the request was out: this response belongs to nobody here now.
        if (!await store.commitSync(account.sub, sent, body)) return set(await store.account() ? { status: 'idle' } : { status: 'guest' })
        if (!body.more && !(await store.pendingChanges(1)).length) {
          break
        }
      }
      failures = 0
      const account = await store.account()
      if (!account) return set({ status: 'guest' })
      parkedCount = await store.parkedChanges()
      set({ status: 'idle', lastSyncAt: account.lastSyncAt, ...parked() })
    } catch {
      set({ status: 'error', message: failureMessage, lastSyncAt, ...parked() })
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
