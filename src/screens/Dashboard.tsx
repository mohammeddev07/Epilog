import { BookTypeFilter } from '../ui/BookTypeFilter'
import type { BookType } from '../domain/books'
import { ArrowRightIcon, MagnifyingGlassIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { Link } from 'react-router'
import { browseModes, defaultPopularCategory, defaultReleasePeriod, discoverSections, popularTitle } from '../domain/catalog'
import type { BrowseQuery, DiscoverSection } from '../domain/catalog'
import { isWatchlisted, primaryCategory } from '../domain/media'
import type { LibraryEntry } from '../domain/media'
import { BrowseShelf } from '../ui/BrowseShelf'
import { CategoryPicker } from '../ui/CategoryPicker'
import { ProgressList } from '../ui/MediaCards'
import type { OpenLog } from '../ui/MediaCards'
import { ReleaseDatePicker } from '../ui/ReleaseDatePicker'
import { iconSize } from '../ui/tokens'

export function Dashboard({ entries, onLog }: {
  entries: ReadonlyMap<string, LibraryEntry>
  onLog: OpenLog
}) {
  const [category, setCategory] = useState<DiscoverSection>(defaultPopularCategory)
  const [bookType, setBookType] = useState<BookType>()
  const [period, setPeriod] = useState(defaultReleasePeriod)
  const recent = [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  const inProgress = recent.filter((entry) => entry.status === 'In progress').slice(0, 3)
  const planned = recent.filter(isWatchlisted).slice(0, 3)

  return (
    <>
      <header className="page-intro dashboard-intro">
        <div>
          <h1 tabIndex={-1}>Dashboard</h1>
          <p>{entries.size ? 'Pick up where you left off.' : 'Start your library with a title you’ve watched, played, or read.'}</p>
        </div>
      </header>

      {inProgress.length ? (
        <section className="shelf progress-row" aria-labelledby="continue-heading">
          <h2 id="continue-heading">Continue where you left off</h2>
          <ProgressList entries={inProgress} label="In progress" />
        </section>
      ) : null}
      {planned.length ? (
        <section className="shelf progress-row" aria-labelledby="backlog-heading">
          <div className="shelf-heading"><h2 id="backlog-heading">Up next</h2><Link to={'/library?' + new URLSearchParams({ status: 'Watchlist', category: primaryCategory(planned[0].media) })} className="text-action">View backlog <ArrowRightIcon size={iconSize.sm} /></Link></div>
          <ProgressList entries={planned} label="Backlog" />
        </section>
      ) : null}

      {!entries.size ? (
        <Link className="search-prompt" to="/search">
          <MagnifyingGlassIcon size={iconSize.sm} />
          <span>Search movies, TV, anime, games, and books</span>
          <ArrowRightIcon size={iconSize.md} />
        </Link>
      ) : null}

      {browseModes.map((mode) => {
        const query: BrowseQuery = { ...(mode === 'release' ? { mode, period } : { mode }), bookType: category === 'Books' ? bookType : undefined }
        return (
          <BrowseShelf key={mode} category={category} query={query} entries={entries} onLog={onLog}>
            {mode === 'popular' ? <CategoryPicker value={category} options={discoverSections} onChange={setCategory} label={popularTitle + ' categories'} /> : null}
            {mode === 'popular' && category === 'Books' && <BookTypeFilter value={bookType} onChange={setBookType} />}
            {mode === 'release' ? <ReleaseDatePicker value={period} onChange={setPeriod} /> : null}
          </BrowseShelf>
        )
      })}

      {recent.length ? (
        <section className="shelf" aria-labelledby="recent-heading">
          <div className="shelf-heading"><h2 id="recent-heading">Recently logged</h2><Link to="/library" className="text-action">View library <ArrowRightIcon size={iconSize.sm} /></Link></div>
          <ProgressList entries={recent.slice(0, 3)} label="Recently logged" />
        </section>
      ) : null}
    </>
  )
}
