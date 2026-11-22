import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tombstoneAge } from '../../src/domain/sync'
import type { EntryData, SyncChange } from '../../src/domain/sync'
import { createAccountRoutes } from '../../worker/auth'
import { createCatalogWorker } from '../../worker/index'
import type { Env } from '../../worker/index'
import { handleSync } from '../../worker/sync'
import { createTestD1 } from '../support/test-d1'

const start = 1_800_000_000_000
const origin = 'https://epilog.test'
let db: ReturnType<typeof createTestD1>

beforeEach(async () => {
  db = createTestD1()
  for (const id of ['ada', 'grace']) {
    await db.prepare('INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, 0)').bind(id, `sub-${id}`, `${id}@example.test`, id).run()
  }
})

function entry(id: string, at: number, extra: Partial<EntryData> = {}, groups: Partial<EntryData['groups']> = {}): SyncChange {
  return {
    kind: 'entry', id, at,
    data: {
      format: 'MOVIE', anime: false, catalogRef: 'tmdb:movie:1', createdAt: at,
      groups: { progress: { status: 'Completed', at }, liked: { at }, rating: { at }, watchlisted: { at }, label: { at }, ...groups },
      ...extra,
    },
  }
}
const completion = (id: string, mediaId: string, at: number): SyncChange => ({ kind: 'completion', id, data: { mediaId, date: '2026-11-21' }, at })
const episode = (mediaId: string, at: number): SyncChange =>
  ({ kind: 'episode', id: `${mediaId}:1:1`, data: { mediaId, season: 1, number: 1, watched: true }, at })
const sync = (user: string, cursor: number, changes: SyncChange[] = [], now = start) => handleSync(db, user, { cursor, changes }, now)
const revision = (user: string) => db.dump('users').find((row) => row.id === user)?.revision

