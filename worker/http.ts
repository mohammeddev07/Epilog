const timeout = 6500
const responseLimit = 1_500_000

export class CatalogFailure extends Error {
  constructor(readonly status: number, readonly retryAfter?: number) {
    super('Catalog request failed.')
  }
}

export const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const errors = {
  400: 'invalid_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'too_large',
  429: 'rate_limited',
  502: 'provider_unavailable',
  503: 'provider_unavailable',
  504: 'provider_timeout',
} as const

export function errorResponse(error: unknown, cookie?: string): Response {
  const failureStatus = error instanceof CatalogFailure ? error.status : error instanceof URIError ? 400 : 502
  const status = failureStatus in errors ? failureStatus as keyof typeof errors : 503
  const headers = new Headers(responseHeaders)
  if (error instanceof CatalogFailure && error.retryAfter) headers.set('Retry-After', String(error.retryAfter))
  if (cookie) headers.set('Set-Cookie', cookie)
  return Response.json({ error: errors[status] }, { status, headers })
}

// Pages forwards /api/* to this Worker, so every legitimate request is same-origin.
export function rejectCrossSite(request: Request, url: URL) {
  const origin = request.headers.get('origin')
  if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new CatalogFailure(403)
  }
}

export function isJson(request: Request) {
  return request.headers.get('content-type')?.toLowerCase().startsWith('application/json') ?? false
}

export async function readJson(message: Request | Response, limit: number, invalidStatus: number, tooLarge = invalidStatus): Promise<unknown> {
  const size = Number(message.headers.get('content-length') ?? 0)
  if (size > limit) throw new CatalogFailure(tooLarge)
  if (!message.body) throw new CatalogFailure(invalidStatus)
  const reader = message.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value.byteLength
      if (received > limit) {
        void reader.cancel().catch(() => undefined)
        throw new CatalogFailure(tooLarge)
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } catch (error) {
    if (error instanceof CatalogFailure) throw error
    throw new CatalogFailure(invalidStatus)
  } finally {
    reader.releaseLock()
  }
}

export type FetchProvider = typeof fetch

export async function providerJson(fetcher: FetchProvider, url: string, init: RequestInit) {
  try {
    const response = await fetcher(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
    })
    if (response.status === 429) {
      const header = response.headers.get('retry-after')
      const seconds = header === null ? Number.NaN : Number(header)
      const dateSeconds = header === null ? Number.NaN : (Date.parse(header) - Date.now()) / 1000
      const delay = Number.isFinite(seconds) ? seconds : Number.isFinite(dateSeconds) ? dateSeconds : 4
      throw new CatalogFailure(429, Math.min(60, Math.max(1, Math.ceil(delay))))
    }
    if ([401, 403, 404].includes(response.status)) throw new CatalogFailure(response.status)
    if (!response.ok) throw new CatalogFailure(502)
    return await readJson(response, responseLimit, 502)
  } catch (error) {
    if (error instanceof CatalogFailure) throw error
    if (error instanceof Error && error.name === 'TimeoutError') throw new CatalogFailure(504)
    throw new CatalogFailure(502)
  }
}

export type JsonObject = Record<string, unknown>

export function record(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

export function records(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    const raw = record(item)
    return raw ? [raw] : []
  })
}

export function plainText(value: unknown, limit: number) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

export function nonnegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function externalId(value: unknown) {
  const id = nonnegativeInteger(value)
  return id && id < 1_000_000_000_000 ? String(id) : undefined
}

export function validYear(value: unknown) {
  const year = nonnegativeInteger(value)
  return year && year >= 1000 && year <= 9999 ? year : undefined
}

export class Cooldown {
  private until = 0

  check() {
    const seconds = Math.ceil((this.until - Date.now()) / 1000)
    if (seconds > 0) throw new CatalogFailure(429, seconds)
  }

  async run<T>(request: () => Promise<T>) {
    this.check()
    try {
      return await request()
    } catch (error) {
      if (error instanceof CatalogFailure && error.status === 429) {
        this.until = Math.max(this.until, Date.now() + (error.retryAfter ?? 4) * 1000)
      }
      throw error
    }
  }
}
