import { CheckIcon, FilmSlateIcon, GameControllerIcon, PlusIcon, TelevisionIcon } from '@phosphor-icons/react'
import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import { useState } from 'react'
import type { ComponentProps } from 'react'
import { Link } from 'react-router'
import { mediaKey } from '../domain/catalog'
import { formatLabel, progressText } from '../domain/media'
import type { LibraryEntry, Media, Status } from '../domain/media'
import { titlePath, useOpenDetail } from './detail-navigation'
import { layoutSpring, rise, useMotionEnabled } from './motion'

export type OpenLog = (media: Media, trigger: HTMLElement, initialStatus?: Status) => void

export function Poster({ media, sharedId, eager = false }: { media: Media; sharedId?: string; eager?: boolean }) {
  const [failedSource, setFailedSource] = useState<string>()
  const [loadedSource, setLoadedSource] = useState<string>()
  const animate = useMotionEnabled()
  const Fallback = media.format === 'GAME' ? GameControllerIcon : media.format === 'SERIES' ? TelevisionIcon : FilmSlateIcon
  const loading = Boolean(media.poster && media.poster !== loadedSource && media.poster !== failedSource)

  return (
    <motion.div className="poster-art" data-loading={loading || undefined} layoutId={animate ? sharedId : undefined} transition={layoutSpring}>
      {media.poster && failedSource !== media.poster ? (
        <img
          src={media.poster}
          alt=""
          width="418"
          height="627"
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={() => setLoadedSource(media.poster)}
          onError={() => setFailedSource(media.poster)}
        />
      ) : (
        <span className="poster-placeholder" aria-hidden="true"><Fallback size={38} weight="thin" /></span>
      )}
    </motion.div>
  )
}

export function DetailLink({
  media, id, children, className,
}: {
  media: Media
  id: string
  children: React.ReactNode
  className?: string
}) {
  const openDetail = useOpenDetail()
  return (
    <Link
      id={id}
      to={titlePath(media.id)}
      onClick={(event) => {
        if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
          event.preventDefault()
          openDetail(media.id, id)
        }
      }}
      className={className}
    >
      {children}
    </Link>
  )
}

function AnimatedListItem(props: ComponentProps<typeof motion.li>) {
  const isPresent = useIsPresent()
  return <motion.li {...props} inert={!isPresent} />
}

interface GridProps {
  items: readonly Media[]
  entries: ReadonlyMap<string, LibraryEntry>
  shelf: string
  onLog?: OpenLog
  titleLink?: (media: Media) => string
  highlightId?: string
}

export function PosterGrid({ items, entries, shelf, onLog, titleLink, highlightId }: GridProps) {
  const animate = useMotionEnabled()
  const openDetail = useOpenDetail()
  const byKey = new Map([...entries.values()].map((entry) => [mediaKey(entry.media), entry]))

  return (
    <ul className="poster-grid" aria-label={shelf}>
      <AnimatePresence mode={animate ? 'popLayout' : 'sync'}>
        {items.map((media, index) => {
          const key = mediaKey(media)
          const entry = entries.get(media.id) ?? byKey.get(key)
          const id = `${shelf}-${key}`.replaceAll(' ', '-').toLowerCase()
          const content = <>
            <Poster media={media} sharedId={id} eager={index < 6} />
            <span className="poster-title">{media.title}</span>
            <span className="poster-meta">{formatLabel(media)}{media.year ? ` · ${media.year}` : ''}</span>
          </>
          return (
            <AnimatedListItem
              key={key}
              className="poster-card"
              data-highlight={highlightId === media.id || undefined}
              layout={animate ? 'position' : false}
              variants={rise}
              initial={animate ? 'hidden' : false}
              animate="visible"
              exit={animate ? 'exit' : undefined}
              custom={index}
              transition={layoutSpring}
            >
              {titleLink ? <Link id={id} to={titleLink(media)} className="poster-link">{content}</Link>
                : <DetailLink id={id} media={entry?.media ?? media} className="poster-link">{content}</DetailLink>}
              {onLog ? (
                <button
                  className="poster-action"
                  id={`${id}-action`}
                  type="button"
                  data-saved={Boolean(entry)}
                  aria-label={entry ? `Open saved entry for ${media.title}` : `Log ${media.title}`}
                  onClick={(event) => {
                    if (entry) openDetail(entry.media.id, event.currentTarget.id, id)
                    else onLog(media, event.currentTarget)
                  }}
                >
                  <motion.span
                    key={entry ? 'saved' : 'add'}
                    variants={rise}
                    initial={animate ? 'hidden' : false}
                    animate="visible"
                    aria-hidden="true"
                  >
                    {entry ? <CheckIcon size={21} weight="bold" /> : <PlusIcon size={21} weight="bold" />}
                  </motion.span>
                </button>
              ) : null}
              {entry?.status ? (
                <motion.span
                  key={entry.status}
                  initial={animate ? 'hidden' : false}
                  animate="visible"
                  variants={rise}
                  className="status-label"
                  data-status={entry.status}
                >
                  {entry.status}
                </motion.span>
              ) : null}
            </AnimatedListItem>
          )
        })}
      </AnimatePresence>
    </ul>
  )
}

export function ProgressList({ entries, label }: { entries: readonly LibraryEntry[]; label: string }) {
  const animate = useMotionEnabled()

  return (
    <ul className="progress-grid" aria-label={label}>
      <AnimatePresence mode={animate ? 'popLayout' : 'sync'}>
        {entries.map((entry, index) => {
          const id = `${label}-${entry.media.id}`.replaceAll(' ', '-').toLowerCase()
          return (
            <AnimatedListItem
              key={entry.media.id}
              layout={animate ? 'position' : false}
              variants={rise}
              initial={animate ? 'hidden' : false}
              animate="visible"
              exit={animate ? 'exit' : undefined}
              custom={index}
              transition={layoutSpring}
            >
              <DetailLink media={entry.media} id={id} className="progress-card">
                <Poster media={entry.media} sharedId={id} />
                <div>
                  <strong>{entry.media.title}</strong>
                  <motion.span
                    className="muted"
                    key={progressText(entry)}
                    initial={animate ? 'hidden' : false}
                    animate="visible"
                    variants={rise}
                  >
                    {progressText(entry)}
                  </motion.span>
                </div>
              </DetailLink>
            </AnimatedListItem>
          )
        })}
      </AnimatePresence>
    </ul>
  )
}
