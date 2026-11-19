import { ArrowLeftIcon } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { usePopularTitles } from '../data/usePopularTitles'
import { mediaKey, popularTitle } from '../domain/catalog'
import { categories, formatLabel } from '../domain/media'
import type { LibraryEntry } from '../domain/media'
import { PopularFeedback } from '../ui/CatalogFeedback'
import { CategoryPicker } from '../ui/CategoryPicker'
import { DetailLink } from '../ui/MediaCards'
import type { OpenLog } from '../ui/MediaCards'
import { rise, useMotionEnabled } from '../ui/motion'
import { PopularActions } from '../ui/PopularActions'
import type { SavePreference } from '../ui/PopularActions'
import { readPopularLocation } from '../ui/popular-navigation'
import { popularPosterId, SwipePosters } from '../ui/SwipePosters'

const prefetchDistance = 3

interface Props {
  entries: ReadonlyMap<string, LibraryEntry>
  query: string
  onLog: OpenLog
  onPreference: SavePreference
}

export function Popular({ query, ...actions }: Props) {
  const [view, setView] = useState(() => readPopularLocation(query))

  return (
    <div className="popular-page">
      <header className="popular-header">
        <Link className="text-action" to="/" aria-label="Back to Dashboard"><ArrowLeftIcon size={18} /> Dashboard</Link>
        <h1 tabIndex={-1}>{popularTitle}</h1>
        <CategoryPicker value={view.category} options={categories} label={popularTitle + ' categories'} onChange={(category) => {
          if (category !== view.category) setView({ category, title: null })
        }} />
      </header>
      <PopularCarousel key={view.category} {...view} {...actions} />
    </div>
  )
}

function PopularCarousel({ category, title, entries, onLog, onPreference }: ReturnType<typeof readPopularLocation> & Omit<Props, 'query'>) {
  const [selection, setSelection] = useState({ key: title ?? undefined, waiting: false })
  const prefetchedFrom = useRef<string | undefined>(undefined)
  const animate = useMotionEnabled()
  const feed = usePopularTitles(category)
  const { items, loading, loadingMore, canLoadMore, loadMore } = feed
  const selectedIndex = items.findIndex((media) => mediaKey(media) === selection.key)
  const index = Math.max(0, selectedIndex)
  const media = selection.key && selectedIndex < 0 && loading ? undefined : items[index]
  const key = media ? mediaKey(media) : undefined
  const next = items[index + 1]
  const entry = media ? entries.get(media.id) ?? [...entries.values()].find((entry) => mediaKey(entry.media) === key) : undefined

  if (selection.waiting && next) {
    setSelection({ key: mediaKey(next), waiting: false })
  }

  useEffect(() => {
    if (!canLoadMore) return
    if (!items.length || selection.waiting) {
      loadMore()
    } else if (key && items.length - index <= prefetchDistance && prefetchedFrom.current !== key) {
      prefetchedFrom.current = key
      loadMore()
    }
  }, [canLoadMore, index, items.length, key, loadMore, selection.waiting])

  function step(direction: -1 | 1) {
    const target = items[index + direction]
    if (target) {
      setSelection({ key: mediaKey(target), waiting: false })
      return true
    }
    if (direction === 1 && (canLoadMore || loading)) setSelection({ key, waiting: true })
    return false
  }

  return (
    <>
      {!loadingMore ? <PopularFeedback {...feed} /> : null}
      {media ? (
        <section className="popular-carousel" aria-label="Popular titles" aria-roledescription="carousel">
          <div className="popular-film-heading">
            <h2><DetailLink id={popularPosterId(media)} media={entry?.media ?? media}>{media.title}</DetailLink></h2>
            <p>{[media.year, formatLabel(media)].filter(Boolean).join(' · ')}</p>
          </div>
          <span className="sr-only" aria-live="polite" aria-atomic="true">{media.title}, title {index + 1}</span>
          <SwipePosters items={items} index={index} onStep={step} />
          <PopularActions
            key={key} media={media} entry={entry} onLog={onLog} onPreference={onPreference}
            onInteract={() => setSelection({ key, waiting: false })}
          />
          {loadingMore && !next ? <p className="popular-feed-status" role="status">Loading more titles…</p> : null}
          {!next && !loading && !canLoadMore && !feed.retry && !feed.visible.some(([, shelf]) => shelf.status === 'offline' || shelf.status === 'stale')
            ? <p className="popular-feed-status">You’ve reached the end.</p> : null}
        </section>
      ) : loading || canLoadMore ? (
        <div className="popular-skeleton" aria-hidden="true"><div className="poster-art" data-loading /></div>
      ) : (
        <motion.div className="empty-state" variants={rise} initial={animate ? 'hidden' : false} animate="visible">
          <h2>No popular titles available</h2>
          <Link className="text-action" to="/search">Search catalog</Link>
        </motion.div>
      )}
    </>
  )
}
