import { motion } from 'motion/react'
import { useState } from 'react'
import { demoCatalog } from '../data/demo'
import { demoMode, useConnection, useProviderSearch } from '../data/useCatalog'
import { mediaKey, queryLimit, uniqueMedia } from '../domain/catalog'
import { matchesQuery } from '../domain/media'
import type { LibraryEntry } from '../domain/media'
import { CatalogFeedback, catalogMessage, CatalogSkeleton, offlineCacheError } from '../ui/CatalogFeedback'
import { PosterGrid } from '../ui/MediaCards'
import type { OpenLog } from '../ui/MediaCards'
import { rise, useMotionEnabled } from '../ui/motion'
import { SearchField } from '../ui/SearchField'

export function Search({ entries, onLog }: {
  entries: ReadonlyMap<string, LibraryEntry>
  onLog: OpenLog
}) {
  const [query, setQuery] = useState('')
  const [retry, setRetry] = useState(0)
  const animate = useMotionEnabled()
  const connected = useConnection()
  const tmdb = useProviderSearch('tmdb', query, retry)
  const igdb = useProviderSearch('igdb', query, retry)
  const active = Boolean(query.trim())
  const saved = [...entries.values()].map((entry) => entry.media).filter((media) => matchesQuery(media, query))
  const savedKeys = new Set([...entries.values()].map((entry) => mediaKey(entry.media)))
  const returned = demoMode
    ? demoCatalog.filter((media) => matchesQuery(media, query))
    : [tmdb, igdb].flatMap(({ data }) => data && 'items' in data ? data.items : [])
  const matches = uniqueMedia(returned).filter((media) => !savedKeys.has(mediaKey(media)))
  const found = saved.length + matches.length
  const loading = tmdb.status === 'loading' || igdb.status === 'loading'
  const messages = [catalogMessage('TMDB', tmdb.status, tmdb.retryAfter), catalogMessage('IGDB', igdb.status, igdb.retryAfter)].filter(Boolean)
  if (tmdb.cacheError || igdb.cacheError) messages.push(offlineCacheError)
  const error = [tmdb.status, igdb.status].some((status) => ['partial', 'stale', 'unavailable', 'limited'].includes(status))

  return (
    <>
      <header className="page-intro">
        <div><h1 tabIndex={-1}>Search</h1><p>Find a movie, TV show, anime, or game to log.</p></div>
      </header>
      <SearchField id="catalog-search" className="main-search" label="Search catalog" placeholder="Search titles" value={query} maxLength={queryLimit} onChange={(value) => {
        setQuery(value)
        setRetry(0)
      }} />
      <div className="sr-only" role="status">{found} {found === 1 ? 'result' : 'results'}</div>
      <CatalogFeedback messages={messages} retry={connected && error ? () => setRetry((value) => value + 1) : undefined} loading={loading} />
      {found ? (
        <section className="shelf" aria-labelledby="catalog-matches-heading">
          <h2 id="catalog-matches-heading">{active ? 'Search results' : demoMode ? 'Browse titles' : 'In your library'}</h2>
          <PosterGrid items={[...saved, ...matches]} entries={entries} shelf="Search results" onLog={onLog} />
        </section>
      ) : null}
      {loading && !found ? <CatalogSkeleton /> : null}
      {!loading && !found ? (
        <motion.div className="empty-state" variants={rise} initial={animate ? 'hidden' : false} animate="visible">
          <h2>{active ? (connected && !error ? 'No results found' : 'No available matches') : 'Find your next title'}</h2>
          <p>{active ? (connected ? 'Try a different title or release year.' : 'Saved titles are searchable offline.') : 'Try typing a title you’ve watched or played.'}</p>
        </motion.div>
      ) : null}
    </>
  )
}
