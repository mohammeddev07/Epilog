import { ArrowLeftIcon, CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { Link } from 'react-router'
import { usePopularTitles } from '../data/usePopularTitles'
import { mediaKey, popularPageSize, popularTitle } from '../domain/catalog'
import { formatLabel } from '../domain/media'
import type { Category, LibraryEntry } from '../domain/media'
import { PopularFeedback } from '../ui/CatalogFeedback'
import { CategoryPicker } from '../ui/CategoryPicker'
import { DetailLink, Poster } from '../ui/MediaCards'
import type { OpenLog } from '../ui/MediaCards'
import { rise, slide, useMotionEnabled } from '../ui/motion'
import { PopularActions } from '../ui/PopularActions'
import type { SavePreference } from '../ui/PopularActions'
import { readPopularLocation } from '../ui/popular-navigation'

const swipeDistance = 45
const detailTriggerId = 'popular-title-link'

interface Props {
  entries: ReadonlyMap<string, LibraryEntry>
  query: string
  onLog: OpenLog
  onPreference: SavePreference
}

export function Popular({ entries, query, onLog, onPreference }: Props) {
  const initial = readPopularLocation(query)
  const [category, setCategory] = useState(initial.category)
  const [selection, setSelection] = useState({ key: initial.title, direction: 0 })
  const pointer = useRef<{ id: number; x: number; y: number } | undefined>(undefined)
  const animate = useMotionEnabled()
  const feed = usePopularTitles(category)
  const { items, loading } = feed
  const selectedIndex = items.findIndex((media) => mediaKey(media) === selection.key)
  const index = Math.max(0, selectedIndex)
  const waitingForSelection = selection.key !== null && selectedIndex < 0 && loading
  const media = waitingForSelection ? undefined : items[index]
  const previous = items[index - 1]
  const next = items[index + 1]
  const key = media ? mediaKey(media) : undefined
  const entry = media ? entries.get(media.id) ?? [...entries.values()].find((entry) => mediaKey(entry.media) === key) : undefined
  const page = 1 + Math.floor(index / popularPageSize)
  const lastPage = Math.ceil(items.length / popularPageSize)

  function selectCategory(category: Category) {
    setCategory(category)
    setSelection({ key: null, direction: 0 })
  }

  function goTo(target: number) {
    const result = items[target]
    if (!result || target === index) return
    setSelection({ key: mediaKey(result), direction: Math.sign(target - index) })
  }

  function beginSwipe(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0) return
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function endSwipe(event: PointerEvent<HTMLDivElement>) {
    const start = pointer.current
    if (!start || start.id !== event.pointerId) return
    pointer.current = undefined
    const x = event.clientX - start.x
    const y = event.clientY - start.y
    if (Math.abs(x) >= swipeDistance && Math.abs(x) > Math.abs(y)) goTo(index - Math.sign(x))
  }

  return (
    <div className="popular-page">
      <header className="popular-header">
        <Link className="text-action" to="/" aria-label="Back to Dashboard"><ArrowLeftIcon size={18} /> Dashboard</Link>
        <h1 tabIndex={-1}>{popularTitle}</h1>
        <CategoryPicker value={category} onChange={selectCategory} label={popularTitle + ' categories'} />
      </header>
      <PopularFeedback {...feed} />
      {media ? (
        <section className="popular-carousel" aria-label="Popular titles" aria-roledescription="carousel">
          <div className="popular-film-heading">
            <h2><DetailLink id={detailTriggerId} media={entry?.media ?? media}>{media.title}</DetailLink></h2>
            <p>{[media.year, formatLabel(media)].filter(Boolean).join(' · ')}</p>
          </div>
          <span className="sr-only" aria-live="polite" aria-atomic="true">{media.title}, title {index + 1} of {items.length}</span>
          <div
            className="popular-stage" role="group" tabIndex={0} aria-label="Poster. Swipe or use the left and right arrow keys to browse."
            onPointerDown={beginSwipe} onPointerUp={endSwipe} onPointerCancel={() => { pointer.current = undefined }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault()
                goTo(index + (event.key === 'ArrowRight' ? 1 : -1))
              }
            }}
          >
            <div className="popular-peek popular-peek-before" aria-hidden="true">{previous ? <Poster key={mediaKey(previous)} media={previous} eager /> : null}</div>
            <motion.div className="popular-cover" key={key} variants={slide} custom={selection.direction} initial={animate ? 'hidden' : false} animate="visible">
              <Poster media={media} sharedId={detailTriggerId} eager />
            </motion.div>
            <div className="popular-peek popular-peek-after" aria-hidden="true">{next ? <Poster key={mediaKey(next)} media={next} eager /> : null}</div>
          </div>
          <div className="popular-title-controls" role="group" aria-label="Browse titles">
            <button className="icon-button" type="button" aria-label="Previous title" aria-disabled={!previous} onClick={() => goTo(index - 1)}><CaretLeftIcon size={19} /></button>
            <motion.span key={index} variants={rise} initial={animate ? 'hidden' : false} animate="visible" aria-hidden="true">{index + 1} / {items.length}</motion.span>
            <button className="icon-button" type="button" aria-label="Next title" aria-disabled={!next} onClick={() => goTo(index + 1)}><CaretRightIcon size={19} /></button>
          </div>
          <PopularActions
            key={key} media={media} entry={entry} onLog={onLog} onPreference={onPreference}
            onInteract={() => setSelection((current) => ({ ...current, key: mediaKey(media) }))}
          />
          {lastPage > 1 ? (
            <nav className="popular-pagination" aria-label="Popular pages">
              <button className="text-action" type="button" aria-label="Previous page" aria-disabled={page === 1} onClick={() => { if (page > 1) goTo((page - 2) * popularPageSize) }}><CaretLeftIcon size={16} /> Previous</button>
              <span aria-live="polite">Page {page} of {lastPage}</span>
              <button className="text-action" type="button" aria-label="Next page" aria-disabled={page === lastPage} onClick={() => goTo(page * popularPageSize)}>Next <CaretRightIcon size={16} /></button>
            </nav>
          ) : null}
        </section>
      ) : loading ? (
        <div className="popular-skeleton" aria-hidden="true"><div className="poster-art" data-loading /></div>
      ) : (
        <motion.div className="empty-state" variants={rise} initial={animate ? 'hidden' : false} animate="visible">
          <h2>No popular titles available</h2>
          <Link className="text-action" to="/search">Search catalog</Link>
        </motion.div>
      )}
    </div>
  )
}
