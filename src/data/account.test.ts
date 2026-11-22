import { afterEach, expect, it, vi } from 'vitest'
import { deleteAccount, googleClientId, signOut, UnsyncedChangesError } from './account'
import { library } from './library'
import { sync } from './sync'

vi.mock('./library', () => ({
  library: { hasUnsyncedChanges: vi.fn(), setAccount: vi.fn(), clearAll: vi.fn() },
}))
vi.mock('./sync', () => ({ sync: { syncNow: vi.fn(), state: vi.fn() } }))

afterEach(() => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('retries a failed config request and shares a successful response between callers', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ googleClientId: 'configured' }))
  vi.stubGlobal('fetch', fetch)
  expect(await Promise.all([googleClientId(), googleClientId()])).toEqual(['', ''])
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(await googleClientId()).toBe('configured')
  expect(await googleClientId()).toBe('configured')
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('keeps an expired session’s unsynced library and asks the user to sign in again', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  vi.mocked(library.hasUnsyncedChanges).mockResolvedValue(true)
  vi.mocked(sync.state).mockReturnValue({ status: 'signed-out' })
  const result = signOut(false)
  await expect(result).rejects.toBeInstanceOf(UnsyncedChangesError)
  await expect(result).rejects.toThrow('Sign in again to sync them')
  expect(fetch).not.toHaveBeenCalled()
  expect(library.clearAll).not.toHaveBeenCalled()
  expect(library.setAccount).not.toHaveBeenCalled()
})

it.each([
  { endpoint: '/api/auth/logout', method: 'POST', action: () => signOut(true), clearsSession: true },
  { endpoint: '/api/account', method: 'DELETE', action: deleteAccount, clearsSession: false },
])('aborts a hanging $method $endpoint after the 15-second deadline', async ({ endpoint, method, action, clearsSession }) => {
  const controller = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  }))
  vi.stubGlobal('fetch', fetch)
  const result = action()
  const outcome = clearsSession ? expect(result).resolves.toBe(false) : expect(result).rejects.toThrow('deadline')
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({ method, signal: controller.signal })))
  expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000)
  controller.abort(new DOMException('deadline', 'TimeoutError'))
  await outcome
  if (clearsSession) expect(library.setAccount).toHaveBeenCalledExactlyOnceWith(undefined)
  else expect(library.setAccount).not.toHaveBeenCalled()
  expect(library.clearAll).not.toHaveBeenCalled()
})
