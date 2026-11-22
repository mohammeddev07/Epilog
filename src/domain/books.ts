export const bookTypes = ['Novel', 'Nonfiction', 'Light Novel', 'Manga', 'Manhwa', 'Manhua'] as const
export type BookType = (typeof bookTypes)[number]
export const bookTypeLabels: Record<BookType, string> = {
  Novel: 'Novels', Nonfiction: 'Nonfiction', 'Light Novel': 'Light Novels', Manga: 'Manga',
  Manhwa: 'Manhwa (Korean comics)', Manhua: 'Manhua (Chinese comics)',
}
export const readingUnits = ['page', 'chapter', 'volume'] as const
export type ReadingUnit = (typeof readingUnits)[number]

export interface ReadingProgress {
  unit: ReadingUnit
  count: number
  total?: number
}

export function defaultUnit(type: BookType): ReadingUnit {
  return type === 'Novel' || type === 'Nonfiction' || type === 'Light Novel' ? 'page' : 'chapter'
}

export function readingText({ count, unit, total }: ReadingProgress) {
  const amount = total === undefined ? String(count) : `${count} of ${total}`
  return `${amount} ${unit}${(total ?? count) === 1 ? '' : 's'} read`
}

export function validateReading({ count, total, unit }: ReadingProgress) {
  if (!readingUnits.includes(unit) || !Number.isSafeInteger(count) || count < 0) {
    throw new Error('Enter a whole number of pages, chapters, or volumes read, starting at zero.')
  }
  if (total !== undefined && (!Number.isSafeInteger(total) || total < 1 || count > total)) {
    throw new Error('The total must be a positive whole number at least as large as your progress.')
  }
}
