import { z } from 'zod'
import { clampTime, groupNames, maxChanges, mergeChange, syncChangeSchema, tombstoneAge } from '../src/domain/sync'
import type { EntryData, SyncChange } from '../src/domain/sync'
import type { D1Database } from './d1'
import { CatalogFailure } from './http'

export interface SyncResponse { cursor: number; changes: SyncChange[]; remap: Record<string, string>; more: boolean; reset?: true }
type Row = { kind: SyncChange['kind']; record_id: string; data: string | null; updated_at: number; revision: number }
type Alias = { from_id: string; to_id: string }

const bodySchema = z.object({ cursor: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER), changes: z.array(syncChangeSchema).max(maxChanges) })
const pageSize = 500
const attempts = 3
const columns = 'kind, record_id, data, updated_at, revision'

// Sorted keys, so equal records always store the same text.
const sortKeys = (_: string, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) : value
const serialize = (data: SyncChange['data']) => (data ? JSON.stringify(data, sortKeys) : null)
const recordKey = (kind: string, id: string) => JSON.stringify([kind, id])
const fingerprint = (kind: string, id: string, data: string | null, at: number) => JSON.stringify([kind, id, data, at])
const toChange = (row: Row) => ({ kind: row.kind, id: row.record_id, data: row.data === null ? null : JSON.parse(row.data), at: row.updated_at }) as SyncChange
const unique = <T>(values: T[]) => [...new Set(values)]

// Never trust a device's clock past now + 1 minute, and never trust an entry's own `at`: it's the latest group time.
function clamp(change: SyncChange, now: number): SyncChange {
  if (change.kind !== 'entry' || !change.data) return { ...change, at: clampTime(change.at, now) }
  const { data } = change
  const groups = Object.fromEntries(groupNames.map((name) => [name, { ...data.groups[name], at: clampTime(data.groups[name].at, now) }])) as EntryData['groups']
  return { ...change, data: { ...data, groups }, at: Math.max(...groupNames.map((name) => groups[name].at)) }
}

// Entries and live children move to the canonical id. Child tombstones keep their id: they delete what they name, and a
// device that just remapped sends tombstones for its old episode ids that must not delete the moved episodes.
function rekey(change: SyncChange, resolve: (id: string) => string): SyncChange {
  if (change.kind === 'entry') return { ...change, id: resolve(change.id) }
  if (!change.data || resolve(change.data.mediaId) === change.data.mediaId) return change
  const mediaId = resolve(change.data.mediaId)
  if (change.kind === 'completion') return { ...change, data: { ...change.data, mediaId } }
  const data = { ...change.data, mediaId }
  return { ...change, id: `${mediaId}:${data.season}:${data.number}`, data }
}

export async function handleSync(db: D1Database, userId: string, body: unknown, now: number): Promise<SyncResponse> {
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) throw new CatalogFailure(400)
  // Another device's sync landing between our reads and our write aborts the write batch; start over from fresh reads.
  for (let attempt = 1; ; attempt++) {
    try {
      return await apply(db, userId, parsed.data.cursor, parsed.data.changes, now)
    } catch (error) {
      if (error instanceof CatalogFailure) throw error
      if (attempt === attempts) throw new CatalogFailure(503)
    }
  }
}

