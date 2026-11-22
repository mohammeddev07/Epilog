import { ArrowLeftIcon } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useBrowseTitles } from '../data/useBrowseTitles'
import { browseCatalogPath, browseLabels, mediaKey } from '../domain/catalog'
import { formatLabel } from '../domain/media'
import type { LibraryEntry, Media } from '../domain/media'
import { BrowseFeedback } from '../ui/CatalogFeedback'
import { DetailLink } from '../ui/MediaCards'
import type { OpenLog } from '../ui/MediaCards'
import { duration, easeOut, rise, useMotionEnabled } from '../ui/motion'
import { PopularActions } from '../ui/PopularActions'
import type { SavePreference } from '../ui/PopularActions'
import { readPopularLocation } from '../ui/popular-navigation'
import { popularPosterId, SwipePosters } from '../ui/SwipePosters'
import { iconSize } from '../ui/tokens'

const prefetchDistance = 3

interface Props {
  entries: ReadonlyMap<string, LibraryEntry>
  query: string
  onLog: OpenLog
  onComplete: (media: Media) => Promise<void>
  onUncomplete: (media: Media) => Promise<void>
  onPreference: SavePreference
}

export function Popular({ query, ...actions }: Props) {
  // Category and collection are chosen on the Dashboard; the carousel only shows the one it was opened with.
  const view = readPopularLocation(query)
  const heading = browseLabels[view.browse.mode]

  return (
    <div className="popular-page">
      <header className="popular-header">
        <Link className="text-action" to="/" aria-label="Back to Dashboard"><ArrowLeftIcon size={iconSize.sm} /> Dashboard</Link>
        <h1 className="sr-only" tabIndex={-1}>{heading}</h1>
      </header>
      <PopularCarousel key={browseCatalogPath(view.category, view.browse, 1)} {...view} {...actions} />
    </div>
  )
}

function PopularCarousel({ browse, category, title, entries, onLog, onComplete, onUncomplete, onPreference }: ReturnType<typeof readPopularLocation> & Omit<Props, 'query'>) {
  // direction: which way the last step went, so the title can slide in from that side.
  const [selection, setSelection] = useState({ key: title ?? undefined, waiting: false, direction: 0 })
  const prefetchedFrom = useRef<string | undefined>(undefined)
  const animate = useMotionEnabled()
  const feed = useBrowseTitles(category, browse)
  const { items, loading, loadingMore, canLoadMore, loadMore } = feed
  const selectedIndex = items.findIndex((media) => mediaKey(media) === selection.key)
  const index = Math.max(0, selectedIndex)
  const media = selection.key && selectedIndex < 0 && loading ? undefined : items[index]
  const key = media ? mediaKey(media) : undefined
  const next = items[index + 1]
  const entry = media ? entries.get(media.id) ?? [...entries.values()].find((entry) => mediaKey(entry.media) === key) : undefined

  if (selection.waiting && next) {
    setSelection({ key: mediaKey(next), waiting: false, direction: 1 })
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
      setSelection({ key: mediaKey(target), waiting: false, direction })
      return true
    }
    if (direction === 1 && (canLoadMore || loading)) setSelection({ key, waiting: true, direction })
    return false
  }

  return (
    <>
      {!loadingMore ? <BrowseFeedback {...feed} /> : null}
      {media ? (
        <section className="popular-carousel" aria-label="Popular titles" aria-roledescription="carousel">
          <motion.div
            key={`heading-${key}`} className="popular-film-heading"
            initial={animate && selection.direction ? { opacity: 0, x: selection.direction * 28 } : false}
            animate={{ opacity: 1, x: 0 }} transition={{ duration: duration.base, ease: easeOut }}
          >
            <h2><DetailLink id={popularPosterId(media)} media={entry?.media ?? media}>{media.title}</DetailLink></h2>
            <p>{[media.year, formatLabel(media)].filter(Boolean).join(' · ')}</p>
          </motion.div>
          <span className="sr-only" aria-live="polite" aria-atomic="true">{media.title}, title {index + 1}</span>
          <SwipePosters detailId={entry?.media.id ?? media.id} items={items} index={index} onStep={step} />
          <PopularActions
            key={key} media={media} entry={entry} onLog={onLog} onComplete={onComplete} onUncomplete={onUncomplete} onPreference={onPreference}
            onInteract={() => setSelection({ key, waiting: false, direction: 0 })}
          />
          {loadingMore && !next ? <p className="popular-feed-status" role="status">Loading more titles…</p> : null}
          {!next && !loading && !canLoadMore && !feed.retry && feed.resource.status !== 'offline' && feed.resource.status !== 'stale'
            ? <p className="popular-feed-status">You’ve reached the end.</p> : null}
        </section>
      ) : loading || canLoadMore ? (
        <div className="popular-skeleton" aria-hidden="true"><div className="poster-art" data-loading /></div>
      ) : (
        <motion.div className="empty-state" variants={rise} initial={animate ? 'hidden' : false} animate="visible">
          <h2>{browse.mode === 'release' ? 'No titles found for this period' : 'No titles available'}</h2>
          <Link className="text-action" to="/search">Search catalog</Link>
        </motion.div>
      )}
    </>
  )
}
