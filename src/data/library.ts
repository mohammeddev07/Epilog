import { Dexie, liveQuery } from 'dexie'
import type { Table } from 'dexie'
import { buildBackup, planRestore } from '../domain/backup'
import type { Backup, BackupEntry, EpisodeActivity, OwnedMedia, RestorePreview } from '../domain/backup'
import type { CatalogPayload, Provider } from '../domain/catalog'
import { catalogCacheAge, catalogKey, parseCatalogKey } from '../domain/identity'
import { episodeKey, manualEpisode, updateEntry, updateEpisode, updatePreference } from '../domain/media'
import type { Completion, Episode, LibraryEntry, LogDraft, Media, PreferenceChange, TitlePreferences } from '../domain/media'
import { demoById } from './demo'

type EntryRow = Pick<BackupEntry, 'status' | 'createdAt' | 'updatedAt' | 'playtimeMinutes'> & TitlePreferences & { mediaId: string }
type CompletionRow = Completion & { mediaId: string }
type EpisodeRow = EpisodeActivity & { mediaId: string }
type ResponseRow = { key: string; payload: CatalogPayload; writtenAt: number; expiresAt: number }

const responseCacheLimit = 64

function trackingFields(row: EntryRow) {
  const { status, createdAt, updatedAt, playtimeMinutes, liked, rating, watchlisted } = row
  return { status, createdAt, updatedAt, playtimeMinutes, liked, rating, watchlisted }
}

type CatalogRow = { key: string; mediaId: string; media: Media; expiresAt: number }

class LibraryDatabase extends Dexie {
  declare media: Table<OwnedMedia, string>
  declare entries: Table<EntryRow, string>
  declare completions: Table<CompletionRow, string>
  declare episodes: Table<EpisodeRow, [string, number, number]>
  declare catalog: Table<CatalogRow, string>
  declare responses: Table<ResponseRow, string>

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
  if (display && display.format === owned.format && Boolean(display.anime) === owned.anime) {
    return { ...display, id: owned.id }
  }
  const base = {
    id: owned.id,
    title: owned.label ?? 'Saved title',
    description: '',
    genres: [],
  }
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
    playtimeMinutes: entry.playtimeMinutes,
    updatedAt: entry.updatedAt,
    watched: entry.episodes.filter(({ watched }) => watched).map(({ season, number }) => {
      const position = { season, number }
      return episodes.get(episodeKey(position)) ?? manualEpisode(position)
    }),
    unwatched: entry.episodes.filter(({ watched }) => !watched).map(({ season, number }) => ({ season, number })),
    completions: entry.completions,
  }
}

export function createLibrary(name = 'epilog', clock = Date.now) {
  const db = new LibraryDatabase(name)
  const records = [db.media, db.entries, db.completions, db.episodes]

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
    return db.transaction('rw', [...records, db.catalog], async () => {
      const now = clock()
      const key = media.identity ? catalogKey(media.identity) : undefined
      if (key && !parseCatalogKey(key)) throw new Error('This title has an invalid catalog reference.')
      const existingLink = key ? await db.catalog.get(key) : undefined
      const existing = await db.media.get(media.id)
      const id = existing?.id ?? (existingLink && existingLink.expiresAt > now ? existingLink.mediaId : undefined) ??
        (key ? crypto.randomUUID() : media.id)
      const owned = existing ?? await db.media.get(id) ?? { id, format: media.format, anime: Boolean(media.anime) }
      const stored = await storedEntry(id, owned)
      const updatedAt = Math.max(now, stored?.updatedAt ?? 0)
      const entry = update(stored ? libraryEntry(stored, media) : undefined, updatedAt)
      await db.media.put({ id, format: owned.format, anime: owned.anime, label: entry.label })
      await db.entries.put({
        mediaId: id,
        status: entry.status,
        createdAt: stored?.createdAt ?? now,
        updatedAt,
        playtimeMinutes: entry.playtimeMinutes,
        liked: entry.liked,
        rating: entry.rating,
        watchlisted: entry.watchlisted,
      })

      for (const completion of entry.completions) {
        if (!stored?.completions.some((item) => item.id === completion.id)) {
          await db.completions.add({ ...completion, mediaId: id })
        }
      }
      if (stored && !entry.unwatched.length) {
        const cleared: [string, number, number][] = stored.episodes.filter(({ watched }) => !watched)
          .map(({ season, number }) => [id, season, number])
        if (cleared.length) await db.episodes.bulkDelete(cleared)
      }
      if (media.identity && key && (!existingLink || existingLink.expiresAt <= now)) {
        const catalogedAt = Math.min(now, media.catalogedAt ?? now)
        const expiresAt = catalogedAt + catalogCacheAge(media.identity.provider)
        if (expiresAt > now) await db.catalog.put({ key, mediaId: id, media, expiresAt })
      }
      return { id, created: !stored }
    })
  }

  function save(media: Media, draft: LogDraft) {
    return writeEntry(media, (current, now) => updateEntry(media, current, draft, now))
  }

  function savePreference(media: Media, change: PreferenceChange) {
    return writeEntry(media, (current, now) => updatePreference(media, current, change, now))
  }

  async function setEpisode(mediaId: string, episode: Episode, watched: boolean) {
    return db.transaction('rw', [...records, db.catalog], async () => {
      const media = await db.media.get(mediaId)
      const current = media ? await storedEntry(mediaId, media) : undefined
      if (!current) throw new Error('This title is no longer in the library.')
      const now = Math.max(clock(), current.updatedAt)
      const updated = updateEpisode(libraryEntry(current), episode, watched, now)
      await db.episodes.put({ mediaId, season: episode.season, number: episode.number, watched, updatedAt: now })
      await db.entries.update(mediaId, { updatedAt: now, status: updated.status })
    })
  }

  async function remove(mediaId: string) {
    return db.transaction('rw', [...records, db.catalog], async () => {
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
    return db.transaction('rw', records, async () => {
      const current = await readEntries()
      if (JSON.stringify(current) !== preview.revision) {
        throw new Error('Your library changed after the preview. Review the backup again before restoring.')
      }
      const restore = planRestore(preview.backup, current, preferBackup)
      for (const item of restore.writes) {
        const mediaId = item.media.id
        await db.media.put(item.media)
        await db.entries.put({
          mediaId,
          status: item.status,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          playtimeMinutes: item.playtimeMinutes,
          liked: item.liked,
          rating: item.rating,
          watchlisted: item.watchlisted,
        })
        await db.completions.bulkPut(item.completions.map((completion) => ({ ...completion, mediaId })))
        await db.episodes.bulkPut(item.episodes.map((episode) => ({ ...episode, mediaId })))
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

  return {
    read, watch, save, savePreference, setEpisode, remove, exportBackup, previewRestore, applyRestore,
    purgeExpired, refreshSnapshot, readResponse, cacheResponse,
    close: () => db.close(),
    deleteDatabase: () => db.delete(),
  }
}

export type LibraryStore = ReturnType<typeof createLibrary>
export const library = createLibrary()