async function apply(db: D1Database, userId: string, cursor: number, sent: SyncChange[], now: number): Promise<SyncResponse> {
  const horizon = now - tombstoneAge
  const clamped = sent.map((change) => clamp(change, now))
  const refs = unique(clamped.flatMap((change) => (change.kind === 'entry' && change.data?.catalogRef ? [change.data.catalogRef] : [])))
  const mediaIds = unique(clamped.flatMap((change) => (change.kind === 'entry' ? [change.id] : change.data ? [change.data.mediaId] : [])))
  const [users, purged, owners, known] = await db.batch([
    db.prepare('SELECT revision, purged_before FROM users WHERE id = ?').bind(userId),
    db.prepare('SELECT MAX(revision) AS revision FROM records WHERE user_id = ? AND deleted = 1 AND updated_at < ?').bind(userId, horizon),
    db.prepare('SELECT catalog_ref, record_id, revision FROM records WHERE user_id = ? AND catalog_ref IN (SELECT value FROM json_each(?))')
      .bind(userId, JSON.stringify(refs)),
    db.prepare('SELECT from_id, to_id FROM aliases WHERE user_id = ? AND from_id IN (SELECT value FROM json_each(?))')
      .bind(userId, JSON.stringify(mediaIds)),
  ])
  const user = users.results[0] as { revision: number; purged_before: number } | undefined
  if (!user) throw new CatalogFailure(401)
  const toPurge = (purged.results[0] as { revision: number | null }).revision
  const purgedBefore = Math.max(user.purged_before, toPurge ?? 0)

  // Stored aliases always point at a final id; new ones can chain within this request.
  const aliases = new Map((known.results as Alias[]).map((alias) => [alias.from_id, alias.to_id]))
  const resolve = (id: string) => {
    for (let hops = 0; hops < 8 && aliases.has(id); hops++) id = aliases.get(id)!
    return id
  }
  // An entry whose catalogRef already belongs to another live entry merges into it: the one with the lowest revision.
  const claims = new Map<string, string>()
  for (const owner of (owners.results as { catalog_ref: string; record_id: string; revision: number }[]).sort((a, b) => a.revision - b.revision)) {
    if (!claims.has(owner.catalog_ref)) claims.set(owner.catalog_ref, owner.record_id)
  }
  const created = new Map<string, string>()
  for (const change of clamped) {
    const ref = change.kind === 'entry' ? change.data?.catalogRef : undefined
    if (!ref) continue
    const id = resolve(change.id)
    const target = resolve(claims.get(ref) ?? id)
    if (!claims.has(ref)) claims.set(ref, id)
    if (target === id) continue
    aliases.set(id, target)
    created.set(id, ref)
  }
  const rekeyed = clamped.map((change) => rekey(change, resolve))
  const changes = [...rekeyed.filter((change) => change.kind === 'entry'), ...rekeyed.filter((change) => change.kind !== 'entry')]
  const froms = [...created.keys()]

  // Stored rows for every key touched, plus the children of each newly remapped id and the episodes of its target.
  const keys = [...changes.map((change) => [change.kind, change.id]), ...froms.map((from) => ['entry', from])]
  const reads = [
    db.prepare(`SELECT ${columns} FROM json_each(?) AS j CROSS JOIN records AS r
      WHERE r.user_id = ? AND r.kind = j.value ->> 0 AND r.record_id = j.value ->> 1`).bind(JSON.stringify(keys), userId),
  ]
  if (froms.length) {
    reads.push(
      db.prepare(`SELECT ${columns} FROM json_each(?) AS j CROSS JOIN records AS r WHERE r.user_id = ? AND r.kind = 'episode'
        AND r.record_id > j.value || ':' AND r.record_id < j.value || ';'`).bind(JSON.stringify(unique([...froms, ...froms.map(resolve)])), userId),
      // ponytail: scans this user's completions, only on a request that creates a remap; index data ->> 'mediaId' if that grows costly.
      db.prepare(`SELECT ${columns} FROM records WHERE user_id = ? AND kind = 'completion' AND data ->> 'mediaId' IN (SELECT value FROM json_each(?))`)
        .bind(userId, JSON.stringify(froms)),
    )
  }
  const stored = keys.length ? (await db.batch<Row>(reads)).flatMap((result) => result.results) : []
  const rows = new Map(stored.map((row) => [recordKey(row.kind, row.record_id), row]))

  const state = new Map<string, SyncChange | undefined>()
  const current = (kind: string, id: string) => {
    const key = recordKey(kind, id)
    if (state.has(key)) return state.get(key)
    const row = rows.get(key)
    return row && toChange(row)
  }
  const put = (change: SyncChange, merge = true) => state.set(recordKey(change.kind, change.id), merge ? mergeChange(current(change.kind, change.id), change) : change)
  // A remapped id's server rows move to the target: its entry merges in and is tombstoned, its children are re-keyed.
  // These tombstones are stamped with server time, so they're purged 180 days from now, not from the old edit.
  for (const [from, ref] of created) {
    const old = current('entry', from)
    if (old?.kind !== 'entry' || !old.data) continue
    put({ ...old, id: resolve(from), data: { ...old.data, catalogRef: ref } })
    put({ kind: 'entry', id: from, data: null, at: Math.max(old.at, now) }, false)
  }
  for (const row of rows.values()) {
    const child = toChange(row)
    if (child.kind === 'entry' || !child.data || !created.has(child.data.mediaId)) continue
    if (child.kind === 'completion') put(rekey(child, resolve), false)
    else {
      put({ ...child, data: null, at: Math.max(child.at, now) }, false)
      put(rekey(child, resolve))
    }
  }
  for (const change of changes) put(change)

  const written = [...state].flatMap(([key, change]) => {
    const row = rows.get(key)
    if (!change) return []
    const data = serialize(change.data)
    if (row && fingerprint(row.kind, row.record_id, row.data, row.updated_at) === fingerprint(change.kind, change.id, data, change.at)) return []
    return [{ kind: change.kind, id: change.id, data, at: change.at, catalogRef: change.kind === 'entry' && change.data?.catalogRef || null }]
  }).map((row, index) => ({ ...row, deleted: row.data === null ? 1 : 0, revision: user.revision + index + 1 }))
  const newAliases = froms.map((from, index) => [from, resolve(from), user.revision + written.length + index + 1])
  const revision = user.revision + written.length + newAliases.length
  const reset = cursor > 0 && (cursor < purgedBefore || cursor > user.revision)
  // Each record the device sent, as stored now, when that differs from what it sent (clamped times, a newer group
  // elsewhere): the device adopts these as is, even when nothing was written and so no revision would carry them.
  const print = (change: SyncChange) => fingerprint(change.kind, change.id, serialize(change.data), change.at)
  const corrected = new Map(sent.flatMap((change, index) => {
    const stored = state.get(recordKey(rekeyed[index].kind, rekeyed[index].id))
    return stored && print(stored) !== print(change) ? [[print(stored), stored]] : []
  }))
  const corrections = [...corrected.values()]
  // A sync that changes nothing writes nothing: no gate, no purge and no revision bump.
  const idle = !written.length && !newAliases.length && toPurge === null

  const writes = idle ? [] : [
    // The gate: fails the whole batch (NOT NULL on google_sub) unless the revision is still the one we read.
    db.prepare(`INSERT INTO users (id, google_sub, email, name, created_at) SELECT ?, NULL, '', '', 0
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = ? AND revision = ?)`).bind(userId, userId, user.revision),
    db.prepare('DELETE FROM records WHERE user_id = ? AND deleted = 1 AND updated_at < ?').bind(userId, horizon),
    db.prepare(`INSERT INTO records (user_id, kind, record_id, data, deleted, updated_at, revision, catalog_ref)
      SELECT ?, value ->> 'kind', value ->> 'id', value ->> 'data', value ->> 'deleted', value ->> 'at', value ->> 'revision', value ->> 'catalogRef'
      FROM json_each(?) WHERE true
      ON CONFLICT (user_id, kind, record_id) DO UPDATE SET data = excluded.data, deleted = excluded.deleted,
        updated_at = excluded.updated_at, revision = excluded.revision, catalog_ref = excluded.catalog_ref`)
      .bind(userId, JSON.stringify(written)),
  ]
  if (newAliases.length) {
    const json = JSON.stringify(newAliases)
    writes.push(
      db.prepare(`INSERT INTO aliases (user_id, from_id, to_id, revision) SELECT ?, value ->> 0, value ->> 1, value ->> 2 FROM json_each(?) WHERE true
        ON CONFLICT (user_id, from_id) DO UPDATE SET to_id = excluded.to_id, revision = excluded.revision`).bind(userId, json),
      // Older aliases that pointed at a newly remapped id now point at its target.
      db.prepare(`UPDATE aliases SET to_id = (SELECT value ->> 1 FROM json_each(?) WHERE value ->> 0 = aliases.to_id), revision = ?
        WHERE user_id = ? AND to_id IN (SELECT value ->> 0 FROM json_each(?))`).bind(json, revision, userId, json),
    )
  }
  if (!idle) writes.push(db.prepare('UPDATE users SET revision = ?, purged_before = MAX(purged_before, ?) WHERE id = ?').bind(revision, purgedBefore, userId))
  const results = await db.batch([
    ...writes,
    reset
      // ponytail: a reset returns every live row in one response; page it if libraries outgrow a Worker response.
      ? db.prepare(`SELECT ${columns} FROM records WHERE user_id = ? AND deleted = 0 ORDER BY revision`).bind(userId)
      : db.prepare(`SELECT ${columns} FROM records WHERE user_id = ? AND revision > ? ORDER BY revision LIMIT ?`).bind(userId, cursor, pageSize + 1),
    db.prepare('SELECT from_id, to_id FROM aliases WHERE user_id = ? AND revision > ?').bind(userId, reset ? -1 : cursor),
  ])
  const page = results.at(-2)!.results as Row[]
  // Every alias the device may not know yet, plus any its own entries were just moved by.
  const remap = Object.fromEntries([
    ...(results.at(-1)!.results as Alias[]).map((alias) => [alias.from_id, alias.to_id]),
    ...clamped.flatMap((change) => (change.kind === 'entry' && resolve(change.id) !== change.id ? [[change.id, resolve(change.id)]] : [])),
  ])
  // Corrections go first, so any newer row in the page still lands after them.
  const rest = (rows: Row[]) => rows.filter((row) => !corrected.has(fingerprint(row.kind, row.record_id, row.data, row.updated_at))).map(toChange)
  if (reset) return { cursor: revision, changes: [...corrections, ...rest(page)], remap, more: false, reset: true }

  const more = page.length > pageSize
  const pageRows = page.slice(0, pageSize)
  // What the device just sent, it already has.
  const echoes = new Set(sent.map(print))
  return {
    cursor: more ? pageRows[pageSize - 1].revision : revision,
    changes: [...corrections, ...rest(pageRows.filter((row) => !echoes.has(fingerprint(row.kind, row.record_id, row.data, row.updated_at))))],
    remap,
    more,
  }
}
