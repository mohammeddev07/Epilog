import { BooksIcon, EyeIcon } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useState } from 'react'
import { Link } from 'react-router'
import { discoverSections } from '../domain/catalog'
import type { DiscoverSection } from '../domain/catalog'
import { inCategory, isWatchlisted, matchesQuery, statuses } from '../domain/media'
import type { LibraryEntry } from '../domain/media'
import { CategoryPicker } from '../ui/CategoryPicker'
import { PosterGrid } from '../ui/MediaCards'
import { rise, useMotionEnabled } from '../ui/motion'
import { SearchField } from '../ui/SearchField'
import { iconSize } from '../ui/tokens'

export function Library({ entries, defaultStatus, defaultCategory, highlightId }: {
  entries: ReadonlyMap<string, LibraryEntry>
  defaultStatus: string | null
  defaultCategory?: DiscoverSection
  highlightId?: string
}) {
  const [category, setCategory] = useState(() => defaultCategory ?? discoverSections.find((category) =>
    [...entries.values()].some((entry) => inCategory(entry.media, category))) ?? discoverSections[0])
  const [status, setStatus] = useState(defaultStatus ?? '')
  const [genre, setGenre] = useState('')
  const [year, setYear] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('recent')
  const animate = useMotionEnabled()
  const categoryEntries = [...entries.values()].filter(({ media }) => inCategory(media, category))
  const genres = [...new Set(categoryEntries.flatMap(({ media }) => media.genres))].sort()
  const years = [...new Set(categoryEntries.flatMap(({ media }) => media.year ?? []))].sort((a, b) => b - a)
  const watched = categoryEntries.filter(({ status, completions }) => status === 'Completed' || completions.length > 0).length
  const watchlisted = categoryEntries.filter(isWatchlisted).length
  const visible = categoryEntries.filter((entry) => (
    matchesQuery(entry.media, query) &&
    (!status || (status === 'Watchlist' ? isWatchlisted(entry) : entry.status === status)) &&
    (!genre || entry.media.genres.includes(genre)) &&
    (!year || String(entry.media.year) === year)
  )).sort((a, b) => sort === 'title' ? a.media.title.localeCompare(b.media.title) : b.updatedAt - a.updatedAt)

  function clearFilters() {
    setStatus('')
    setGenre('')
    setYear('')
    setQuery('')
  }

  return (
    <>
      <header className="page-intro">
        <div><h1 tabIndex={-1}>Library</h1><p>Everything you watch and play, in one place.</p></div>
        <Link to="/search?action=watch" className="button button-primary"><EyeIcon size={iconSize.md} weight="bold" /> Watch</Link>
      </header>
      <section aria-label="Saved titles">
        <div className="library-tabs">
          <CategoryPicker value={category} options={discoverSections} label="Library categories" onChange={(next) => {
            if (next === category) return
            setCategory(next)
            setGenre('')
            setYear('')
          }} />
          <motion.span className="muted result-count" key={visible.length} role="status" initial={animate ? 'hidden' : false} animate="visible" variants={rise}>
            {visible.length} {visible.length === 1 ? 'title' : 'titles'}
          </motion.span>
        </div>
        <dl className="library-totals" aria-label={`${category} totals`} aria-live="polite">
          <div>
            <dt>{category === 'Games' ? 'Played' : 'Watched'}</dt>
            <motion.dd key={watched} variants={rise} initial={animate ? 'hidden' : false} animate="visible">{watched}</motion.dd>
          </div>
          <div>
            <dt>Watchlist</dt>
            <motion.dd key={watchlisted} variants={rise} initial={animate ? 'hidden' : false} animate="visible">{watchlisted}</motion.dd>
          </div>
        </dl>
        <div className="library-tools">
          <SearchField label="Search library" placeholder="Search library" value={query} onChange={setQuery} />
          <label><span className="sr-only">Status filter</span><select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All statuses</option>
            <option value="Watchlist">Watchlist</option>
            {statuses.map((item) => <option key={item}>{item}</option>)}
          </select></label>
          {genres.length || genre ? (
            <label><span className="sr-only">Genre filter</span><select value={genre} onChange={(event) => setGenre(event.target.value)}>
              <option value="">All genres</option>
              {genres.map((item) => <option key={item}>{item}</option>)}
            </select></label>
          ) : null}
          {years.length || year ? (
            <label><span className="sr-only">Year filter</span><select value={year} onChange={(event) => setYear(event.target.value)}>
              <option value="">All years</option>
              {years.map((item) => <option key={item}>{item}</option>)}
            </select></label>
          ) : null}
          <label className="sort"><span className="sr-only">Sort library</span><select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="recent">Recent activity</option><option value="title">Title A–Z</option>
          </select></label>
        </div>
        <PosterGrid items={visible.map(({ media }) => media)} entries={entries} shelf="Library titles" highlightId={highlightId} />
        {!visible.length ? (
          <motion.div className="empty-state" variants={rise} initial={animate ? 'hidden' : false} animate="visible">
            <BooksIcon size={iconSize.display} weight="light" />
            <h2>{entries.size ? 'No matching titles' : 'Your library is empty'}</h2>
            <p>{entries.size ? 'Try adjusting your search or filters.' : 'Log something you’ve watched or played to get started.'}</p>
            {entries.size
              ? <button type="button" className="button button-secondary" onClick={clearFilters}>Clear filters</button>
              : <Link className="button button-secondary" to="/search">Find a title</Link>}
          </motion.div>
        ) : null}
      </section>
    </>
  )
}
