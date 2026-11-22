import type { LibraryEntry } from '../domain/media'

export const sorts = {
  recent: { label: 'Recent activity', compare: (a: LibraryEntry, b: LibraryEntry) => b.updatedAt - a.updatedAt },
  added: { label: 'Date added', compare: (a: LibraryEntry, b: LibraryEntry) => (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt) },
  year: { label: 'Release year', compare: (a: LibraryEntry, b: LibraryEntry) => (b.media.year ?? -Infinity) - (a.media.year ?? -Infinity) || a.media.title.localeCompare(b.media.title) },
  title: { label: 'Title A–Z', compare: (a: LibraryEntry, b: LibraryEntry) => a.media.title.localeCompare(b.media.title) },
} as const
export type SortKey = keyof typeof sorts

export const sortPreferenceKey = 'epilog:library-sort:v1'
export function readDefaultSort(): SortKey {
  try {
    const value = localStorage.getItem(sortPreferenceKey)
    if (value && Object.hasOwn(sorts, value)) return value as SortKey
  } catch { /* The library still works with the recent-activity default. */ }
  return 'recent'
}
