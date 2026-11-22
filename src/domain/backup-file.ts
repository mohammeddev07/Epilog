import { bookTypes, readingUnits, savedBookTitle } from './books'
import { z } from 'zod'
import { backupFormat, backupSizeLimit, backupVersion } from './backup'
import type { Backup } from './backup'
import { episodeKey, isCalendarDate, ratings, statuses, titleLengthLimit } from './media'

const safeIdentifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/)
const timestamp = z.int().nonnegative().max(8_640_000_000_000_000)

const completionSchema = z.strictObject({
  id: safeIdentifier,
  date: z.string().refine(isCalendarDate),
})

const episodeSchema = z.strictObject({
  season: z.int().nonnegative(),
  number: z.int().positive(),
  watched: z.boolean(),
  updatedAt: timestamp,
})

const mediaSchema = z.strictObject({
  id: safeIdentifier,
  format: z.enum(['MOVIE', 'SERIES', 'GAME']),
  anime: z.boolean(),
  label: z.string().trim().min(1).max(titleLengthLimit).optional(),
})

const entrySchema = z.strictObject({
  media: mediaSchema,
  status: z.enum(statuses),
  createdAt: timestamp,
  updatedAt: timestamp,
  playtimeMinutes: z.int().nonnegative().optional(),
  completions: z.array(completionSchema),
  episodes: z.array(episodeSchema),
})

const legacyBackupSchema = z.strictObject({
  format: z.literal(backupFormat),
  version: z.literal(1),
  entries: z.array(entrySchema),
})

const preferenceEntry = entrySchema.extend({
  status: z.enum(statuses).optional(),
  liked: z.boolean().optional(),
  rating: z.literal(ratings).optional(),
  watchlisted: z.boolean().optional(),
})
const bookRef = z.string().regex(/^openlibrary:work:OL[1-9]\d{0,11}W$/)
const bookMedia = mediaSchema.extend({
  id: z.union([safeIdentifier, bookRef]),
  format: z.literal('BOOK'), anime: z.literal(false),
  catalogRef: bookRef.optional(),
  bookType: z.enum(bookTypes),
}).refine(({ id, label, catalogRef }) => label !== undefined || catalogRef !== undefined || bookRef.safeParse(id).success)
const readingSchema = z.strictObject({
  unit: z.enum(readingUnits), count: z.int().nonnegative(), total: z.int().positive().optional(),
}).refine(({ count, total }) => total === undefined || count <= total)
const backupSchema = z.discriminatedUnion('version', [legacyBackupSchema,
  z.strictObject({ format: z.literal(backupFormat), version: z.literal(2), entries: z.array(preferenceEntry) }),
  z.strictObject({ format: z.literal(backupFormat), version: z.literal(backupVersion), entries: z.array(
    z.union([preferenceEntry, preferenceEntry.extend({ media: bookMedia, reading: readingSchema.optional() })])
  ) }),
])

export function parseBackup(text: string): Backup {
  if (new TextEncoder().encode(text).length > backupSizeLimit) throw new Error('The backup exceeds 10 MB.')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('This file is not valid JSON. Choose an Epilog backup.')
  }
  const parsed = backupSchema.safeParse(json)
  if (!parsed.success) throw new Error('This file is not a supported Epilog backup.')
  const mediaIds = new Set<string>()
  const completionIds = new Set<string>()
  for (const entry of parsed.data.entries) {
    const { media, completions, episodes } = entry
    const episodeIds = new Set(episodes.map(episodeKey))
    if (mediaIds.has(media.id) || episodeIds.size !== episodes.length ||
      entry.createdAt > entry.updatedAt || episodes.some((episode) => episode.updatedAt > entry.updatedAt) ||
      (media.format !== 'SERIES' && episodes.length) ||
      (media.format !== 'GAME' && entry.playtimeMinutes !== undefined) ||
      (media.format === 'GAME' && media.anime)) {
      throw new Error('This backup contains inconsistent tracking records.')
    }
    // Old exports could persist the temporary display title before catalog details had loaded.
    if (media.format === 'BOOK' && media.label === savedBookTitle && (media.catalogRef || bookRef.safeParse(media.id).success)) {
      delete media.label
    }
    mediaIds.add(media.id)
    for (const { id } of completions) {
      if (completionIds.has(id)) throw new Error('This backup contains duplicate completion IDs.')
      completionIds.add(id)
    }
  }
  return parsed.data
}
