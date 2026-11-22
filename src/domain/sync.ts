import { z } from 'zod'
import { bookTypes, readingUnits } from './books'
import type { BookType, ReadingProgress } from './books'
import { parseCatalogKey } from './identity'
import { isCalendarDate, statuses, titleLengthLimit } from './media'
import type { Media, Status } from './media'

export type GroupName = 'progress' | 'liked' | 'rating' | 'watchlisted' | 'label'

export interface EntryData {
  format: Media['format']
  anime: boolean
  bookType?: BookType
  catalogRef?: string
  createdAt: number
  groups: {
    progress: { status?: Status; reading?: ReadingProgress; playtimeMinutes?: number; at: number }
    liked: { value?: boolean; at: number }
    rating: { value?: number; at: number }
    watchlisted: { value?: boolean; at: number }
    label: { value?: string; at: number }
  }
}

export interface CompletionData { mediaId: string; date: string }
export interface EpisodeData { mediaId: string; season: number; number: number; watched: boolean }

// A null data value is a tombstone. An episode id is `${mediaId}:${season}:${number}`.
export type SyncChange =
  | { kind: 'entry'; id: string; data: EntryData | null; at: number }
  | { kind: 'completion'; id: string; data: CompletionData | null; at: number }
  | { kind: 'episode'; id: string; data: EpisodeData | null; at: number }

export const syncAccountHeader = 'X-Epilog-Account'

export const maxChanges = 500
export const maxSyncBytes = 1_000_000
export const tombstoneAge = 180 * 24 * 60 * 60_000

const timestamp = z.int().nonnegative().max(8_640_000_000_000_000)
const id = z.string().min(1).max(256)
const group = <T extends z.ZodRawShape>(shape: T) => z.strictObject({ ...shape, at: timestamp })

const entryData = z.strictObject({
  format: z.enum(['MOVIE', 'SERIES', 'GAME', 'BOOK']),
  anime: z.boolean(),
  bookType: z.enum(bookTypes).optional(),
  catalogRef: z.string().refine((key) => parseCatalogKey(key) !== undefined).optional(),
  createdAt: timestamp,
  groups: z.strictObject({
    progress: group({
      status: z.enum(statuses).optional(),
      reading: z.strictObject({
        unit: z.enum(readingUnits),
        count: z.int().nonnegative(),
        total: z.int().positive().optional(),
      }).optional(),
      playtimeMinutes: z.int().nonnegative().optional(),
    }),
    liked: group({ value: z.boolean().optional() }),
    rating: group({ value: z.int().min(1).max(5).optional() }),
    watchlisted: group({ value: z.boolean().optional() }),
    label: group({ value: z.string().max(titleLengthLimit).optional() }),
  }),
})

const completionData = z.strictObject({ mediaId: id, date: z.string().refine(isCalendarDate) })
const episodeData = z.strictObject({ mediaId: id, season: z.int().nonnegative(), number: z.int().positive(), watched: z.boolean() })

export const syncChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('entry'), id, data: entryData.nullable(), at: timestamp }),
  z.strictObject({ kind: z.literal('completion'), id, data: completionData.nullable(), at: timestamp }),
  z.strictObject({
    kind: z.literal('episode'), id, data: episodeData.nullable(), at: timestamp,
  }).refine((c) => !c.data || c.id === `${c.data.mediaId}:${c.data.season}:${c.data.number}`),
])

export function clampTime(at: number, now: number) {
  return Math.min(at, now + 60_000)
}

export const groupNames = ['progress', 'liked', 'rating', 'watchlisted', 'label'] as const
const latest = (data: EntryData) => Math.max(...groupNames.map((name) => data.groups[name].at))

function mergeEntry(current: EntryData, incoming: EntryData): EntryData {
  const groups = { ...incoming.groups }
  for (const name of groupNames) if (current.groups[name].at > incoming.groups[name].at) Object.assign(groups, { [name]: current.groups[name] })
  const [top, other] = latest(current) > latest(incoming) ? [current, incoming] : [incoming, current]
  const { format, anime, bookType } = top
  // A catalog ID is permanent: a side that lacks one (a restored backup, say) never erases it.
  const catalogRef = top.catalogRef ?? other.catalogRef
  return { format, anime, bookType, catalogRef, createdAt: Math.min(current.createdAt, incoming.createdAt), groups }
}

export function mergeChange(current: SyncChange | undefined, incoming: SyncChange): SyncChange {
  if (!current) return incoming
  if (current.kind === 'entry' && incoming.kind === 'entry') {
    if (current.data && incoming.data) {
      const data = mergeEntry(current.data, incoming.data)
      return { kind: 'entry', id: incoming.id, data, at: latest(data) }
    }
    const [live, tombstone] = current.data ? [current, incoming] : [incoming, current]
    if (live.data) return latest(live.data) > tombstone.at ? { ...live, at: latest(live.data) } : tombstone
  }
  return incoming.at > current.at ? incoming : current
}
