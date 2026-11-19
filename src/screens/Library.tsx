import { BooksIcon, EyeIcon, MagnifyingGlassIcon } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useState } from 'react'
import { Link } from 'react-router'
import { inCategory, isWatchlisted, matchesQuery, statuses } from '../domain/media'
import type { Category, LibraryEntry } from '../domain/media'
import { CategoryPicker } from '../ui/CategoryPicker'
import { PosterGrid } from '../ui/MediaCards'
import { rise, useMotionEnabled } from '../ui/motion'

export function Library({ entries, defaultStatus, highlightId }: {
  entries: ReadonlyMap<string, LibraryEntry>
  defaultStatus: string | null
  highlightId?: string
}) {
  const [category, setCategory] = useState<Category>('All')
  const [status, setStatus] = useState(defaultStatus ?? '')
  const [genre, setGenre] = useState('')
  const [year, setYear] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('recent')
  const animate = useMotionEnabled()
  const all = [...entries.values()]
  const genres = [...new Set(all.flatMap(({ media }) => media.genres))].sort()
  const years = [...new Set(all.flatMap(({ media }) => media.year ?? []))].sort((a, b) => b - a)
  const visible = all.filter((entry) => (
    inCategory(entry.media, category) &&
    matchesQuery(entry.media, query) &&
    (!status || (status === 'Watchlist' ? isWatchlisted(entry) : entry.status === status)) &&
    (!genre || entry.media.genres.includes(genre)) &&
    (!year || String(entry.media.year) === year)
  )).sort((a, b) => sort === 'title' ? a.media.title.localeCompare(b.media.title) : b.updatedAt - a.updatedAt)

  function clearFilters() {
    setCategory('All')
    setStatus('')
    setGenre('')
    setYear('')
    setQuery('')
  }

  return (
    <>
      <header className="page-intro">
        <div><h1 tabIndex={-1}>Library</h1><p>Everything you watch and play, in one place.</p></div>
        <Link to="/search?action=watch" className="button button-primary"><EyeIcon size={20} weight="bold" /> Watch</Link>
      </header>
      <section aria-label="Saved titles">
        <div className="library-tabs">
          <CategoryPicker value={category} onChange={setCategory} label="Library categories" />
          <motion.span className="muted result-count" key={visible.length} role="status" initial={animate ? 'hidden' : false} animate="visible" variants={rise}>
            {visible.length} {visible.length === 1 ? 'title' : 'titles'}
          </motion.span>
        </div>
        <div className="library-tools">
          <label className="search-field">
            <MagnifyingGlassIcon size={19} />
            <span className="sr-only">Search library</span>
            <input type="search" placeholder="Search library" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
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
            <BooksIcon size={32} weight="light" />
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
