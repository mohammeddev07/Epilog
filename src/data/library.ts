import { bookTypes } from '../domain/books'
import { titleLengthLimit } from '../domain/media'
import { Dexie, liveQuery } from 'dexie'
import type { Table } from 'dexie'
import { buildBackup, planRestore } from '../domain/backup'
import type { Backup, BackupEntry, EpisodeActivity, OwnedMedia, RestorePreview } from '../domain/backup'
import type { CatalogPayload, Provider } from '../domain/catalog'
import { catalogCacheAge, catalogKey, parseCatalogKey } from '../domain/identity'
import { episodeKey, isEmptyEntry, localDate, manualEpisode, removeCompletion, updateEntry, updateEpisode, updatePreference } from '../domain/media'
import type { Completion, Episode, EpisodePosition, LibraryEntry, LogDraft, Media, PreferenceChange, Rating, TitlePreferences } from '../domain/media'
import { groupNames, mergeChange } from '../domain/sync'
import type { EntryData, GroupName, SyncChange } from '../domain/sync'
import { demoById } from './demo'

type EntryRow = Pick<BackupEntry, 'status' | 'createdAt' | 'updatedAt' | 'reading' | 'playtimeMinutes'> & TitlePreferences & {
  mediaId: string
  groupsAt?: Partial<Record<GroupName, number>>
}
type CompletionRow = Completion & { mediaId: string }
type EpisodeRow = EpisodeActivity & { mediaId: string }
type ResponseRow = { key: string; payload: CatalogPayload; writtenAt: number; expiresAt: number }
type OutboxKey = { kind: SyncChange['kind']; id: string }
type OutboxRow = OutboxKey & { at: number }
type Account = { sub: string; email: string; name: string; cursor: number; lastSyncAt?: number }
type Meta = { account: Account; lastSub: string; mergeSnapshot: { backup: Backup; expiresAt: number } }
type MetaRow = { [K in keyof Meta]: { key: K; value: Meta[K] } }[keyof Meta]

const responseCacheLimit = 64
const mergeSnapshotAge = 30 * 24 * 60 * 60_000

function trackingFields(row: EntryRow) {
  const { status, createdAt, updatedAt, reading, playtimeMinutes, liked, rating, watchlisted } = row
  return { status, createdAt, updatedAt, reading, playtimeMinutes, liked, rating, watchlisted }
}

type CatalogRow = { key: string; mediaId: string; media: Media; expiresAt: number }

function groupValues(row: Omit<EntryRow, 'groupsAt'> | undefined, label: string | undefined): Record<GroupName, unknown> {
  return { progress: [row?.status, row?.reading, row?.playtimeMinutes], liked: row?.liked, rating: row?.rating, watchlisted: row?.watchlisted, label }
}

const filled = (value: unknown) => Array.isArray(value) ? value.some((item) => item !== undefined) : value !== undefined

/** A group's stamp. Rows saved before v3 use `updatedAt` for groups holding a value, and 0 for empty ones, so they never erase remote values. */
function groupAt(row: EntryRow, label: string | undefined, name: GroupName) {
  return row.groupsAt?.[name] ?? (filled(groupValues(row, label)[name]) ? row.updatedAt : 0)
}

/** Stamps `at` on the groups whose values changed; a new row's empty groups get 0. */
function stampGroups(before: EntryRow | undefined, beforeLabel: string | undefined, after: Omit<EntryRow, 'groupsAt'>, afterLabel: string | undefined, at: number) {
  const old = groupValues(before, beforeLabel)
  const next = groupValues(after, afterLabel)
  return Object.fromEntries(groupNames.map((name) => [name, before && JSON.stringify(old[name]) === JSON.stringify(next[name])
    ? groupAt(before, beforeLabel, name) : before || filled(next[name]) ? at : 0])) as Record<GroupName, number>
}

