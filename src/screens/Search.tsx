import { BookTypeFilter } from '../ui/BookTypeFilter'
import type { BookType } from '../domain/books'
import { motion } from 'motion/react'
import { useState } from 'react'
import { demoCatalog } from '../data/demo'
import { demoMode, useConnection, useProviderSearch } from '../data/useCatalog'
import { mediaKey, queryLimit, uniqueMedia } from '../domain/catalog'
import { categories, inCategory, matchesQuery } from '../domain/media'
import type { Category, LibraryEntry } from '../domain/media'
import { CatalogFeedback, catalogMessage, CatalogSkeleton, offlineCacheError } from '../ui/CatalogFeedback'
import { PosterGrid } from '../ui/MediaCards'
import type { OpenLog } from '../ui/MediaCards'
import { crossfade, useMotionEnabled } from '../ui/motion'
import { SearchField } from '../ui/SearchField'

export function Search({ entries, onLog }: {
  entries: ReadonlyMap<string, LibraryEntry>
  onLog: OpenLog
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category>('All')
  const [bookType, setBookType] = useState<BookType>()
  const [retry, setRetry] = useState(0)
  const [order, setOrder] = useState<{ query: string; keys: string[] }>({ query: '', keys: [] })
  const animate = useMotionEnabled()
  const connected = useConnection()
  const tmdb = useProviderSearch('tmdb', category === 'Books' || category === 'Games' ? '' : query, retry)
  const igdb = useProviderSearch('igdb', category === 'All' || category === 'Games' ? query : '', retry)
  const books = useProviderSearch('openlibrary', category === 'All' || category === 'Books' ? query : '', retry, category === 'Books' ? bookType : undefined)
  const active = Boolean(query.trim())
  const saved = [...entries.values()].map((entry) => entry.media).filter((media) => matchesQuery(media, query))
  const savedKeys = new Set([...entries.values()].map((entry) => mediaKey(entry.media)))
  const returned = demoMode
    ? demoCatalog.filter((media) => matchesQuery(media, query))
    : [tmdb, igdb, books].flatMap(({ data }) => data && 'items' in data ? data.items : [])
  const matches = uniqueMedia(returned).filter((media) => !savedKeys.has(mediaKey(media)))
  // A slower provider can append results without displacing the poster under the pointer.
  const available = new Map([...saved, ...matches].filter((media) => inCategory(media, category) &&
    (category !== 'Books' || !bookType || (media.format === 'BOOK' && media.bookType === bookType))).map((media) => [mediaKey(media), media]))
  const retained = query === order.query ? order.keys.filter((key) => available.has(key)) : []
  const keys = [...new Set([...retained, ...available.keys()])]
  if (query !== order.query || keys.length !== order.keys.length || keys.some((key, i) => key !== order.keys[i])) {
    setOrder({ query, keys })
  }
  const items = keys.map((key) => available.get(key)!)
  const found = items.length
  const loading = [tmdb, igdb, books].some((provider) => provider.status === 'loading')
  const messages = [catalogMessage('TMDB', tmdb.status, tmdb.retryAfter), catalogMessage('IGDB', igdb.status, igdb.retryAfter), catalogMessage('Open Library', books.status, books.retryAfter)].filter(Boolean)
  if (tmdb.cacheError || igdb.cacheError || books.cacheError) messages.push(offlineCacheError)
  const error = [tmdb.status, igdb.status, books.status].some((status) => ['partial', 'stale', 'unavailable', 'limited'].includes(status))

  return (
    <>
      <header className="page-intro">
        <div><h1 tabIndex={-1}>Search</h1><p>Find a movie, TV show, anime, game, or book to log.</p></div>
      </header>
      <SearchField id="catalog-search" className="main-search" label="Search catalog" placeholder="Search titles" value={query} maxLength={queryLimit} onChange={(value) => {
        setQuery(value)
        setRetry(0)
      }} />
      <div className="search-filters">
        <label className="field">Media category<select className="control" value={category} onChange={(event) => setCategory(event.target.value as Category)}>
          {categories.map((option) => <option key={option}>{option}</option>)}
        </select></label>
        {category === 'Books' && <>
          <BookTypeFilter value={bookType} onChange={setBookType} />
          <button type="button" className="button button-secondary" onClick={(event) => onLog({
            id: crypto.randomUUID(), title: query.trim(), description: '', genres: [], format: 'BOOK', bookType: bookType ?? 'Novel',
          }, event.currentTarget, 'In progress')}>Add a book manually</button>
        </>}
      </div>
      <div className="sr-only" role="status">{found} {found === 1 ? 'result' : 'results'}</div>
      {found > 0 || loading ? (
        <section className="shelf" aria-labelledby="catalog-matches-heading">
          <h2 id="catalog-matches-heading">{active ? 'Search results' : demoMode ? 'Browse titles' : 'In your library'}</h2>
          {found ? <PosterGrid items={items} entries={entries} shelf="Search results" onLog={onLog} />
            : <CatalogSkeleton />}
        </section>
      ) : null}
      <CatalogFeedback key={query} ready={[tmdb, igdb, books].some((provider) => provider.status === 'ready') && !loading && !error} messages={messages} retry={connected && error ? () => setRetry((value) => value + 1) : undefined} loading={loading} />
      {!loading && !found ? (
        <motion.div className="empty-state" variants={crossfade} initial={animate ? 'hidden' : false} animate="visible">
          <h2>{active ? (connected && !error ? 'No results found' : 'No available matches') : 'Find your next title'}</h2>
          <p>{active ? (connected ? 'Try a different title or release year.' : 'Saved titles are searchable offline.') : 'Try typing a title.'}</p>
        </motion.div>
      ) : null}
    </>
  )
}
