import { ArrowRightIcon, PlusIcon, MagnifyingGlassIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { Link } from 'react-router'
import { demoCatalog } from '../data/demo'
import { demoMode, useConnection, usePopularity } from '../data/useCatalog'
import { discoverResultLimit, interleave, uniqueMedia } from '../domain/catalog'
import { primaryCategory } from '../domain/media'
import type { Category, LibraryEntry } from '../domain/media'
import { CatalogFeedback, catalogMessage, CatalogSkeleton, offlineCacheError } from '../ui/CatalogFeedback'
import { CategoryPicker } from '../ui/CategoryPicker'
import { PosterGrid, ProgressList } from '../ui/MediaCards'
import type { OpenLog } from '../ui/MediaCards'

export function Dashboard({ entries, onLog }: {
  entries: ReadonlyMap<string, LibraryEntry>
  onLog: OpenLog
}) {
  const [category, setCategory] = useState<Category>('All')
  const [retry, setRetry] = useState(0)
  const connected = useConnection()
  const movies = usePopularity('Movies', retry)
  const tv = usePopularity('TV Shows', retry)
  const anime = usePopularity('Anime', retry)
  const games = usePopularity('Games', retry)
  const shelves = { Movies: movies, 'TV Shows': tv, Anime: anime, Games: games }
  const visible = category === 'All' ? Object.entries(shelves) : [[category, shelves[category]]] as const
  const recent = [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  const inProgress = recent.filter((entry) => entry.status === 'In progress').slice(0, 3)
  const planned = recent.filter((entry) => entry.status === 'Planned').slice(0, 3)
  const popular = demoMode
    ? demoCatalog.filter((media) => category === 'All' || primaryCategory(media) === category).slice(0, 6)
    : uniqueMedia(interleave(visible.map(([, shelf]) => shelf.data && 'items' in shelf.data ? shelf.data.items : []))).slice(0, discoverResultLimit)
  const messages = visible.map(([name, shelf]) => catalogMessage(`${name} catalog`, shelf.status, shelf.retryAfter)).filter(Boolean)
  const loading = visible.some(([, shelf]) => shelf.status === 'loading')
  if (visible.some(([, shelf]) => shelf.cacheError)) messages.push(offlineCacheError)
  const error = visible.some(([, shelf]) => ['partial', 'stale', 'unavailable', 'limited'].includes(shelf.status))

  return (
    <>
      <header className="page-intro">
        <div>
          <h1 tabIndex={-1}>Dashboard</h1>
          <p>{entries.size ? 'Pick up where you left off.' : 'Start your library with something you’ve watched or played.'}</p>
        </div>
        <Link to="/search" className="button button-primary"><PlusIcon size={20} weight="bold" /> Log a title</Link>
      </header>

      {inProgress.length ? (
        <section className="shelf" aria-labelledby="continue-heading">
          <h2 id="continue-heading">Continue watching &amp; playing</h2>
          <ProgressList entries={inProgress} label="In progress" />
        </section>
      ) : null}
      {planned.length ? (
        <section className="shelf" aria-labelledby="backlog-heading">
          <div className="shelf-heading"><h2 id="backlog-heading">Up next</h2><Link to="/library?status=Planned" className="text-action">View backlog <ArrowRightIcon size={17} /></Link></div>
          <ProgressList entries={planned} label="Backlog" />
        </section>
      ) : null}

      {!entries.size ? (
        <Link className="search-prompt" to="/search">
          <MagnifyingGlassIcon size={23} />
          <span>Search movies, TV, anime, and games</span>
          <ArrowRightIcon size={20} />
        </Link>
      ) : null}

      <section className="shelf" aria-labelledby="popular-heading">
        <div className="shelf-heading discover-heading">
          <h2 id="popular-heading">Popular now</h2>
          <CategoryPicker value={category} onChange={setCategory} label="Popular now categories" />
        </div>
        <CatalogFeedback messages={messages} retry={connected && error ? () => setRetry((value) => value + 1) : undefined} loading={loading} />
        {popular.length ? <PosterGrid items={popular} entries={entries} shelf="Popular now" onLog={onLog} /> : null}
        {loading && !popular.length ? <CatalogSkeleton /> : null}
        {!demoMode && !loading && !popular.length && !messages.length ? <p className="muted">No popular titles are available right now.</p> : null}
      </section>

      {recent.length ? (
        <section className="shelf" aria-labelledby="recent-heading">
          <div className="shelf-heading"><h2 id="recent-heading">Recently logged</h2><Link to="/library" className="text-action">View library <ArrowRightIcon size={17} /></Link></div>
          <ProgressList entries={recent.slice(0, 3)} label="Recently logged" />
        </section>
      ) : null}
    </>
  )
}
