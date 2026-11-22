import { z } from 'zod'
import { clampTime, groupNames, maxChanges, mergeChange, syncChangeSchema, tombstoneAge } from '../src/domain/sync'
import type { EntryData, SyncChange } from '../src/domain/sync'
import type { D1Database } from './d1'
import { CatalogFailure } from './http'

export interface SyncResponse { cursor: number; changes: SyncChange[]; remap: Record<string, string>; more: boolean; reset?: true }
type Row = { kind: SyncChange['kind']; record_id: string; data: string | null; updated_at: number; revision: number }

const bodySchema = z.object({ cursor: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER), changes: z.array(syncChangeSchema).max(maxChanges) })
const pageSize = 500
const attempts = 3

// Sorted keys, so equal records always store the same text.
const sortKeys = (_: string, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) : value
const serialize = (data: SyncChange['data']) => (data ? JSON.stringify(data, sortKeys) : null)
const recordKey = (kind: string, id: string) => JSON.stringify([kind, id])
const fingerprint = (kind: string, id: string, data: string | null, at: number) => JSON.stringify([kind, id, data, at])
const toChange = (row: Row) => ({ kind: row.kind, id: row.record_id, data: row.data === null ? null : JSON.parse(row.data), at: row.updated_at }) as SyncChange

// Never trust a device's clock past now + 1 minute, and never trust an entry's own `at`: it's the latest group time.
function clamp(change: SyncChange, now: number): SyncChange {
  if (change.kind !== 'entry' || !change.data) return { ...change, at: clampTime(change.at, now) }
  const { data } = change
  const groups = Object.fromEntries(groupNames.map((name) => [name, { ...data.groups[name], at: clampTime(data.groups[name].at, now) }])) as EntryData['groups']
  return { ...change, data: { ...data, groups }, at: Math.max(...groupNames.map((name) => groups[name].at)) }
}

// Children of a remapped entry move to the canonical id. Tombstones keep their id: they delete what they name.
function rekey(change: SyncChange, remap: Map<string, string>): SyncChange {
  const mediaId = change.kind !== 'entry' && change.data ? remap.get(change.data.mediaId) : undefined
  if (!mediaId) return change
  if (change.kind === 'completion' && change.data) return { ...change, data: { ...change.data, mediaId } }
  if (change.kind === 'episode' && change.data) {
    const data = { ...change.data, mediaId }
    return { ...change, id: `${mediaId}:${data.season}:${data.number}`, data }
  }
  return change
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
  const refs = [...new Set(clamped.flatMap((change) => (change.kind === 'entry' && change.data?.catalogRef ? [change.data.catalogRef] : [])))]
  const [users, purged, owners] = await db.batch([
    db.prepare('SELECT revision, purged_before FROM users WHERE id = ?').bind(userId),
    db.prepare('SELECT MAX(revision) AS revision FROM records WHERE user_id = ? AND deleted = 1 AND updated_at < ?').bind(userId, horizon),
    db.prepare('SELECT catalog_ref, record_id FROM records WHERE user_id = ? AND catalog_ref IN (SELECT value FROM json_each(?))')
      .bind(userId, JSON.stringify(refs)),
  ])
  const user = users.results[0] as { revision: number; purged_before: number } | undefined
  if (!user) throw new CatalogFailure(401)
  const purgedBefore = Math.max(user.purged_before, Number((purged.results[0] as { revision: number | null }).revision ?? 0))

  // An entry whose catalogRef already belongs to another live entry merges into that one.
  const claims = new Map<string, string[]>()
  for (const { catalog_ref: ref, record_id: id } of owners.results as { catalog_ref: string; record_id: string }[]) claims.set(ref, [...claims.get(ref) ?? [], id])
  const remap = new Map<string, string>()
  const entries = clamped.filter((change) => change.kind === 'entry').map((change) => {
    const ref = change.data?.catalogRef
    if (!ref) return change
    const ids = claims.get(ref) ?? []
    if (!ids.length) claims.set(ref, [change.id])
    if (!ids.length || ids.includes(change.id)) return change
    remap.set(change.id, ids[0])
    return { ...change, id: ids[0] }
  })
  const changes = [...entries, ...clamped.filter((change) => change.kind !== 'entry').map((change) => rekey(change, remap))]

  const keys = changes.map((change) => [change.kind, change.id])
  const stored = keys.length ? (await db.prepare(`SELECT r.kind, r.record_id, r.data, r.updated_at, r.revision FROM json_each(?) AS j
    CROSS JOIN records AS r WHERE r.user_id = ? AND r.kind = j.value ->> 0 AND r.record_id = j.value ->> 1`)
    .bind(JSON.stringify(keys), userId).all<Row>()).results : []
  const rows = new Map(stored.map((row) => [recordKey(row.kind, row.record_id), row]))
  const merged = new Map<string, SyncChange>()
  for (const change of changes) {
    const key = recordKey(change.kind, change.id)
    const row = rows.get(key)
    merged.set(key, mergeChange(merged.get(key) ?? (row && toChange(row)), change))
  }
  const written = [...merged].flatMap(([key, change]) => {
    const row = rows.get(key)
    const data = serialize(change.data)
    if (row && fingerprint(row.kind, row.record_id, row.data, row.updated_at) === fingerprint(change.kind, change.id, data, change.at)) return []
    return [{ kind: change.kind, id: change.id, data, at: change.at, catalogRef: change.kind === 'entry' && change.data?.catalogRef || null }]
  }).map((row, index) => ({ ...row, deleted: row.data === null ? 1 : 0, revision: user.revision + index + 1 }))
  const revision = user.revision + written.length
  const reset = cursor > 0 && (cursor < purgedBefore || cursor > user.revision)

  const results = await db.batch([
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
    db.prepare('UPDATE users SET revision = ?, purged_before = MAX(purged_before, ?) WHERE id = ?').bind(revision, purgedBefore, userId),
    reset
      // ponytail: a reset returns every live row in one response; page it if libraries outgrow a Worker response.
      ? db.prepare('SELECT kind, record_id, data, updated_at, revision FROM records WHERE user_id = ? AND deleted = 0 ORDER BY revision').bind(userId)
      : db.prepare('SELECT kind, record_id, data, updated_at, revision FROM records WHERE user_id = ? AND revision > ? ORDER BY revision LIMIT ?')
        .bind(userId, cursor, pageSize + 1),
  ])
  const page = results[4].results as Row[]
  const remapped = Object.fromEntries(remap)
  if (reset) return { cursor: revision, changes: page.map(toChange), remap: remapped, more: false, reset: true }

  const more = page.length > pageSize
  const pageRows = page.slice(0, pageSize)
  // What the device just sent, it already has.
  const echoes = new Set(sent.map((change) => fingerprint(change.kind, change.id, serialize(change.data), change.at)))
  return {
    cursor: more ? pageRows[pageSize - 1].revision : revision,
    changes: pageRows.filter((row) => !echoes.has(fingerprint(row.kind, row.record_id, row.data, row.updated_at))).map(toChange),
    remap: remapped,
    more,
  }
}