describe('handleSync', () => {
  it('round-trips changes between two devices of one user', async () => {
    const pushed = await sync('ada', 0, [entry('m1', 100), completion('c1', 'm1', 100)])
    // Nothing comes back that the device just sent.
    expect(pushed).toEqual({ cursor: 2, changes: [], remap: {}, more: false })

    const pulled = await sync('ada', 0)
    expect(pulled).toEqual({ cursor: 2, changes: [entry('m1', 100), completion('c1', 'm1', 100)], remap: {}, more: false })

    const rated = entry('m1', 100, {}, { rating: { value: 4, at: 200 } })
    await sync('ada', 2, [rated])
    expect(await sync('ada', 2)).toEqual({ cursor: 3, changes: [{ ...rated, at: 200 }], remap: {}, more: false })
  })

  it('never returns another user\'s records', async () => {
    await sync('ada', 0, [entry('m1', 100), completion('c1', 'm1', 100)])
    // Grace's device uses the same ids and catalogRef; nothing of Ada's is merged, remapped or returned.
    const grace = await sync('grace', 0, [entry('m1', 50, { anime: true }), entry('g2', 60, { catalogRef: 'tmdb:movie:2' })])
    expect(grace.remap).toEqual({})
    expect(grace.changes).toEqual([])
    expect((await sync('grace', 0)).changes).toEqual([entry('m1', 50, { anime: true }), entry('g2', 60, { catalogRef: 'tmdb:movie:2' })])
    expect((await sync('ada', 0)).changes).toEqual([entry('m1', 100), completion('c1', 'm1', 100)])
    expect(revision('ada')).toBe(2)
    expect(revision('grace')).toBe(2)
    // Ada's alias stays Ada's.
    expect((await sync('ada', 2, [entry('dup', 300, { catalogRef: 'tmdb:movie:2' })])).remap).toEqual({})
    expect((await sync('ada', 3, [entry('dup2', 300, { catalogRef: 'tmdb:movie:2' })])).remap).toEqual({ dup2: 'dup' })
    expect((await sync('grace', 0)).remap).toEqual({})
    expect(db.dump('aliases')).toEqual([expect.objectContaining({ user_id: 'ada', from_id: 'dup2', to_id: 'dup' })])
  })

  it('is idempotent when the same push is retried', async () => {
    const body = [entry('m1', 100), completion('c1', 'm1', 100), episode('m1', 100)]
    await sync('ada', 0, body)
    const records = db.dump('records')
    const retried = await sync('ada', 0, body)
    expect(retried).toEqual({ cursor: 3, changes: [], remap: {}, more: false })
    expect(revision('ada')).toBe(3)
    expect(db.dump('records')).toEqual(records)
  })

  it('remaps a duplicate catalogRef to the existing record', async () => {
    await sync('ada', 0, [entry('a1', 100), completion('c1', 'a1', 100)])
    const b = await sync('ada', 0, [entry('b1', 200), completion('c2', 'b1', 200), episode('b1', 200)])
    expect(b.remap).toEqual({ b1: 'a1' })

    const pulled = await sync('ada', 0)
    const entries = pulled.changes.filter((change) => change.kind === 'entry')
    expect(entries.map((change) => change.id)).toEqual(['a1'])
    expect(entries[0]).toEqual({ ...entry('a1', 200), data: { ...entry('a1', 200).data, createdAt: 100 } })
    const completions = pulled.changes.filter((change) => change.kind === 'completion')
    expect(completions.map((change) => [change.id, change.data && 'mediaId' in change.data && change.data.mediaId]))
      .toEqual([['c1', 'a1'], ['c2', 'a1']])
    expect(pulled.changes.filter((change) => change.kind === 'episode')).toEqual([episode('a1', 200)])
  })

  it('starts over when another device syncs between its reads and its write', async () => {
    await sync('ada', 0, [entry('m1', 100)])
    let raced = false
    const racing: typeof db = {
      ...db,
      async batch(statements) {
        if (statements.length >= 6 && !raced) {
          raced = true
          await sync('ada', 1, [entry('m1', 100, {}, { rating: { value: 2, at: 300 } })])
        }
        return db.batch(statements)
      },
    }
    await handleSync(racing, 'ada', { cursor: 1, changes: [entry('m1', 100, {}, { liked: { value: true, at: 200 } })] }, start)
    expect(raced).toBe(true)
    const [m1] = (await sync('ada', 0)).changes
    expect(m1.data).toMatchObject({ groups: { liked: { value: true, at: 200 }, rating: { value: 2, at: 300 } } })
    expect(revision('ada')).toBe(3)
  })

  it('moves an id that already has a live server row into the canonical entry, children included', async () => {
    // Device A logged a1 before its catalog ID was known; device B logged the same title as b1.
    await sync('ada', 0, [entry('a1', 100, { catalogRef: undefined }, { rating: { value: 3, at: 250 } }), completion('c1', 'a1', 100), episode('a1', 100)])
    await sync('ada', 3, [entry('b1', 200)])
    // A's background lookup fills in the catalog ID and pushes a1 again (here without the stored rating, which still merges in).
    const pushed = await sync('ada', 4, [entry('a1', 100)])
    expect(pushed.remap).toEqual({ a1: 'b1' })

    const pulled = await sync('ada', 0)
    const live = pulled.changes.filter((change) => change.data)
    expect(live.filter((change) => change.kind === 'entry').map((change) => change.id)).toEqual(['b1'])
    expect(live.find((change) => change.kind === 'entry')?.data).toMatchObject({ catalogRef: 'tmdb:movie:1', createdAt: 100, groups: { rating: { value: 3, at: 250 } } })
    expect(live.filter((change) => change.kind !== 'entry')).toEqual(expect.arrayContaining([completion('c1', 'b1', 100), episode('b1', 100)]))
    expect(live).toHaveLength(3)
    expect(db.dump('records').filter((row) => row.kind === 'entry' && row.deleted === 0)).toHaveLength(1)
    expect(db.dump('records').find((row) => row.record_id === 'a1')).toMatchObject({ deleted: 1, catalog_ref: null })

    // A later push that still uses the old id lands under the canonical one.
    await sync('ada', pulled.cursor, [completion('c3', 'a1', 300), episode('a1', 300)])
    const late = (await sync('ada', pulled.cursor)).changes
    expect(late).toEqual([completion('c3', 'b1', 300), { ...episode('b1', 300) }])
    expect(db.dump('records').filter((row) => row.kind === 'entry' && row.deleted === 0)).toHaveLength(1)
  })

  it('tells a device pulling from an older cursor about the alias and the old entry\'s tombstone', async () => {
    await sync('ada', 0, [entry('a1', 100, { catalogRef: undefined })])
    await sync('ada', 1, [entry('b1', 200)])
    await sync('ada', 2, [entry('a1', 100)])
    const other = await sync('ada', 2)
    expect(other.remap).toEqual({ a1: 'b1' })
    expect(other.changes).toEqual(expect.arrayContaining([{ kind: 'entry', id: 'a1', data: null, at: start }]))
    // A device that has seen it all gets no remap.
    expect((await sync('ada', other.cursor)).remap).toEqual({})
  })

  it('does not remap a new entry onto a deleted one with the same catalogRef', async () => {
    await sync('ada', 0, [entry('a1', 100)])
    await sync('ada', 1, [{ kind: 'entry', id: 'a1', data: null, at: 200 }])
    expect(db.dump('records')[0]).toMatchObject({ deleted: 1, catalog_ref: null })
    const readded = await sync('ada', 2, [entry('b1', 300)])
    expect(readded.remap).toEqual({})
    expect((await sync('ada', 0)).changes.filter((change) => change.data).map((change) => change.id)).toEqual(['b1'])
  })

  it('merges two new entries with the same catalogRef in one request into one', async () => {
    const pushed = await sync('ada', 0, [entry('n1', 100), entry('n2', 200), completion('c1', 'n1', 100), completion('c2', 'n2', 200)])
    expect(pushed.remap).toEqual({ n2: 'n1' })
    const pulled = await sync('ada', 0)
    expect(pulled.changes).toEqual([{ ...entry('n1', 200), data: { ...entry('n1', 200).data, createdAt: 100 } }, completion('c1', 'n1', 100), completion('c2', 'n1', 200)])
    expect(pulled.remap).toEqual({ n2: 'n1' })
  })

  it('clamps a far-future timestamp so a later honest edit still wins', async () => {
    const future = start + 10 * 365 * 86_400_000
    // The change's own `at` is never trusted; it's recomputed from the clamped groups.
    await sync('ada', 0, [{ ...entry('m1', 100, {}, { rating: { value: 1, at: future } }), at: future }, completion('c1', 'm1', future)])
    const stored = (await sync('ada', 0)).changes
    expect(stored.map((change) => change.at)).toEqual([start + 60_000, start + 60_000])

    const later = start + 120_000
    await sync('ada', 2, [entry('m1', 100, {}, { rating: { value: 5, at: later } })], later)
    const [merged] = (await sync('ada', 2, [], later)).changes
    expect(merged.data).toMatchObject({ groups: { rating: { value: 5, at: later } } })
  })

  it('returns each sent record as stored when that differs from what was sent, even when nothing was written', async () => {
    const fast = entry('m1', 100, {}, { rating: { value: 2, at: start + 365 * 86_400_000 } })
    const clamped = { ...entry('m1', 100, {}, { rating: { value: 2, at: start + 60_000 } }), at: start + 60_000 }
    expect((await sync('ada', 0, [fast])).changes).toEqual([clamped])

    const later = start + 120_000
    const honest = entry('m1', 100, {}, { rating: { value: 4, at: later } })
    await sync('ada', 1, [honest], later)
    // A device re-pushing its older copy changes nothing, and still learns the stored row.
    const stale = await sync('ada', 2, [clamped], later)
    expect(stale).toEqual({ cursor: 2, changes: [{ ...honest, at: later }], remap: {}, more: false })
    expect(revision('ada')).toBe(2)
  })

  it('writes nothing on a sync that changes nothing', async () => {
    await sync('ada', 0, [entry('m1', 100), completion('c1', 'm1', 100)])
    const queries: string[] = []
    const watched: typeof db = { ...db, prepare: (query) => { queries.push(query); return db.prepare(query) } }
    await handleSync(watched, 'ada', { cursor: 2, changes: [] }, start)
    await handleSync(watched, 'ada', { cursor: 0, changes: [entry('m1', 100)] }, start) // a retried push
    expect(queries.filter((query) => /^\s*(INSERT|UPDATE|DELETE)/.test(query))).toEqual([])
    expect(revision('ada')).toBe(2)
  })

  it('pages pulls of more than 500 rows with more: true', async () => {
    const completions = Array.from({ length: 501 }, (_, index) => completion(`c${index}`, 'm1', 100))
    await sync('ada', 0, completions.slice(0, 500))
    await sync('ada', 500, completions.slice(500))
    const first = await sync('ada', 0)
    expect(first).toMatchObject({ cursor: 500, more: true })
    expect(first.changes).toEqual(completions.slice(0, 500))
    expect(await sync('ada', first.cursor)).toEqual({ cursor: 501, changes: completions.slice(500), remap: {}, more: false })
  })

  it('resets a device whose cursor predates purged tombstones', async () => {
    await sync('ada', 0, [entry('m1', 100), entry('m2', 100, { catalogRef: 'tmdb:movie:2' })])
    await sync('ada', 2, [{ kind: 'entry', id: 'm2', data: null, at: start }])
    const later = start + tombstoneAge + 1
    // A current device is unaffected; the purge removes the old tombstone.
    expect(await sync('ada', 3, [], later)).toEqual({ cursor: 3, changes: [], remap: {}, more: false })
    expect(db.dump('records').map((row) => row.record_id)).toEqual(['m1'])
    // A device last seen at revision 2 never saw m2's removal, so it gets every live row and a reset.
    expect(await sync('ada', 2, [], later)).toEqual({ cursor: 3, changes: [entry('m1', 100)], remap: {}, more: false, reset: true })
    // So does a device whose cursor is ahead of the server (a recreated account).
    expect(await sync('ada', 9, [], later)).toMatchObject({ reset: true, cursor: 3 })
    // A brand-new device pulls normally.
    expect(await sync('ada', 0, [], later)).toEqual({ cursor: 3, changes: [entry('m1', 100)], remap: {}, more: false })
  })
})

