import { readDefaultSort, sorts } from '../ui/library-preferences'
import type { SortKey } from '../ui/library-preferences'
import { BookTypeFilter } from '../ui/BookTypeFilter'
import type { BookType } from '../domain/books'
import { ArrowLeftIcon, BooksIcon, CaretRightIcon, ChartBarHorizontalIcon, FilmSlateIcon, FunnelSimpleIcon, GameControllerIcon, ShareNetworkIcon, ShootingStarIcon, TelevisionIcon } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useRef, useState } from 'react'
import { Link } from 'react-router'
import type { DiscoverSection } from '../domain/catalog'
import { inCategory, isWatchlisted, matchesQuery, statuses } from '../domain/media'
import type { LibraryEntry } from '../domain/media'
import { isFinished, libraryStats } from '../domain/stats'
import { PosterGrid } from '../ui/MediaCards'
import { crossfade, rise, useMotionEnabled } from '../ui/motion'
import { SearchField } from '../ui/SearchField'
import { ShareDialog } from '../ui/ShareDialog'
import { SheetHeader } from '../ui/Sheet'
import { useModal } from '../ui/useModal'
import { iconSize } from '../ui/tokens'
import { LibraryStats, formatHours } from './LibraryStats'

// Library home rows, in the order people asked for them. Each opens /library?category=<section>.
const rows = [
  { section: 'Movies', label: 'Movies', Icon: FilmSlateIcon, verb: 'watched' },
  { section: 'TV Shows', label: 'TV shows', Icon: TelevisionIcon, verb: 'watched' },
  { section: 'Games', label: 'Games', Icon: GameControllerIcon, verb: 'played' },
  { section: 'Books', label: 'Books', Icon: BooksIcon, verb: 'read' },
  { section: 'Anime', label: 'Anime', Icon: ShootingStarIcon, verb: 'watched' },
] as const satisfies readonly { section: DiscoverSection; label: string; Icon: unknown; verb: string }[]


interface Props {
  entries: ReadonlyMap<string, LibraryEntry>
  view: string | null
  defaultStatus: string | null
  defaultCategory?: DiscoverSection
  highlightId?: string
}

export function Library({ view, defaultCategory, ...props }: Props) {
  if (view === 'stats') return <LibraryStats entries={[...props.entries.values()]} />
  if (defaultCategory) return <LibraryTitles key={defaultCategory} {...props} category={defaultCategory} />
  return <LibraryHome entries={props.entries} />
}

function LibraryHome({ entries }: { entries: ReadonlyMap<string, LibraryEntry> }) {
  const [sharing, setSharing] = useState(false)
  const shareButton = useRef<HTMLButtonElement>(null)
  const all = [...entries.values()]
  const stats = libraryStats(all)
  const hours = stats.watchMinutes + stats.playMinutes
  return (
    <>
      <header className="page-intro">
        <div><h1 tabIndex={-1}>Library</h1><p>Everything you watch, play, and read, in one place.</p></div>
        {entries.size ? (
          <button type="button" className="icon-button" ref={shareButton} aria-label="Share and compare" title="Share and compare" onClick={() => setSharing(true)}>
            <ShareNetworkIcon size={iconSize.md} aria-hidden="true" />
          </button>
        ) : null}
      </header>
      <ShareDialog open={sharing} trigger={shareButton} entries={all} onClose={() => setSharing(false)} />
      <nav aria-label="Library sections">
        <ul className="library-list">
          {rows.map(({ section, label, Icon, verb }) => {
            const saved = all.filter((entry) => inCategory(entry.media, section))
            const finished = saved.filter(isFinished).length
            const queued = saved.filter(isWatchlisted).length
            return (
              <li key={section}>
                <Link className="library-row" to={`/library?category=${encodeURIComponent(section)}`}>
                  <Icon size={iconSize.lg} aria-hidden="true" />
                  <span className="library-row-text">
                    <span className="library-row-title">{label}</span>
                    <span className="library-row-meta">{finished} {verb}{queued ? `, ${queued} on watchlist` : ''}</span>
                  </span>
                  <strong className="library-row-count">{saved.length}</strong>
                  <CaretRightIcon size={iconSize.sm} aria-hidden="true" />
                </Link>
              </li>
            )
          })}
          <li>
            <Link className="library-row" to="/library?view=stats">
              <ChartBarHorizontalIcon size={iconSize.lg} aria-hidden="true" />
              <span className="library-row-text">
                <span className="library-row-title">Stats</span>
                <span className="library-row-meta">{hours ? `${formatHours(hours)} hours, ` : ''}{stats.finished} finished</span>
              </span>
              <CaretRightIcon size={iconSize.sm} aria-hidden="true" />
            </Link>
          </li>
        </ul>
      </nav>
      {!entries.size ? (
        <div className="empty-state">
          <BooksIcon size={iconSize.display} weight="light" aria-hidden="true" />
          <h2>Your library is empty</h2>
          <p>Log a title to get started.</p>
          <Link className="button button-secondary" to="/search">Find a title</Link>
        </div>
      ) : null}
    </>
  )
}

