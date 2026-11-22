import { maxSyncBytes } from '../src/domain/sync'
import type { D1Database } from './d1'
import { CatalogFailure, errorResponse, isJson, readJson, record, rejectCrossSite, responseHeaders } from './http'
import type { Env } from './index'
import { handleSync } from './sync'

const cookieName = '__Host-epilog_session'
const day = 86_400_000
const sessionAge = 90 * day
const slideBelow = 60 * day
const issuers = ['accounts.google.com', 'https://accounts.google.com']
const certsUrl = 'https://www.googleapis.com/oauth2/v3/certs'
const encoder = new TextEncoder()
const routes = ['POST /api/auth/google', 'POST /api/auth/logout', 'GET /api/account', 'DELETE /api/account', 'POST /api/sync']

const sessionCookie = (token: string, maxAge: number) =>
  `${cookieName}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge / 1000}`

function decode(part: string) {
  if (!/^[\w-]+$/.test(part)) throw new CatalogFailure(401)
  return Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
}

function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256(text: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function verifyGoogleToken(token: string, clientId: string, keys: () => Promise<JsonWebKey[]>, now: number) {
  const available = await keys()
  try {
    const parts = token.split('.')
    if (parts.length !== 3) throw new CatalogFailure(401)
    const [header, claims] = parts.slice(0, 2).map((part) => record(JSON.parse(new TextDecoder().decode(decode(part)))))
    const jwk = available.find((key) => 'kid' in key && key.kid === header?.kid)
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || jwk?.kty !== 'RSA' || !claims) throw new CatalogFailure(401)
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`))
    const { aud, iss, exp, sub, email, name } = claims
    if (!valid || aud !== clientId || !issuers.includes(iss as string) || typeof exp !== 'number' || exp * 1000 <= now ||
      typeof sub !== 'string' || !sub || typeof email !== 'string') throw new CatalogFailure(401)
    return { sub, email, name: typeof name === 'string' ? name : '' }
  } catch {
    throw new CatalogFailure(401)
  }
}

function googleKeys() {
  let cache = { keys: [] as JsonWebKey[], until: 0 }
  return async () => {
    if (cache.until > Date.now()) return cache.keys
    const response = await fetch(certsUrl, { redirect: 'manual', signal: AbortSignal.timeout(6500) })
    if (!response.ok) throw new CatalogFailure(502)
    const body = record(await readJson(response, 65_536, 502))
    const keys = Array.isArray(body?.keys) ? body.keys as JsonWebKey[] : []
    const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1] ?? 0)
    cache = { keys, until: Date.now() + maxAge * 1000 }
    return keys
  }
}

function sessionToken(request: Request) {
  const value = request.headers.get('cookie')?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  return value && /^[\w-]{43}$/.test(value) ? value : undefined
}

// `cookie`, when present, is the renewed Set-Cookie value the caller should send back.
export async function sessionUser(request: Request, db: D1Database, now: number): Promise<{ id: string; cookie?: string } | undefined> {
  const token = sessionToken(request)
  if (!token) return undefined
  const hash = await sha256(token)
  const session = await db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(hash, now).first<{ user_id: string; expires_at: number }>()
  if (!session) return undefined
  if (session.expires_at - now >= slideBelow) return { id: session.user_id }
  await db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(now + sessionAge, hash).run()
  return { id: session.user_id, cookie: sessionCookie(token, sessionAge) }
}

function reply(body: unknown, cookie?: string) {
  const headers = new Headers(responseHeaders)
  if (cookie) headers.set('Set-Cookie', cookie)
  return body === null ? new Response(null, { status: 204, headers }) : Response.json(body, { headers })
}

export function createAccountRoutes(options: { keys?: () => Promise<JsonWebKey[]>; now?: () => number } = {}) {
  const keys = options.keys ?? googleKeys()
  const now = options.now ?? Date.now

  return {
    async fetch(request: Request, env: Env): Promise<Response | undefined> {
      const url = new URL(request.url)
      const path = url.pathname
      if (!['/api/config', '/api/account', '/api/sync'].includes(path) && !path.startsWith('/api/auth/')) return undefined
      let renewed: string | undefined
      try {
        rejectCrossSite(request, url)
        const { DB: db, GOOGLE_CLIENT_ID: clientId } = env
        if (path === '/api/config') {
          if (request.method !== 'GET') throw new CatalogFailure(405)
          return reply({ googleClientId: db && clientId ? clientId : '' })
        }
        if (!db || !clientId) throw new CatalogFailure(404)
        const route = `${request.method} ${path}`
        if (!routes.includes(route)) throw new CatalogFailure(routes.some((item) => item.endsWith(` ${path}`)) ? 405 : 404)
        // State-changing routes: SameSite=Lax plus a required same Origin and a JSON body type (no simple-form CSRF).
        if (request.method !== 'GET') {
          if (request.headers.get('origin') !== url.origin) throw new CatalogFailure(403)
          if (!isJson(request)) throw new CatalogFailure(400)
        }
        const clearCookie = sessionCookie('', 0)

        if (route === 'POST /api/auth/google') {
          const rate = await env.CATALOG_RATE_LIMITER?.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' })
          if (rate && !rate.success) throw new CatalogFailure(429, 60)
          const body = record(await readJson(request, 4096, 400))
          if (typeof body?.credential !== 'string') throw new CatalogFailure(400)
          const time = now()
          const google = await verifyGoogleToken(body.credential, clientId, keys, time)
          const user = await db.prepare(`INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (google_sub) DO UPDATE SET email = excluded.email, name = excluded.name RETURNING id`)
            .bind(crypto.randomUUID(), google.sub, google.email, google.name, time).first<{ id: string }>()
          if (!user) throw new CatalogFailure(503)
          const token = encode(crypto.getRandomValues(new Uint8Array(32)))
          await db.batch([
            db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(user.id, time),
            db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
              .bind(await sha256(token), user.id, time + sessionAge),
          ])
          return reply({ sub: google.sub, email: google.email, name: google.name }, sessionCookie(token, sessionAge))
        }

        if (route === 'POST /api/auth/logout') {
          const token = sessionToken(request)
          if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run()
          return reply(null, clearCookie)
        }

        const user = await sessionUser(request, db, now())
        if (!user) throw new CatalogFailure(401)
        renewed = user.cookie
        if (route === 'POST /api/sync') {
          const rate = await env.SYNC_RATE_LIMITER?.limit({ key: user.id })
          if (rate && !rate.success) throw new CatalogFailure(429, 60)
          return reply(await handleSync(db, user.id, await readJson(request, maxSyncBytes, 400, 413), now()), user.cookie)
        }
        if (route === 'GET /api/account') {
          const account = await db.prepare('SELECT email, name FROM users WHERE id = ?').bind(user.id).first<{ email: string; name: string }>()
          if (!account) throw new CatalogFailure(401)
          return reply({ email: account.email, name: account.name }, user.cookie)
        }
        await db.batch([
          db.prepare('DELETE FROM records WHERE user_id = ?').bind(user.id),
          db.prepare('DELETE FROM aliases WHERE user_id = ?').bind(user.id),
          db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
          db.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
        ])
        return reply(null, clearCookie)
      } catch (error) {
        // A renewed session still reaches the browser when the request itself fails.
        return errorResponse(error, renewed)
      }
    },
  }
}