describe('POST /api/sync', () => {
  const token = 'a'.repeat(43)
  const cookie = `__Host-epilog_session=${token}`
  const limit = vi.fn(async () => ({ success: true }))
  const env: Env = { DB: undefined, GOOGLE_CLIENT_ID: 'client', SYNC_RATE_LIMITER: { limit } }
  const worker = createCatalogWorker(vi.fn<typeof fetch>(), createAccountRoutes({ keys: async () => [], now: () => start }))
  const post = (body: string, expectedSub = 'sub-ada') => worker.fetch(new Request(`${origin}/api/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie,
      ...expectedSub ? { 'X-Epilog-Account': expectedSub } : {} }, body,
  }), { ...env, DB: db })

  beforeEach(async () => {
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), (byte) => byte.toString(16).padStart(2, '0')).join('')
    await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(hash, 'ada', start + 50 * 86_400_000).run()
  })

  it('rejects more than 500 changes and malformed changes with 400', async () => {
    const many = Array.from({ length: 501 }, (_, index) => completion(`c${index}`, 'm1', 100))
    expect((await post(JSON.stringify({ cursor: 0, changes: many }))).status).toBe(400)
    for (const body of [
      { cursor: -1, changes: [] }, { cursor: 0 }, { cursor: 0, changes: [{ kind: 'note', id: 'x', data: null, at: 1 }] },
      { cursor: 0, changes: [entry('m1', 100, { catalogRef: 'tmdb:person:1' })] },
      { cursor: 0, changes: [{ ...episode('m1', 1), id: 'm2:1:1' }] },
    ]) expect((await post(JSON.stringify(body))).status).toBe(400)
    expect((await post('{')).status).toBe(400)
    const huge = await post(JSON.stringify({ cursor: 0, changes: [], pad: 'x'.repeat(1_000_001) }))
    expect(huge.status).toBe(413)
    expect(await huge.json()).toEqual({ error: 'too_large' })
    expect(db.dump('records')).toEqual([])
  })

  it('rejects a queued push belonging to another account or missing its owner', async () => {
    const body = JSON.stringify({ cursor: 0, changes: [entry('m1', 100)] })
    for (const owner of ['sub-grace', '']) {
      const response = await post(body, owner)
      expect(response.status).toBe(401)
      expect(response.headers.has('set-cookie')).toBe(false)
      expect(db.dump('records')).toEqual([])
      expect(revision('ada')).toBe(0)
      expect(revision('grace')).toBe(0)
    }
  })

  it('syncs for the session user, limited per user, and requires a session', async () => {
    const response = await post(JSON.stringify({ cursor: 0, changes: [entry('m1', 100)] }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ cursor: 1, changes: [], remap: {}, more: false })
    expect(limit).toHaveBeenLastCalledWith({ key: 'ada' })
    // The session has under 60 days left, so it slides, on errors too.
    expect(response.headers.get('set-cookie')).toContain(`${cookie}; HttpOnly`)
    await db.prepare('UPDATE sessions SET expires_at = ?').bind(start + 50 * 86_400_000).run()
    expect(db.dump('records')).toEqual([expect.objectContaining({ user_id: 'ada', record_id: 'm1', catalog_ref: 'tmdb:movie:1' })])

    limit.mockResolvedValueOnce({ success: false })
    const limited = await post(JSON.stringify({ cursor: 0, changes: [] }))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('set-cookie')).toContain(`${cookie}; HttpOnly`)
    const anonymous = await worker.fetch(new Request(`${origin}/api/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}',
    }), { ...env, DB: db })
    expect(anonymous.status).toBe(401)
  })
})