function entryData(row: EntryRow, media: OwnedMedia): EntryData {
  const at = (name: GroupName) => groupAt(row, media.label, name)
  return {
    format: media.format, anime: media.anime, bookType: media.bookType, catalogRef: media.catalogRef, createdAt: row.createdAt,
    groups: {
      progress: { status: row.status, reading: row.reading, playtimeMinutes: row.playtimeMinutes, at: at('progress') },
      liked: { value: row.liked, at: at('liked') },
      rating: { value: row.rating, at: at('rating') },
      watchlisted: { value: row.watchlisted, at: at('watchlisted') },
      label: { value: media.label, at: at('label') },
    },
  }
}

const latestAt = (data: EntryData) => Math.max(...groupNames.map((name) => data.groups[name].at))
const episodeId = (mediaId: string, { season, number }: EpisodePosition) => `${mediaId}:${season}:${number}`

/** Media ids may contain ':', so read the season and number from the right. */
function episodeRowKey(id: string): [string, number, number] {
  const last = id.lastIndexOf(':')
  const middle = id.lastIndexOf(':', last - 1)
  return [id.slice(0, middle), Number(id.slice(middle + 1, last)), Number(id.slice(last + 1))]
}

class LibraryDatabase extends Dexie {
  declare media: Table<OwnedMedia, string>
  declare entries: Table<EntryRow, string>
  declare completions: Table<CompletionRow, string>
  declare episodes: Table<EpisodeRow, [string, number, number]>
  declare catalog: Table<CatalogRow, string>
  declare responses: Table<ResponseRow, string>
  declare outbox: Table<OutboxRow, [string, string]>
  declare meta: Table<MetaRow, string>

  constructor(name: string) {
    super(name)
    this.version(1).stores({
      media: 'id',
      entries: 'mediaId,status,updatedAt',
      completions: 'id,mediaId',
      episodes: '[mediaId+season+number],mediaId',
      catalog: 'key,&mediaId,expiresAt',
    })
    this.version(2).stores({ responses: 'key,writtenAt,expiresAt' })
    this.version(3).stores({ media: 'id,catalogRef', outbox: '[kind+id],at', meta: 'key' }).upgrade(async (tx) => {
      // Catalog keys never expire, only their snapshots do.
      const links: CatalogRow[] = await tx.table('catalog').toArray()
      for (const { key, mediaId } of links) await tx.table('media').update(mediaId, { catalogRef: key })
    })
  }
}

function groupRows<T extends { mediaId: string }>(rows: T[]) {
  const byParent = new Map<string, T[]>()
  for (const item of rows) {
    const group = byParent.get(item.mediaId)
    if (group) group.push(item)
    else byParent.set(item.mediaId, [item])
  }
  return byParent
}

function displayMedia(owned: OwnedMedia, snapshot?: Media): Media {
  const display = snapshot ?? demoById.get(owned.id)
  if (owned.format === 'BOOK' && owned.bookType) {
    return { ...display, id: owned.id, format: 'BOOK', anime: undefined, bookType: owned.bookType,
      title: owned.label ?? display?.title ?? 'Saved book', description: display?.description ?? '',
      genres: display?.genres ?? [], identity: parseCatalogKey(owned.id) }
  }
  if (display && display.format === owned.format && Boolean(display.anime) === owned.anime) {
    return { ...display, id: owned.id }
  }
  const base = {
    id: owned.id,
    title: owned.label ?? 'Saved title',
    description: '',
    genres: [],
    identity: owned.catalogRef ? parseCatalogKey(owned.catalogRef) : undefined,
  }
  if (owned.format === 'BOOK') throw new Error('This book is missing its type.')
  return owned.format === 'GAME' ? { ...base, format: owned.format } : { ...base, format: owned.format, anime: owned.anime }
}

function libraryEntry(entry: BackupEntry, snapshot?: Media): LibraryEntry {
  const media = displayMedia(entry.media, snapshot)
  const episodes = new Map<string, Episode | undefined>()
  if (media.format === 'SERIES') {
    for (const episode of media.episodes ?? []) {
      const key = episodeKey(episode)
      episodes.set(key, episodes.has(key) ? undefined : episode)
    }
  }
  return {
    media,
    status: entry.status,
    liked: entry.liked,
    rating: entry.rating,
    watchlisted: entry.watchlisted,
    label: entry.media.label,
    reading: entry.reading,
    playtimeMinutes: entry.playtimeMinutes,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    watched: entry.episodes.filter(({ watched }) => watched).map(({ season, number }) => {
      const position = { season, number }
      return episodes.get(episodeKey(position)) ?? manualEpisode(position)
    }),
    unwatched: entry.episodes.filter(({ watched }) => !watched).map(({ season, number }) => ({ season, number })),
    completions: entry.completions,
  }
}

