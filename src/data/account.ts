import { useEffect, useState } from 'react'
import { z } from 'zod'
import { library } from './library'
import { sync } from './sync'
import { demoMode } from './useCatalog'

export const welcomeKey = 'epilog:welcome:v1'

/**
 * The welcome screen shows once, on a device that has never used Epilog: only at `/`, with an empty library, before
 * any choice was remembered (blocked storage counts as no choice), and only when `signInAvailable` (see
 * `useSignInAvailable`). Callers pass the path the visit opened on, so a shared link skips it for the whole visit.
 */
export function shouldWelcome(path: string, entryCount: number, signInAvailable: boolean) {
  if (path !== '/' || entryCount || !signInAvailable) return false
  try {
    return localStorage.getItem(welcomeKey) === null
  } catch {
    return true
  }
}

export function rememberWelcome(choice: 'guest' | 'google') {
  try {
    localStorage.setItem(welcomeKey, choice)
  } catch {
    // Storage is blocked: the welcome screen shows again next visit, which keeps the deep-link rule intact.
  }
}

let clientId: Promise<string> | undefined

/** The Google client ID from the Worker, or '' when sign-in isn't configured (or in the demo). Failures retry next call. */
export function googleClientId(): Promise<string> {
  if (demoMode) return Promise.resolve('')
  clientId ??= fetch('/api/config', { signal: AbortSignal.timeout(6500) })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Configuration request failed with ${response.status}`)
      return z.object({ googleClientId: z.string() }).parse(await response.json()).googleClientId
    })
    .catch(() => {
      clientId = undefined
      return ''
    })
  return clientId
}

export function useGoogleClientId() {
  const [value, setValue] = useState<string>()
  useEffect(() => {
    let live = true
    void googleClientId().then((id) => { if (live) setValue(id) })
    return () => { live = false }
  }, [])
  return value
}

/** Whether sign-in can be offered on this visit: not the demo, sign-in configured, and no account on this device. */
export function useSignInAvailable() {
  const [value, setValue] = useState<boolean | undefined>(demoMode ? false : undefined)
  useEffect(() => {
    if (demoMode) return
    let live = true
    void Promise.all([googleClientId(), library.account()]).then(
      ([id, account]) => { if (live) setValue(Boolean(id) && !account) },
      () => { if (live) setValue(false) },
    )
    return () => { live = false }
  }, [])
  return value
}

const profileSchema = z.object({ sub: z.string().min(1), email: z.string(), name: z.string() })

/**
 * Signs in with a Google credential and merges this device's library into the account. When the library belongs to
 * another account, `choose` decides whether to merge it or replace it with the account's library.
 */
export async function signIn(credential: string, choose: (question: 'merge-or-replace') => Promise<'merge' | 'replace'>) {
  const response = await fetch('/api/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
  })
  if (!response.ok) throw new Error(`Sign-in failed with ${response.status}`)
  const profile = profileSchema.parse(await response.json())
  const owner = (await library.account())?.sub ?? await library.lastSub()
  const kept = (await library.read()).size > 0
  const replace = kept && owner && owner !== profile.sub && await choose('merge-or-replace') === 'replace'
  // Either way the library from before sign-in stays exportable from Backup & Restore for 30 days.
  if (kept) await library.saveMergeSnapshot()
  if (replace) await library.clearAll(true)
  await library.setAccount(profile)
  await library.enqueueAll()
  await sync.syncNow()
}

// The Worker's CSRF guard wants JSON on every mutating request, bodies or not.
const json = { 'Content-Type': 'application/json' }

/** Thrown by `signOut(false)` when queued changes couldn't be pushed: nothing was removed and the device is still signed in. */
export class UnsyncedChangesError extends Error {
  constructor(reason: 'expired' | 'rejected' | 'unavailable') {
    if (reason === 'expired') {
      super('Your session ended before these changes could sync. Sign in again to sync them, or keep this device’s copy.')
    } else if (reason === 'rejected') {
      super('Some changes couldn’t sync because they were rejected. Keep this device’s copy to preserve them.')
    } else super('Some changes on this device couldn’t be synced, so its library was kept and you’re still signed in. Try again when you’re online, or keep this device’s copy.')
  }
}

/**
 * Signs out of the server, then this device: `keep` leaves the library as a guest's, otherwise it's removed.
 * Resolves `false` when the server couldn't be reached; this device signs out anyway and the session expires on its own.
 * Removing never deletes changes that didn't sync: it throws `UnsyncedChangesError` and changes nothing instead.
 */
export async function signOut(keep: boolean): Promise<boolean> {
  await sync.syncNow() // push what's queued while the session still works
  if (!keep && await library.hasUnsyncedChanges()) {
    const state = sync.state()
    throw new UnsyncedChangesError(state.status === 'signed-out' ? 'expired' : state.parkedCount ? 'rejected' : 'unavailable')
  }
  const reached = await fetch('/api/auth/logout', { method: 'POST', headers: json, signal: AbortSignal.timeout(15_000) }).then(
    (response) => response.ok || response.status === 401,
    () => false,
  )
  if (keep) await library.setAccount(undefined)
  else await library.clearAll()
  await sync.syncNow()
  return reached
}

/** Erases the account and its synced records on the server; this device keeps its library as a guest's. Throws, changing nothing, when the server doesn't confirm. */
export async function deleteAccount(): Promise<void> {
  const response = await fetch('/api/account', { method: 'DELETE', headers: json, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`Account deletion failed with ${response.status}`)
  await library.setAccount(undefined)
  await sync.syncNow()
}
