import { ArrowRightIcon } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useBrowseTitles } from '../data/useBrowseTitles'
import { browseLabels, browsePreviewSize, mediaKey } from '../domain/catalog'
import type { BrowseQuery, DiscoverSection } from '../domain/catalog'
import type { LibraryEntry } from '../domain/media'
import { BrowseFeedback, CatalogSkeleton } from './CatalogFeedback'
import { PosterGrid } from './MediaCards'
import type { OpenLog, QuickComplete } from './MediaCards'
import { rise, useMotionEnabled } from './motion'
import { browsePath } from './popular-navigation'
import { iconSize } from './tokens'

export function BrowseShelf({ category, query, entries, onLog, onComplete, children }: {
  category: DiscoverSection
  query: BrowseQuery
  entries: ReadonlyMap<string, LibraryEntry>
  onLog: OpenLog
  onComplete?: QuickComplete
  children?: ReactNode
}) {
  const section = useRef<HTMLElement>(null)
  const [active, setActive] = useState(query.mode === 'popular')
  const feed = useBrowseTitles(category, query, active)
  const items = feed.items.slice(0, browsePreviewSize)
  const heading = browseLabels[query.mode]
  const id = `browse-${query.mode}`
  const animate = useMotionEnabled()

  useEffect(() => {
    const target = section.current
    if (active || !target) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setActive(true)
    }, { rootMargin: '240px 0px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [active])

  return (
    <section className="shelf browse-shelf" aria-labelledby={id} ref={section} onFocusCapture={() => setActive(true)}>
      <div className="shelf-heading discover-heading">
        <h2 id={id}>{heading}</h2>
        <Link to={browsePath(category, query)} className="text-action" aria-label={query.mode === 'popular' ? 'Browse popular titles' : `Browse ${heading}`}>
          Browse <ArrowRightIcon size={iconSize.sm} />
        </Link>
      </div>
      {children}
      {items.length ? <PosterGrid items={items} entries={entries} shelf={heading} onLog={onLog} onComplete={onComplete} titleLink={(media) => browsePath(category, query, mediaKey(media))} /> : null}
      {(!active || feed.loading) && !items.length ? <CatalogSkeleton /> : null}
      <BrowseFeedback {...feed} />
      {active && !feed.loading && !items.length ? (
        <motion.p className="muted discover-empty" variants={rise} initial={animate ? 'hidden' : false} animate="visible">
          {query.mode === 'release' ? 'No titles found for this period.' : 'No titles available.'}
        </motion.p>
      ) : null}
    </section>
  )
}