/** Window event the app's library fires after a write that queued a change for sync. */
export const libraryChanged = 'epilog:library-changed'

export function createLibrary(name = 'epilog', clock = Date.now, changed: () => void = () => {}) {
  const db = new LibraryDatabase(name)
  const records = [db.media, db.entries, db.completions, db.episodes]
  const tables = [...records, db.catalog, db.outbox, db.meta]

  async function getMeta<K extends keyof Meta>(key: K) {
    return (await db.meta.get(key))?.value as Meta[K] | undefined
  }

  /** Queues records for sync, only while signed in. Call inside the write's transaction. */
  async function enqueue(keys: OutboxKey[], at: number) {
    if (!keys.length || !await db.meta.get('account')) return 0
    await db.outbox.bulkPut(keys.map((key) => ({ ...key, at })))
    changed()
    return keys.length
  }

  async function readEntries(): Promise<BackupEntry[]> {
    const [media, entries, completionRows, episodeRows] = await Promise.all([
      db.media.toArray(),
      db.entries.toArray(),
      db.completions.toArray(),
      db.episodes.toArray(),
    ])
    const byMedia = new Map(media.map((item) => [item.id, item]))
    const byCompletion = groupRows(completionRows)
    const byEpisode = groupRows(episodeRows)
    return entries.map((entry) => {
      const owned = byMedia.get(entry.mediaId)
      if (!owned) throw new Error('A library entry is missing its media record.')
      const { mediaId } = entry
      return {
        ...trackingFields(entry),
        media: owned,
        completions: (byCompletion.get(mediaId) ?? []).map(({ id, date }) => ({ id, date })),
        episodes: (byEpisode.get(mediaId) ?? []).map(({ season, number, watched, updatedAt }) => ({ season, number, watched, updatedAt })),
      }
    })
  }

  async function read() {
    return db.transaction('r', [...records, db.catalog], async () => {
      const entries = await readEntries()
      const valid = await db.catalog.where('expiresAt').above(clock()).toArray()
      const byMedia = new Map(valid.map(({ mediaId, media }) => [mediaId, media]))
      return new Map(entries.map((entry) => [entry.media.id, libraryEntry(entry, byMedia.get(entry.media.id))]))
    })
  }

  function watch() {
    return liveQuery(read)
  }

  async function storedEntry(mediaId: string, media: OwnedMedia): Promise<BackupEntry | undefined> {
    const row = await db.entries.get(mediaId)
    if (!row) return
    const [completionRows, episodeRows] = await Promise.all([
      db.completions.where({ mediaId }).toArray(),
      db.episodes.where({ mediaId }).toArray(),
    ])
    return {
      ...trackingFields(row),
      media,
      completions: completionRows.map(({ id, date }) => ({ id, date })),
      episodes: episodeRows.map(({ season, number, watched, updatedAt }) => ({ season, number, watched, updatedAt })),
    }
  }

  async function writeEntry(media: Media, update: (current: LibraryEntry | undefined, now: number) => LibraryEntry) {
    return db.transaction('rw', tables, async () => {
      const now = clock()
      const key = media.identity ? catalogKey(media.identity) : undefined
      if (key && !parseCatalogKey(key)) throw new Error('This title has an invalid catalog reference.')
      const existingLink = key ? await db.catalog.get(key) : undefined
      const owned = await db.media.get(media.id) ?? (key ? await db.media.where({ catalogRef: key }).first() : undefined) ??
        { id: key && media.format !== 'BOOK' ? crypto.randomUUID() : media.id, format: media.format, anime: Boolean(media.anime) }
      const { id } = owned
      const before = await db.entries.get(id)
      const stored = await storedEntry(id, owned)
      const updatedAt = Math.max(now, stored?.updatedAt ?? 0)
      const current = stored ? libraryEntry(stored, media) : undefined
      const entry = update(current, updatedAt)
      if (entry === current) return { id, created: false, changed: false }
      if (entry.media.format === 'BOOK' && (!entry.media.title.trim() || entry.media.title.length > titleLengthLimit || !bookTypes.includes(entry.media.bookType))) {
        throw new Error('Enter a valid book title and choose a book type.')
      }
      const book = entry.media.format === 'BOOK' ? { bookType: entry.media.bookType, label: entry.media.title } : {}
      const saved = { id, format: owned.format, anime: owned.anime, catalogRef: key ?? owned.catalogRef, label: entry.label, ...book }
      await db.media.put(saved)
      const row = {
        mediaId: id,
        status: entry.status,
        createdAt: stored?.createdAt ?? now,
        updatedAt,
        reading: entry.reading,
        playtimeMinutes: entry.playtimeMinutes,
        liked: entry.liked,
        rating: entry.rating,
        watchlisted: entry.watchlisted,
      }
      await db.entries.put({ ...row, groupsAt: stampGroups(before, owned.label, row, saved.label, updatedAt) })

      const kept = new Set(entry.completions.map((completion) => completion.id))
      const dropped = stored?.completions.filter((completion) => !kept.has(completion.id)).map((completion) => completion.id) ?? []
      if (dropped.length) await db.completions.bulkDelete(dropped)
      const added = entry.completions.filter((completion) => !stored?.completions.some((item) => item.id === completion.id))
      for (const completion of added) await db.completions.add({ ...completion, mediaId: id })
      const cleared = stored && !entry.unwatched.length ? stored.episodes.filter(({ watched }) => !watched) : []
      if (cleared.length) await db.episodes.bulkDelete(cleared.map(({ season, number }): [string, number, number] => [id, season, number]))
      await enqueue([
        { kind: 'entry', id },
        ...[...dropped, ...added.map((completion) => completion.id)].map((completionId) => ({ kind: 'completion' as const, id: completionId })),
        ...cleared.map((episode) => ({ kind: 'episode' as const, id: episodeId(id, episode) })),
      ], updatedAt)
      if (media.identity && key && (!existingLink || existingLink.expiresAt <= now)) {
        const catalogedAt = Math.min(now, media.catalogedAt ?? now)
        const expiresAt = catalogedAt + catalogCacheAge(media.identity.provider)
        if (expiresAt > now) await db.catalog.put({ key, mediaId: id, media, expiresAt })
      }
      return { id, created: !stored, changed: true }
    })
  }

  function save(media: Media, draft: LogDraft) {
    return writeEntry(media, (current, now) => updateEntry(media, current, draft, now))
  }

  function completeToday(media: Media) {
    const completion = { id: crypto.randomUUID(), date: localDate(new Date(clock())) }
    return writeEntry(media, (current, now) => current?.status === 'Completed' ? current : updateEntry(current?.media ?? media, current, {
      status: 'Completed', completion, playtimeMinutes: current?.playtimeMinutes,
    }, now))
  }

  /** "Remove watch": drops the latest completion, and the whole entry if nothing else was tracked. */
  function uncomplete(media: Media) {
    return db.transaction('rw', tables, async () => {
      let emptied = false
      let completed = false
      const result = await writeEntry(media, (current, now) => {
        if (!current) throw new Error('This title is no longer in the library.')
        const entry = removeCompletion(current, now)
        emptied = entry !== current && isEmptyEntry(entry)
        completed = entry.status === 'Completed'
        return entry
      })
      if (emptied) await remove(result.id)
      return { ...result, removed: emptied, completed }
    })
  }

  function savePreference(media: Media, change: PreferenceChange) {
    return writeEntry(media, (current, now) => updatePreference(media, current, change, now))
  }

  /** One episode or a whole season, saved in a single transaction. */
  async function setEpisode(mediaId: string, episode: Episode | readonly Episode[], watched: boolean) {
    const episodes = [episode].flat()
    return db.transaction('rw', tables, async () => {
      const media = await db.media.get(mediaId)
      const before = await db.entries.get(mediaId)
      const current = media ? await storedEntry(mediaId, media) : undefined
      if (!media || !before || !current) throw new Error('This title is no longer in the library.')
      const now = Math.max(clock(), current.updatedAt)
      const updated = episodes.reduce((entry, item) => updateEpisode(entry, item, watched, now), libraryEntry(current))
      await db.episodes.bulkPut(episodes.map(({ season, number }) => ({ mediaId, season, number, watched, updatedAt: now })))
      const row = { ...before, updatedAt: now, status: updated.status }
      await db.entries.put({ ...row, groupsAt: stampGroups(before, media.label, row, media.label, now) })
      await enqueue([{ kind: 'entry', id: mediaId }, ...episodes.map((item) => ({ kind: 'episode' as const, id: episodeId(mediaId, item) }))], now)
    })
  }

  async function remove(mediaId: string) {
    return db.transaction('rw', tables, async () => {
      const row = await db.entries.get(mediaId)
      const completionIds = await db.completions.where({ mediaId }).primaryKeys()
      const episodeKeys = await db.episodes.where({ mediaId }).primaryKeys()
      await enqueue([
        { kind: 'entry', id: mediaId },
        ...completionIds.map((id) => ({ kind: 'completion' as const, id })),
        ...episodeKeys.map(([, season, number]) => ({ kind: 'episode' as const, id: episodeId(mediaId, { season, number }) })),
      ], Math.max(clock(), row?.updatedAt ?? 0))
      await db.completions.where({ mediaId }).delete()
      await db.episodes.where({ mediaId }).delete()
      await db.catalog.where({ mediaId }).delete()
      await db.entries.delete(mediaId)
      await db.media.delete(mediaId)
    })
  }

  async function exportBackup() {
    return db.transaction('r', records, async () => buildBackup(await readEntries()))
  }

  async function previewRestore(backup: Backup): Promise<RestorePreview> {
    return db.transaction('r', records, async () => {
      const current = await readEntries()
      const { newCount, duplicateCount, conflicts } = planRestore(backup, current)
      return { backup, revision: JSON.stringify(current), newCount, duplicateCount, conflicts }
    })
  }

  async function applyRestore(preview: RestorePreview, preferBackup: boolean) {
    return db.transaction('rw', tables, async () => {
      const current = await readEntries()
      if (JSON.stringify(current) !== preview.revision) {
        throw new Error('Your library changed after the preview. Review the backup again before restoring.')
      }
      const restore = planRestore(preview.backup, current, preferBackup)
      const now = clock()
      for (const item of restore.writes) {
        const mediaId = item.media.id
        const [beforeMedia, before] = await Promise.all([db.media.get(mediaId), db.entries.get(mediaId)])
        await db.media.put(item.media)
        const row = {
          mediaId,
          status: item.status,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          reading: item.reading,
          playtimeMinutes: item.playtimeMinutes,
          liked: item.liked,
          rating: item.rating,
          watchlisted: item.watchlisted,
        }
        await db.entries.put({ ...row, groupsAt: stampGroups(before, beforeMedia?.label, row, item.media.label, now) })
        await db.completions.bulkPut(item.completions.map((completion) => ({ ...completion, mediaId })))
        await db.episodes.bulkPut(item.episodes.map((episode) => ({ ...episode, mediaId })))
        await enqueue([
          { kind: 'entry', id: mediaId },
          ...item.completions.map(({ id }) => ({ kind: 'completion' as const, id })),
          ...item.episodes.map((episode) => ({ kind: 'episode' as const, id: episodeId(mediaId, episode) })),
        ], now)
      }
      return restore.writes.length
    })
  }

  async function refreshSnapshot(media: Media) {
    if (!media.identity || !media.catalogedAt) return
    const key = catalogKey(media.identity)
    const catalogedAt = Math.min(clock(), media.catalogedAt)
    const expiresAt = catalogedAt + catalogCacheAge(media.identity.provider)
    await db.transaction('rw', db.catalog, async () => {
      const saved = await db.catalog.get(key)
      if (saved && saved.expiresAt > clock() && expiresAt > clock() &&
        (saved.media.catalogedAt ?? 0) < catalogedAt) {
        await db.catalog.put({ ...saved, media, expiresAt })
      }
    })
  }

  async function readResponse(key: string) {
    const row = await db.responses.get(key)
    return row && row.expiresAt > clock() ? row : undefined
  }

  async function cacheResponse(key: string, provider: Provider, payload: CatalogPayload) {
    const now = clock()
    const ages = 'items' in payload ? payload.items.flatMap((item) => item.catalogedAt ?? []) : []
    const expiresAt = Math.min(now, ...ages) + Math.min(catalogCacheAge(provider), 24 * 60 * 60_000)
    if (expiresAt <= now) return
    await db.transaction('rw', db.responses, async () => {
      await db.responses.put({ key, payload, writtenAt: now, expiresAt })
      const excess = await db.responses.count() - responseCacheLimit
      if (excess > 0) await db.responses.bulkDelete(await db.responses.orderBy('writtenAt').limit(excess).primaryKeys())
    })
  }

  async function purgeExpired() {
    const now = clock()
    await db.transaction('rw', db.catalog, db.responses, async () => {
      await db.catalog.where('expiresAt').belowOrEqual(now).delete()
      await db.responses.where('expiresAt').belowOrEqual(now).delete()
    })
  }

  function account() {
    return getMeta('account')
  }

  /** `undefined` signs out: the outbox is dropped, the library is kept and remembered as `lastSub`'s. */
  async function setAccount(value: { sub: string; email: string; name: string } | undefined) {
    await db.transaction('rw', db.meta, db.outbox, async () => {
      const current = await getMeta('account')
      if (value) {
        await db.meta.put({ key: 'account', value: current?.sub === value.sub ? { ...current, ...value } : { ...value, cursor: 0 } })
        return
      }
      await db.outbox.clear()
      await db.meta.delete('account')
      if (current) await db.meta.put({ key: 'lastSub', value: current.sub })
    })
  }

  function lastSub() {
    return getMeta('lastSub')
  }

  async function setCursor(cursor: number, at: number) {
    await db.transaction('rw', db.meta, async () => {
      const current = await getMeta('account')
      if (current) await db.meta.put({ key: 'account', value: { ...current, cursor, lastSyncAt: at } })
    })
  }

  /** The record's change rebuilt from local state; a queued record with no state is a tombstone. */
  async function currentChange({ kind, id }: OutboxKey): Promise<SyncChange | undefined> {
    const queued = await db.outbox.get([kind, id])
    if (kind === 'entry') {
      const [row, media] = await Promise.all([db.entries.get(id), db.media.get(id)])
      if (row && media) {
        const data = entryData(row, media)
        return { kind, id, data, at: latestAt(data) }
      }
    } else if (kind === 'completion') {
      const row = await db.completions.get(id)
      if (row) return { kind, id, data: { mediaId: row.mediaId, date: row.date }, at: queued?.at ?? 0 }
    } else {
      const row = await db.episodes.get(episodeRowKey(id))
      if (row) return { kind, id, data: { mediaId: row.mediaId, season: row.season, number: row.number, watched: row.watched }, at: row.updatedAt }
    }
    return queued && { kind, id, data: null, at: queued.at } as SyncChange
  }

  async function pendingChanges(limit: number) {
    return db.transaction('r', tables, async () => {
      const queued = await db.outbox.orderBy('at').limit(limit).toArray()
      return Promise.all(queued.map(async (key) => (await currentChange(key))!))
    })
  }

  /** Drops each sent change from the outbox unless the record changed after it was read. */
  async function acknowledge(changes: readonly SyncChange[]) {
    await db.transaction('rw', tables, async () => {
      for (const change of changes) {
        if (JSON.stringify(await currentChange(change)) === JSON.stringify(change)) await db.outbox.delete([change.kind, change.id])
      }
    })
  }

  /** Writes a merged change to the local tables without queuing it. */
  async function writeChange(change: SyncChange) {
    if (change.kind === 'completion') {
      if (change.data) await db.completions.put({ id: change.id, ...change.data })
      else await db.completions.delete(change.id)
    } else if (change.kind === 'episode') {
      if (change.data) await db.episodes.put({ ...change.data, updatedAt: change.at })
      else await db.episodes.delete(episodeRowKey(change.id))
    } else if (!change.data) {
      await db.catalog.where({ mediaId: change.id }).delete()
      await db.entries.delete(change.id)
      await db.media.delete(change.id)
    } else {
      const { id, data } = change
      const { progress, liked, rating, watchlisted, label } = data.groups
      const before = await db.entries.get(id)
      await db.media.put({ id, format: data.format, anime: data.anime, bookType: data.bookType, catalogRef: data.catalogRef, label: label.value })
      await db.entries.put({
        mediaId: id,
        status: progress.status,
        createdAt: data.createdAt,
        updatedAt: Math.max(before?.updatedAt ?? 0, latestAt(data)),
        reading: progress.reading,
        playtimeMinutes: progress.playtimeMinutes,
        liked: liked.value,
        rating: rating.value as Rating | undefined,
        watchlisted: watchlisted.value,
        groupsAt: Object.fromEntries(groupNames.map((name) => [name, data.groups[name].at])),
      })
    }
  }

  /** Moves every local row of `from` to `to`, merging into `to` if it already exists. */
  async function rewriteId(from: string, to: string) {
    if (from === to) return
    const local = await currentChange({ kind: 'entry', id: from })
    const target = await currentChange({ kind: 'entry', id: to })
    const completionIds = await db.completions.where({ mediaId: from }).primaryKeys()
    await db.completions.where({ mediaId: from }).modify({ mediaId: to })
    const episodes = await db.episodes.where({ mediaId: from }).toArray()
    await db.episodes.where({ mediaId: from }).delete()
    for (const episode of episodes) {
      const kept = await db.episodes.get([to, episode.season, episode.number])
      if (!kept || kept.updatedAt < episode.updatedAt) await db.episodes.put({ ...episode, mediaId: to })
    }
    const link = await db.catalog.where({ mediaId: from }).first()
    if (link) {
      await db.catalog.delete(link.key)
      if (!await db.catalog.where({ mediaId: to }).count()) await db.catalog.put({ ...link, mediaId: to })
    }
    const queued = await db.outbox.get(['entry', from])
    if (queued) {
      await db.outbox.delete(['entry', from])
      const kept = await db.outbox.get(['entry', to])
      await db.outbox.put({ ...queued, id: to, at: Math.max(queued.at, kept?.at ?? 0) })
    }
    // Moved children may already be acknowledged under the old id: queue them again, with tombstones for the old episode ids.
    await enqueue([
      ...completionIds.map((id) => ({ kind: 'completion' as const, id })),
      ...episodes.flatMap((episode) => [to, from].map((mediaId) => ({ kind: 'episode' as const, id: episodeId(mediaId, episode) }))),
    ], clock())
    await db.entries.delete(from)
    await db.media.delete(from)
    if (local) await writeChange(mergeChange(target, { ...local, id: to }))
  }

  /** Applies a sync response: remaps first, then merges each change, without queuing anything. */
  async function applyRemote(changes: readonly SyncChange[], remap: Readonly<Record<string, string>>) {
    await db.transaction('rw', tables, async () => {
      for (const [from, to] of Object.entries(remap)) await rewriteId(from, to)
      for (const change of changes) {
        const catalogRef = change.kind === 'entry' ? change.data?.catalogRef : undefined
        const twin = catalogRef ? await db.media.where({ catalogRef }).first() : undefined
        if (twin) await rewriteId(twin.id, change.id)
        const current = await currentChange(change)
        const merged = mergeChange(current, change)
        if (merged !== current) await writeChange(merged)
      }
    })
  }

  async function localKeys(): Promise<OutboxKey[]> {
    const [entryIds, completionIds, episodeKeys] = await Promise.all([
      db.entries.toCollection().primaryKeys(), db.completions.toCollection().primaryKeys(), db.episodes.toCollection().primaryKeys(),
    ])
    return [
      ...entryIds.map((id) => ({ kind: 'entry' as const, id })),
      ...completionIds.map((id) => ({ kind: 'completion' as const, id })),
      ...episodeKeys.map(([mediaId, season, number]) => ({ kind: 'episode' as const, id: episodeId(mediaId, { season, number }) })),
    ]
  }

  /** Replaces synced state with the server's full set. Records still queued stay, and are pushed next. */
  async function resetRemote(changes: readonly SyncChange[], remap: Readonly<Record<string, string>>) {
    await db.transaction('rw', tables, async () => {
      const keep = new Set([...changes, ...await db.outbox.toArray()].map(({ kind, id }) => `${kind} ${id}`))
      for (const key of await localKeys()) {
        if (!keep.has(`${key.kind} ${key.id}`)) await writeChange({ ...key, data: null, at: 0 })
      }
      await applyRemote(changes, remap)
    })
  }

  /** Commits a sync response in one transaction, only while `sub` is still the signed-in account; false means nothing was written. */
  async function commitSync(sub: string, sent: readonly SyncChange[],
    response: { cursor: number; changes: SyncChange[]; remap: Record<string, string>; reset?: true }) {
    return db.transaction('rw', tables, async () => {
      if ((await getMeta('account'))?.sub !== sub) return false
      await (response.reset ? resetRemote : applyRemote)(response.changes, response.remap)
      // After applying: a change the response rewrote stays queued and goes up again next page.
      await acknowledge(sent)
      await setCursor(response.cursor, clock())
      return true
    })
  }

  /** Queues every local record, for the first merge into an account. */
  async function enqueueAll() {
    return db.transaction('rw', tables, async () => enqueue(await localKeys(), clock()))
  }

  async function saveMergeSnapshot() {
    await db.transaction('rw', [...records, db.meta], async () => {
      await db.meta.put({ key: 'mergeSnapshot', value: { backup: buildBackup(await readEntries()), expiresAt: clock() + mergeSnapshotAge } })
    })
  }

  async function mergeSnapshot() {
    const snapshot = await getMeta('mergeSnapshot')
    return snapshot && snapshot.expiresAt > clock() ? snapshot.backup : undefined
  }

  /** Clears the library, outbox and account; cached catalog responses stay. */
  async function clearAll() {
    await db.transaction('rw', tables, () => Promise.all(tables.map((table) => table.clear())))
  }

  async function storeSnapshot(mediaId: string, media: Media) {
    await db.transaction('rw', db.media, db.catalog, async () => {
      const key = (await db.media.get(mediaId))?.catalogRef
      const identity = key ? parseCatalogKey(key) : undefined
      if (!key || !identity) return
      const now = clock()
      const expiresAt = Math.min(now, media.catalogedAt ?? now) + catalogCacheAge(identity.provider)
      if (expiresAt > now) await db.catalog.put({ key, mediaId, media, expiresAt })
    })
  }

  /** Titles with a permanent catalog ID but no current snapshot to display. */
  async function missingSnapshots() {
    return db.transaction('r', db.media, db.catalog, async () => {
      const current = new Set((await db.catalog.where('expiresAt').above(clock()).toArray()).map(({ mediaId }) => mediaId))
      return (await db.media.toArray()).flatMap(({ id, catalogRef }) => catalogRef && !current.has(id) ? [{ mediaId: id, catalogRef }] : [])
    })
  }

  return {
    read, watch, save, completeToday, uncomplete, savePreference, setEpisode, remove, exportBackup, previewRestore, applyRestore,
    purgeExpired, refreshSnapshot, readResponse, cacheResponse,
    account, setAccount, lastSub, setCursor, pendingChanges, acknowledge, applyRemote, resetRemote, commitSync, enqueueAll,
    saveMergeSnapshot, mergeSnapshot, clearAll, storeSnapshot, missingSnapshots,
    close: () => db.close(),
    deleteDatabase: () => db.delete(),
  }
}

export type LibraryStore = ReturnType<typeof createLibrary>
export const library = createLibrary('epilog', Date.now, () => window.dispatchEvent(new Event(libraryChanged)))