function LibraryTitles({ entries, category, defaultStatus, highlightId }: Omit<Props, 'view' | 'defaultCategory'> & { category: DiscoverSection }) {
  const [status, setStatus] = useState(defaultStatus ?? '')
  const [genre, setGenre] = useState('')
  const [year, setYear] = useState('')
  const [query, setQuery] = useState('')
  const [defaultSort] = useState(readDefaultSort)
  const [sort, setSort] = useState<SortKey>(defaultSort)
  const [bookType, setBookType] = useState<BookType>()
  const [filtering, setFiltering] = useState(false)
  const filterButton = useRef<HTMLButtonElement>(null)
  const filterDialog = useModal(filtering, filterButton, 'select')
  const animate = useMotionEnabled()
  // Defaults (all statuses, genres and years; recent activity) count as no filter.
  const active = [status, genre, year, bookType].filter(Boolean).length + (sort === defaultSort ? 0 : 1)
  const label = rows.find(({ section }) => section === category)?.label ?? category
  const categoryEntries = [...entries.values()].filter(({ media }) => inCategory(media, category))
  const genres = [...new Set(categoryEntries.flatMap(({ media }) => media.genres))].sort()
  const years = [...new Set(categoryEntries.flatMap(({ media }) => media.year ?? []))].sort((a, b) => b - a)
  const visible = categoryEntries.filter((entry) => (
    matchesQuery(entry.media, query) &&
    (!bookType || (entry.media.format === 'BOOK' && entry.media.bookType === bookType)) &&
    (!status || (status === 'Watchlist' ? isWatchlisted(entry) : entry.status === status)) &&
    (!genre || entry.media.genres.includes(genre)) &&
    (!year || String(entry.media.year) === year)
  )).sort(sorts[sort].compare)

  function resetFilters() {
    setStatus('')
    setGenre('')
    setYear('')
    setSort(defaultSort)
    setBookType(undefined)
  }

  function clearFilters() {
    resetFilters()
    setQuery('')
  }

  return (
    <>
      <header className="page-intro">
        <div>
          <Link className="text-action back-link" to="/library"><ArrowLeftIcon size={iconSize.sm} aria-hidden="true" /> Library</Link>
          <h1 tabIndex={-1}>{label}</h1>
          <motion.p key={visible.length} role="status" initial={animate ? 'hidden' : false} animate="visible" variants={rise}>
            {visible.length} {visible.length === 1 ? 'title' : 'titles'}
          </motion.p>
        </div>
        <button
          type="button" className="icon-button filter-button" ref={filterButton} onClick={() => setFiltering(true)}
          aria-label={active ? `Filter, ${active} active` : 'Filter'} title="Filter and sort"
        >
          <FunnelSimpleIcon size={iconSize.md} aria-hidden="true" />
          <AnimatePresence initial={false}>
            {active > 0 && <motion.span key={active} className="filter-count" aria-hidden="true" variants={crossfade}
              initial={animate ? 'hidden' : false} animate="visible">{active}</motion.span>}
          </AnimatePresence>
        </button>
      </header>
      <dialog ref={filterDialog} className="sheet" aria-labelledby="filter-heading" onCancel={(event) => { event.preventDefault(); setFiltering(false) }}>
        <div className="sheet-body">
          <SheetHeader id="filter-heading" title="Filter and sort" closeLabel="Close filters" onClose={() => setFiltering(false)} />
          {category === 'Books' && <BookTypeFilter value={bookType} onChange={setBookType} />}
          <label className="field">Status
            <select className="control" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              <option value="Watchlist">Watchlist</option>
              {statuses.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          {genres.length || genre ? (
            <label className="field">Genre
              <select className="control" value={genre} onChange={(event) => setGenre(event.target.value)}>
                <option value="">All genres</option>
                {genres.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
          ) : null}
          {years.length || year ? (
            <label className="field">Year
              <select className="control" value={year} onChange={(event) => setYear(event.target.value)}>
                <option value="">All years</option>
                {years.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
          ) : null}
          <label className="field">Sort by
            <select className="control" value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
              {Object.entries(sorts).map(([key, { label: name }]) => <option key={key} value={key}>{name}</option>)}
            </select>
          </label>
          <p className="muted" role="status">{visible.length} {visible.length === 1 ? 'title' : 'titles'} shown</p>
          <div className="sheet-actions">
            <button type="button" className="button button-secondary" disabled={!active} onClick={resetFilters}>Reset</button>
            <button type="button" className="button button-primary" onClick={() => setFiltering(false)}>Done</button>
          </div>
        </div>
      </dialog>
      <section aria-label="Saved titles">
        <div className="library-tools">
          <SearchField label="Search library" placeholder={`Search ${label.toLowerCase()}`} value={query} onChange={setQuery} />
        </div>
        <PosterGrid items={visible.map(({ media }) => media)} entries={entries} shelf="Library titles" highlightId={highlightId} />
        {!visible.length ? (
          <motion.div className="empty-state" variants={rise} initial={animate ? 'hidden' : false} animate="visible">
            <BooksIcon size={iconSize.display} weight="light" aria-hidden="true" />
            <h2>{categoryEntries.length ? 'No matching titles' : `No ${label.toLowerCase()} yet`}</h2>
            <p>{categoryEntries.length ? 'Try adjusting your search or filters.' : 'Log a title to see it here.'}</p>
            {categoryEntries.length
              ? <button type="button" className="button button-secondary" onClick={clearFilters}>Clear filters</button>
              : <Link className="button button-secondary" to="/search">Find a title</Link>}
          </motion.div>
        ) : null}
      </section>
    </>
  )
}
