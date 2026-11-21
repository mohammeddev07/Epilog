// Library sharing without accounts or a server: a profile travels in the link's #fragment
// (never sent in HTTP requests), compressed, and is validated as untrusted input when opened.
import { z } from 'zod'
import { mediaKey } from './catalog'
import { parseCatalogKey } from './identity'
import { localDate, primaryCategory, ratings, titleLengthLimit } from './media'
import type { LibraryEntry, Media } from './media'
import { week } from './stats'

// ---- Badges and streak (computed locally from the library) ----

export interface Badge { id: string; label: string; detail: string; progress: number; goal: number }

const seen = (entry: LibraryEntry) => entry.status === 'Completed' || entry.status === 'In progress' || entry.completions.length > 0

export function badges(entries: readonly LibraryEntry[]): Badge[] {
  const completed = entries.filter((entry) => entry.status === 'Completed' || entry.completions.length > 0).length
  const categories = new Set(entries.map((entry) => primaryCategory(entry.media))).size
  const rated = entries.filter((entry) => entry.rating).length
  const episodes = entries.reduce((sum, entry) => sum + entry.watched.length, 0)
  const encore = entries.some((entry) => entry.completions.length > 1) ? 1 : 0
  return [
    { id: 'first', label: 'First log', detail: 'Save your first title', progress: Math.min(entries.length, 1), goal: 1 },
    { id: 'ten', label: 'Ten down', detail: 'Finish 10 titles', progress: Math.min(completed, 10), goal: 10 },
    { id: 'all', label: 'All-rounder', detail: 'Log a movie, show, anime and game', progress: categories, goal: 4 },
    { id: 'critic', label: 'Critic', detail: 'Rate 10 titles', progress: Math.min(rated, 10), goal: 10 },
    { id: 'binge', label: 'Binger', detail: 'Watch 50 episodes', progress: Math.min(episodes, 50), goal: 50 },
    { id: 'encore', label: 'Encore', detail: 'Finish a title twice', progress: encore, goal: 1 },
  ]
}

export const earned = (list: readonly Badge[]) => list.filter((badge) => badge.progress >= badge.goal)


/** Consecutive weeks with at least one completion, ending this week or last week. */
export function streak(entries: readonly LibraryEntry[], today = localDate()) {
  const weeks = new Set(entries.flatMap((entry) => entry.completions.map((completion) => week(completion.date))))
  let current = week(today)
  if (!weeks.has(current)) current -= 1
  let count = 0
  while (weeks.has(current - count)) count++
  return count
}

// ---- Profile payload ----

const profileLimit = 60
const formats = { MOVIE: 'M', SERIES: 'S', GAME: 'G' } as const
const posterPattern = /^(https:\/\/image\.tmdb\.org\/|https:\/\/images\.igdb\.com\/|\/posters\/[a-z0-9-]+\.webp$)/

const itemSchema = z.strictObject({
  k: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:-]{0,127}$/),
  t: z.string().trim().min(1).max(titleLengthLimit),
  f: z.enum(['M', 'S', 'G']),
  a: z.literal(1).optional(),
  y: z.int().min(1870).max(2200).optional(),
  r: z.literal(ratings).optional(),
  l: z.literal(1).optional(),
  p: z.string().max(300).regex(posterPattern).optional(),
})
const profileSchema = z.strictObject({
  v: z.literal(1),
  n: z.string().trim().min(1).max(40).optional(),
  b: z.array(z.string().max(16)).max(12),
  i: z.array(itemSchema).max(profileLimit),
})
export type Profile = z.infer<typeof profileSchema>
export type ProfileItem = Profile['i'][number]

/** shareable: titles a friend's app can resolve (catalog titles; demo titles in demo mode). */
export function buildProfile(entries: readonly LibraryEntry[], name?: string, shareable = (media: Media) => Boolean(media.identity)): Profile {
  const items = entries.filter((entry) => shareable(entry.media) && (seen(entry) || entry.rating || entry.liked))
    .toSorted((a, b) => b.updatedAt - a.updatedAt).slice(0, profileLimit)
    .map(({ media, rating, liked }): ProfileItem => ({
      k: mediaKey(media), t: media.title.slice(0, titleLengthLimit), f: formats[media.format],
      ...(media.anime ? { a: 1 as const } : {}), ...(media.year ? { y: media.year } : {}),
      ...(rating ? { r: rating } : {}), ...(liked ? { l: 1 as const } : {}),
      ...(media.poster && posterPattern.test(media.poster) ? { p: media.poster } : {}),
    }))
  return { v: 1, ...(name?.trim() ? { n: name.trim().slice(0, 40) } : {}), b: earned(badges(entries)).map((badge) => badge.id), i: items }
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer())
}

export async function encodeProfile(profile: Profile) {
  const bytes = await pipe(new TextEncoder().encode(JSON.stringify(profile)), new CompressionStream('deflate-raw'))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export async function decodeProfile(text: string): Promise<Profile> {
  if (text.length > 24_000 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('This share link is not valid.')
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
    const bytes = await pipe(Uint8Array.from(binary, (char) => char.charCodeAt(0)), new DecompressionStream('deflate-raw'))
    if (bytes.length > 200_000) throw new Error('too large')
    return profileSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    throw new Error('This share link is not valid.')
  }
}

export function shareUrl(origin: string, payload: string) {
  return `${origin}/compare#p=${payload}`
}

export function itemMedia(item: ProfileItem): Media {
  const base = { id: item.k, title: item.t, year: item.y, genres: [], description: '', poster: item.p, identity: parseCatalogKey(item.k) }
  return item.f === 'G' ? { ...base, format: 'GAME' } : { ...base, format: item.f === 'S' ? 'SERIES' : 'MOVIE', anime: Boolean(item.a) }
}

// ---- Comparison ----

/**
 * Taste match: how much of the smaller list the other has seen, scaled by how closely co-rated titles agree.
 * ponytail: overlap × rating agreement heuristic; swap for a proper similarity measure if lists grow large.
 */
export function compare(mine: readonly LibraryEntry[], theirs: Profile) {
  const byKey = new Map(mine.filter((entry) => seen(entry) || entry.rating || entry.liked).map((entry) => [mediaKey(entry.media), entry]))
  const shared = theirs.i.filter((item) => byKey.has(item.k))
  const picks = theirs.i.filter((item) => !byKey.has(item.k))
    .toSorted((a, b) => (b.r ?? 0) + (b.l ? 0.5 : 0) - ((a.r ?? 0) + (a.l ? 0.5 : 0)))
  const corated = shared.flatMap((item) => {
    const rating = byKey.get(item.k)?.rating
    return item.r && rating ? [1 - Math.abs(item.r - rating) / 4] : []
  })
  const agreement = corated.length ? corated.reduce((a, b) => a + b, 0) / corated.length : 1
  const smaller = Math.min(byKey.size, theirs.i.length)
  const match = smaller ? Math.round(100 * (shared.length / smaller) * (0.5 + 0.5 * agreement)) : 0
  return { match, shared, picks }
}
