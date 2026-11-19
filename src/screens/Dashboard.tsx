import { ArrowRightIcon, EyeIcon, MagnifyingGlassIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { Link } from 'react-router'
import { usePopularTitles } from '../data/usePopularTitles'
import { mediaKey, popularPreviewSize, popularTitle } from '../domain/catalog'
import { categories, isWatchlisted, primaryCategory } from '../domain/media'
import type { Category, LibraryEntry } from '../domain/media'
import { CatalogSkeleton, PopularFeedback } from '../ui/CatalogFeedback'
import { CategoryPicker } from '../ui/CategoryPicker'
import { PosterGrid, ProgressList } from '../ui/MediaCards'
import type { OpenLog } from '../ui/MediaCards'
import { popularPath } from '../ui/popular-navigation'
import { iconSize } from '../ui/tokens'

export function Dashboard({ entries, onLog }: {
  entries: ReadonlyMap<string, LibraryEntry>
  onLog: OpenLog
}) {
  const [category, setCategory] = useState<Category>('All')
  const feed = usePopularTitles(category)
  const popular = feed.items.slice(0, popularPreviewSize)
  const recent = [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  const inProgress = recent.filter((entry) => entry.status === 'In progress').slice(0, 3)
  const planned = recent.filter(isWatchlisted).slice(0, 3)

  return (
    <>
      <header className="page-intro">
        <div>
          <h1 tabIndex={-1}>Dashboard</h1>
          <p>{entries.size ? 'Pick up where you left off.' : 'Start your library with something you’ve watched or played.'}</p>
        </div>
        <Link to="/search?action=watch" className="button button-primary"><EyeIcon size={iconSize.md} weight="bold" /> Watch</Link>
      </header>

      {inProgress.length ? (
        <section className="shelf" aria-labelledby="continue-heading">
          <h2 id="continue-heading">Continue watching &amp; playing</h2>
          <ProgressList entries={inProgress} label="In progress" />
        </section>
      ) : null}
      {planned.length ? (
        <section className="shelf" aria-labelledby="backlog-heading">
          <div className="shelf-heading"><h2 id="backlog-heading">Up next</h2><Link to={'/library?' + new URLSearchParams({ status: 'Watchlist', category: primaryCategory(planned[0].media) })} className="text-action">View backlog <ArrowRightIcon size={iconSize.sm} /></Link></div>
          <ProgressList entries={planned} label="Backlog" />
        </section>
      ) : null}

      {!entries.size ? (
        <Link className="search-prompt" to="/search">
          <MagnifyingGlassIcon size={iconSize.xl} />
          <span>Search movies, TV, anime, and games</span>
          <ArrowRightIcon size={iconSize.md} />
        </Link>
      ) : null}

      <section className="shelf" aria-labelledby="popular-heading">
        <div className="shelf-heading discover-heading">
          <h2 id="popular-heading">{popularTitle}</h2>
          <Link to={popularPath(category)} className="text-action">Browse popular titles <ArrowRightIcon size={iconSize.sm} /></Link>
        </div>
        <CategoryPicker value={category} options={categories} onChange={setCategory} label={popularTitle + ' categories'} />
        <PopularFeedback {...feed} />
        {popular.length ? <PosterGrid items={popular} entries={entries} shelf={popularTitle} onLog={onLog} titleLink={(media) => popularPath(category, mediaKey(media))} /> : null}
        {feed.loading && !popular.length ? <CatalogSkeleton /> : null}
        {!feed.loading && !popular.length ? <p className="muted discover-empty">No popular titles available.</p> : null}
      </section>

      {recent.length ? (
        <section className="shelf" aria-labelledby="recent-heading">
          <div className="shelf-heading"><h2 id="recent-heading">Recently logged</h2><Link to="/library" className="text-action">View library <ArrowRightIcon size={iconSize.sm} /></Link></div>
          <ProgressList entries={recent.slice(0, 3)} label="Recently logged" />
        </section>
      ) : null}
    </>
  )
}
