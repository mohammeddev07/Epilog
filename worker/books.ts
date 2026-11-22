import type { BookType } from '../src/domain/books'
import { releaseYearRange, searchResultLimit } from '../src/domain/catalog'
import type { BrowseQuery, CatalogItems } from '../src/domain/catalog'
import { catalogKey } from '../src/domain/identity'
import type { Media } from '../src/domain/media'
import { titleLengthLimit } from '../src/domain/media'
import { CatalogFailure, Cooldown, plainText, providerJson, record, records, validYear } from './http'
import type { FetchProvider, JsonObject } from './http'

const subjects: Record<BookType, string> = {
  Novel: 'fiction', Nonfiction: 'nonfiction OR "self-help" OR biography OR history OR business OR psychology OR reference',
  'Light Novel': '"light novels"', Manga: 'manga', Manhwa: 'manhwa', Manhua: 'manhua',
}
const subjectClause = (type?: BookType) => `subject:(${type ? subjects[type] : Object.values(subjects).join(' OR ')})`

function classify(subjects: string[]): BookType {
  const tags = subjects.join(' ').toLowerCase()
  if (/manhwa|korean comics/.test(tags)) return 'Manhwa'
  if (/manhua|chinese comics/.test(tags)) return 'Manhua'
  if (/light novels?/.test(tags)) return 'Light Novel'
  if (/manga|japanese comics/.test(tags)) return 'Manga'
  if (/non-?fiction/.test(tags)) return 'Nonfiction'
  // Nonfiction is tagged by topic (self-help, vocabulary…), so untagged-as-fiction books land there.
  return /\b(fiction|novels?)\b/.test(tags) ? 'Novel' : 'Nonfiction'
}
function book(row: JsonObject): Media | undefined {
  const id = String(row.key).match(/^(?:\/works\/)?(OL[1-9]\d{0,11}W)$/)?.[1]
  const title = plainText(row.title, titleLengthLimit)
  if (!id || !title) return
  const tags = row.subject ?? row.subjects
  const bookType = classify(Array.isArray(tags) ? tags.filter((s): s is string => typeof s === 'string') : [])
  const identity = { provider: 'openlibrary', entity: 'work', id } as const
  const cover = row.cover_i ?? (Array.isArray(row.covers) ? row.covers.find((id) => Number.isSafeInteger(id) && id > 0) : undefined)
  const authors = Array.isArray(row.author_name) ? row.author_name.filter((s): s is string => typeof s === 'string').slice(0, 3) : []
  return { id: catalogKey(identity), title, identity, format: 'BOOK', bookType, catalogedAt: Date.now(),
    year: validYear(row.first_publish_year), genres: [], aliases: authors,
    description: plainText(record(row.description)?.value ?? row.description, 1200) || authors.join(', '),
    poster: typeof cover === 'number' && Number.isSafeInteger(cover) && cover > 0 ? `https://covers.openlibrary.org/b/id/${cover}-L.jpg?default=false` : undefined }
}

export class BookAdapter {
  private cooldown = new Cooldown()
  constructor(private fetcher: FetchProvider) {}
  private get(path: string) {
    return this.cooldown.run(() => providerJson(this.fetcher, 'https://openlibrary.org/' + path, {
      headers: { Accept: 'application/json', 'User-Agent': 'Epilog book discovery' },
    }))
  }
  async list(title: string, page: number, type?: BookType): Promise<CatalogItems> {
    const words = title.match(/[\p{L}\p{N}]+/gu) ?? []
    if (title && !words.length) return { items: [], hasMore: false }
    const titleClause = words.length ? 'title:(' + words.map((word) => '"' + word + '"').join(' AND ') + ')' : ''
    // A title alone finds any book; subjects narrow fiction and comics. Nonfiction title matches are classified below.
    return this.search([!titleClause || (type && type !== 'Nonfiction') ? subjectClause(type) : '', titleClause], page, type)
  }
  // Shelves show only books with covers; each mode maps to an Open Library sort.
  browse(query: BrowseQuery, page: number, type?: BookType) {
    const { first, last } = query.mode === 'release' ? releaseYearRange(query.period) : { first: new Date().getUTCFullYear(), last: '*' }
    const filter = query.mode === 'rated' ? 'ratings_count:[10 TO *]' : query.mode === 'popular' ? '' : `first_publish_year:[${first} TO ${last}]`
    const sort = { popular: 'trending', rated: 'rating', anticipated: 'want_to_read', release: 'readinglog' }[query.mode]
    return this.search([subjectClause(type), 'cover_i:[1 TO *]', filter], page, type, sort)
  }
  private async search(clauses: string[], page: number, type?: BookType, sort?: string): Promise<CatalogItems> {
    const params = new URLSearchParams({ q: clauses.filter(Boolean).join(' AND '), limit: String(searchResultLimit), page: String(page),
      fields: 'key,title,author_name,cover_i,first_publish_year,subject' })
    if (sort) params.set('sort', sort)
    const data = record(await this.get('search.json?' + params))
    if (!Array.isArray(data?.docs)) throw new CatalogFailure(502)
    const items = records(data.docs).flatMap((row) => {
      const item = book(row)
      return item && item.format === 'BOOK' && (!type || item.bookType === type) ? [item] : []
    })
    return { items, hasMore: page * searchResultLimit < Number(data.numFound ?? data.num_found) }
  }
  async detail(id: string) {
    const row = record(await this.get(`works/${id}.json`))
    const item = row && book(row)
    if (!item) throw new CatalogFailure(502)
    return item
  }
}
