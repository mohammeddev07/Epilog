import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccountRoutes } from './auth'
import { createCatalogWorker } from './index'
import type { Env } from './index'
import { createTestD1 } from './test-d1'

const origin = 'https://epilog.test'
const clientId = 'fixture-client.apps.googleusercontent.com'
const day = 86_400_000
const start = 1_800_000_000_000
const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
const google = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
const intruder = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
const jwks = [{ ...await crypto.subtle.exportKey('jwk', google.publicKey), kid: 'google-1' }]

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)))

async function token(claims: Record<string, unknown> = {}, key = google.privateKey, header: Record<string, unknown> = {}) {
  const signed = `${encode({ alg: 'RS256', kid: 'google-1', typ: 'JWT', ...header })}.${encode({
    iss: 'https://accounts.google.com', aud: clientId, sub: 'google-sub-1', email: 'ada@example.test', name: 'Ada',
    exp: start / 1000 + 3600, ...claims,
  })}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signed))
  return `${signed}.${base64url(new Uint8Array(signature))}`
}

let db: ReturnType<typeof createTestD1>
let env: Env
let now: number
let worker: ReturnType<typeof createCatalogWorker>
const upstream = vi.fn<typeof fetch>()

beforeEach(() => {
  db = createTestD1()
  env = { DB: db, GOOGLE_CLIENT_ID: clientId }
  now = start
  worker = createCatalogWorker(upstream, createAccountRoutes({ keys: async () => jwks, now: () => now }))
})

function call(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`${origin}${path}`, init), env)
}

const mutate = (method: string, cookie?: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', Origin: origin, ...cookie ? { Cookie: cookie } : {} },
  body: body === undefined ? undefined : JSON.stringify(body),
})

async function signIn(credential: string | Promise<string>, init?: RequestInit) {
  return call('/api/auth/google', { ...mutate('POST', undefined, { credential: await credential }), ...init })
}

async function session(credential?: Promise<string>) {
  const response = await signIn(credential ?? token())
  expect(response.status).toBe(200)
  return response.headers.get('set-cookie')!.split(';')[0]
}

describe('account Worker', () => {
  it.each([
    ['wrong audience', { aud: 'other' }], ['wrong issuer', { iss: 'https://evil.test' }], ['expired', { exp: 1 }],
  ])('rejects a token with %s', async (_, claims) => expect((await signIn(token(claims))).status).toBe(401))

  it('rejects a token signed by another key', async () => {
    expect((await signIn(token({}, intruder.privateKey))).status).toBe(401)
    expect((await signIn(token({}, google.privateKey, { kid: 'unknown' }))).status).toBe(401)
    expect((await signIn(token({}, google.privateKey, { alg: 'none' }))).status).toBe(401)
    const valid = await token()
    expect((await signIn(`${valid.split('.').slice(0, 2).join('.')}.`)).status).toBe(401)
    expect((await signIn('not.a.jwt')).status).toBe(401)
    expect(await (await signIn(token({}, intruder.privateKey))).json()).toEqual({ error: 'unauthorized' })
    expect(db.dump('users')).toEqual([])
  })

  it('signs in, sets a host-only HttpOnly cookie, and stores only the token hash', async () => {
    const response = await signIn(token())
    expect(response.headers.get('set-cookie')).toMatch(/^__Host-epilog_session=[\w-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=7776000$/)
    const raw = response.headers.get('set-cookie')!.split(/[=;]/)[1]
    expect(JSON.stringify(db.dump('sessions'))).not.toContain(raw)
    expect(await response.json()).toEqual({ email: 'ada@example.test', name: 'Ada' })
    expect(db.dump('sessions')).toEqual([expect.objectContaining({ expires_at: start + 90 * day })])

    // Signing in again keeps the same user, refreshes the profile, and drops expired sessions.
    now = start + 91 * day
    await signIn(token({ name: 'Ada L.', exp: now / 1000 + 60 }))
    expect(db.dump('users')).toEqual([expect.objectContaining({ google_sub: 'google-sub-1', name: 'Ada L.', revision: 0 })])
    expect(db.dump('sessions')).toEqual([expect.objectContaining({ expires_at: now + 90 * day })])
  })

  it('requires JSON and a same-origin request to sign in', async () => {
    const body = JSON.stringify({ credential: await token() })
    const post = (headers: Record<string, string>) => call('/api/auth/google', { method: 'POST', headers, body })
    expect((await post({ Origin: origin, 'Content-Type': 'text/plain' })).status).toBe(400)
    expect((await post({ 'Content-Type': 'application/json' })).status).toBe(403)
    expect((await post({ Origin: 'https://evil.test', 'Content-Type': 'application/json' })).status).toBe(403)
    expect((await post({ Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await call('/api/auth/google')).status).toBe(405)
    expect(db.dump('users')).toEqual([])
    const limited = { ...env, CATALOG_RATE_LIMITER: { limit: async () => ({ success: false }) } }
    const response = await worker.fetch(new Request(`${origin}/api/auth/google`, mutate('POST', undefined, { credential: await token() })), limited)
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
  })

  it('returns the account for a session and 401 without one', async () => {
    const cookie = await session()
    const account = await call('/api/account', { headers: { Cookie: cookie } })
    expect(account.status).toBe(200)
    expect(await account.json()).toEqual({ email: 'ada@example.test', name: 'Ada' })
    expect(account.headers.get('set-cookie')).toBeNull()
    expect((await call('/api/account')).status).toBe(401)
    expect((await call('/api/account', { headers: { Cookie: '__Host-epilog_session=' + 'x'.repeat(43) } })).status).toBe(401)

    // The session slides once less than 60 days remain, and expires after 90 idle days.
    now = start + 31 * day
    const slid = await call('/api/account', { headers: { Cookie: cookie } })
    expect(slid.headers.get('set-cookie')).toBe(`${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=7776000`)
    expect(db.dump('sessions')).toEqual([expect.objectContaining({ expires_at: now + 90 * day })])
    now += 90 * day
    expect((await call('/api/account', { headers: { Cookie: cookie } })).status).toBe(401)
  })

  it('signs out by deleting the session and clearing the cookie', async () => {
    const cookie = await session()
    const response = await call('/api/auth/logout', mutate('POST', cookie))
    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toBe('__Host-epilog_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0')
    expect(db.dump('sessions')).toEqual([])
    expect((await call('/api/account', { headers: { Cookie: cookie } })).status).toBe(401)
  })

  it('deleting the account leaves no rows for that user and keeps other users', async () => {
    const ada = await session()
    const grace = await session(token({ sub: 'google-sub-2', email: 'grace@example.test', name: 'Grace' }))
    const [adaId, graceId] = db.dump('users').map((user) => String(user.id))
    for (const id of [adaId, graceId]) {
      await db.prepare('INSERT INTO records (user_id, kind, record_id, data, deleted, updated_at, revision) VALUES (?, ?, ?, ?, 0, 1, 1)').bind(id, 'entry', 'media-1', '{}').run()
    }
    expect((await call('/api/account', mutate('DELETE'))).status).toBe(401)
    const response = await call('/api/account', mutate('DELETE', ada))
    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    for (const table of ['users', 'sessions', 'records'] as const) {
      expect(JSON.stringify(db.dump(table))).not.toContain(adaId)
      expect(db.dump(table)).toHaveLength(1)
    }
    expect((await call('/api/account', { headers: { Cookie: grace } })).status).toBe(200)
  })

  it('serves the client ID, and hides account routes until D1 and the client ID are configured', async () => {
    expect(await (await call('/api/config')).json()).toEqual({ googleClientId: clientId })
    expect((await call('/api/sync', mutate('POST', undefined, {}))).status).toBe(401)
    for (const missing of [{ DB: undefined }, { GOOGLE_CLIENT_ID: undefined }]) {
      env = { ...env, ...missing }
      expect(await (await call('/api/config')).json()).toEqual({ googleClientId: '' })
      expect((await signIn(token())).status).toBe(404)
      expect((await call('/api/account')).status).toBe(404)
      expect((await call('/api/sync', mutate('POST', undefined, {}))).status).toBe(404)
    }
    expect(upstream).not.toHaveBeenCalled()
  })
})
