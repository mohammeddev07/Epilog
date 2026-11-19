import { episodeKey, localDate } from './media'
import type { Completion, EpisodePosition, Media, Status, TitlePreferences } from './media'

export const backupFormat = 'epilog-library'
export const backupVersion = 2
export const backupSizeLimit = 10 * 1024 * 1024

export interface OwnedMedia {
  id: string
  format: Media['format']
  anime: boolean
  label?: string
}

export interface EpisodeActivity extends EpisodePosition {
  watched: boolean
  updatedAt: number
}

export interface BackupEntry extends TitlePreferences {
  media: OwnedMedia
  status?: Status
  createdAt: number
  updatedAt: number
  playtimeMinutes?: number
  completions: Completion[]
  episodes: EpisodeActivity[]
}

export interface Backup {
  format: typeof backupFormat
  version: 1 | typeof backupVersion
  entries: BackupEntry[]
}

export interface BackupConflict {
  media: OwnedMedia
  field: string
  current: string
  incoming: string
}

export interface RestorePreview {
  backup: Backup
  revision: string
  newCount: number
  duplicateCount: number
  conflicts: BackupConflict[]
}

export function buildBackup(entries: BackupEntry[]): Backup {
  return { format: backupFormat, version: backupVersion, entries }
}

export function backupFileName() {
  return `epilog-library-${localDate()}.json`
}

export function planRestore(backup: Backup, current: BackupEntry[], preferBackup = false) {
  const byId = new Map(current.map((entry) => [entry.media.id, entry]))
  const owners = new Map(current.flatMap((entry) => entry.completions.map(({ id }) => [id, entry.media.id])))
  const conflicts: BackupConflict[] = []
  let newCount = 0
  let duplicateCount = 0
  const writes = backup.entries.flatMap((incoming) => {
    const saved = byId.get(incoming.media.id)
    for (const { id } of incoming.completions) {
      const owner = owners.get(id)
      if (owner && owner !== incoming.media.id) throw new Error('A completion belongs to a different title in this library.')
    }
    if (!saved) {
      newCount++
      return [incoming]
    }
    duplicateCount++
    if (saved.media.format !== incoming.media.format || saved.media.anime !== incoming.media.anime) {
      throw new Error('A backup entry has a different media format than its saved match.')
    }

    let changed = false
    const owned = saved.media
    function choose<T extends string | number | boolean | undefined>(field: string, here: T, there: T): T {
      if (here === there) return here
      conflicts.push({
        media: owned,
        field,
        current: String(here ?? 'Empty'),
        incoming: String(there ?? 'Empty'),
      })
      if (preferBackup) changed = true
      return preferBackup ? there : here
    }

    const status = choose('Status', saved.status, incoming.status)
    const label = choose('Backup label', saved.media.label, incoming.media.label)
    const playtimeMinutes = choose('Minutes played', saved.playtimeMinutes, incoming.playtimeMinutes)
    const liked = backup.version === 1 ? saved.liked : choose('Like', saved.liked, incoming.liked)
    const rating = backup.version === 1 ? saved.rating : choose('Rating', saved.rating, incoming.rating)
    const watchlisted = backup.version === 1 ? saved.watchlisted : choose('Watchlist', saved.watchlisted, incoming.watchlisted)
    const completions = new Map(saved.completions.map((item) => [item.id, item]))
    for (const item of incoming.completions) {
      const match = completions.get(item.id)
      if (!match) changed = true
      const date = match ? choose('Completion date', match.date, item.date) : item.date
      completions.set(item.id, { ...item, date })
    }
    const episodes = new Map(saved.episodes.map((item) => [episodeKey(item), item]))
    for (const item of incoming.episodes) {
      const key = episodeKey(item)
      const match = episodes.get(key)
      if (!match) {
        changed = true
        episodes.set(key, item)
        continue
      }
      const watched = choose(`Season ${item.season}, episode ${item.number} watched`, match.watched, item.watched)
      if (watched !== match.watched) episodes.set(key, item)
    }
    if (!changed) return []
    return [{
      ...saved,
      media: { ...saved.media, label },
      status,
      playtimeMinutes,
      liked,
      rating,
      watchlisted,
      updatedAt: Math.max(saved.updatedAt, incoming.updatedAt),
      completions: [...completions.values()],
      episodes: [...episodes.values()],
    }]
  })
  return { writes, newCount, duplicateCount, conflicts }
}
