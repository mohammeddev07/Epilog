import { BookOpenIcon, CheckIcon, FilmSlateIcon, GameControllerIcon, PlusIcon, TelevisionIcon } from '@phosphor-icons/react'
import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import { useId, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { Link } from 'react-router'
import { mediaKey } from '../domain/catalog'
import { formatLabel, progressText } from '../domain/media'
import type { LibraryEntry, Media, Status } from '../domain/media'
import { titlePath, useOpenDetail } from './detail-navigation'
import { layoutSpring, rise, useMotionEnabled } from './motion'
import { iconSize } from './tokens'
import { useHold } from './useHold'

export type OpenLog = (media: Media, trigger: HTMLElement, initialStatus?: Status) => void
export type QuickComplete = (media: Media) => Promise<void>

export function Poster({ media, sharedId, eager = false }: { media: Media; sharedId?: string; eager?: boolean }) {
  const [failedSource, setFailedSource] = useState<string>()
  const [loadedSource, setLoadedSource] = useState<string>()
  const Fallback = media.format === 'BOOK' ? BookOpenIcon : media.format === 'GAME' ? GameControllerIcon : media.format === 'SERIES' ? TelevisionIcon : FilmSlateIcon
  const loading = Boolean(media.poster && media.poster !== loadedSource && media.poster !== failedSource)

  return (
    <div className="poster-art" data-poster-id={sharedId} data-loading={loading || undefined}>
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
        <span className="poster-placeholder" aria-hidden="true">
          <Fallback size={iconSize.poster} weight="thin" />
          <span className="poster-placeholder-title">{media.title}</span>
        </span>
      )}
    </div>
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
  /** When set, tapping + marks the title done today; holding opens the log editor. */
  onComplete?: QuickComplete
  titleLink?: (media: Media) => string
  highlightId?: string
}

export function PosterGrid({ items, entries, shelf, onLog, onComplete, titleLink, highlightId }: GridProps) {
  const animate = useMotionEnabled()
  const byKey = new Map([...entries.values()].map((entry) => [mediaKey(entry.media), entry]))

  return (
    <ul className="poster-grid" aria-label={shelf}>
      <AnimatePresence initial={false} mode={animate ? 'popLayout' : 'sync'}>
        {items.map((media, index) => {
          const key = mediaKey(media)
          const entry = entries.get(media.id) ?? byKey.get(key)
          const id = `${shelf}-${key}`.replaceAll(' ', '-').toLowerCase()
          const content = <>
            <span className="poster-frame">
              <Poster media={media} sharedId={id} eager={index < 6} />
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
            </span>
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
              transition={layoutSpring}
            >
              {titleLink ? <Link id={id} to={titleLink(media)} className="poster-link">{content}</Link>
                : <DetailLink id={id} media={entry?.media ?? media} className="poster-link">{content}</DetailLink>}
              {onLog ? <PosterAction id={`${id}-action`} cardId={id} media={media} entry={entry} onLog={onLog} onComplete={onComplete} /> : null}
            </AnimatedListItem>
          )
        })}
      </AnimatePresence>
    </ul>
  )
}

/** One button for both states, so a dialog it opened can return focus to it after the save. */
function PosterAction({ id, cardId, media, entry, onLog, onComplete }: {
  id: string; cardId: string; media: Media; entry?: LibraryEntry; onLog: OpenLog; onComplete?: QuickComplete
}) {
  const animate = useMotionEnabled()
  const openDetail = useOpenDetail()
  const hint = useId()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const { holding, handlers } = useHold({
    disabled: busy,
    onHold: (trigger) => onLog(media, trigger),
    onTap: () => {
      if (pending.current) return
      pending.current = true
      setBusy(true)
      void onComplete?.(media).finally(() => { pending.current = false; setBusy(false) })
    },
  })
  const done = media.format === 'BOOK' ? 'read' : media.format === 'GAME' ? 'played' : 'watched'
  const quick = Boolean(onComplete) && !entry
  const label = entry ? `Open saved entry for ${media.title}` : onComplete ? `Mark ${media.title} ${done}` : `Log ${media.title}`

  return <>
    <button className="poster-action" id={id} type="button" data-saved={Boolean(entry)} aria-label={label}
      aria-describedby={quick ? hint : undefined} aria-disabled={busy || undefined}
      {...(quick ? handlers : {
        onClick: (event) => {
          if (entry) openDetail(entry.media.id, event.currentTarget.id, cardId)
          else onLog(media, event.currentTarget)
        },
      } satisfies ComponentProps<'button'>)}>
      <motion.span key={entry ? 'saved' : 'add'} variants={rise} initial={animate ? 'hidden' : false} animate="visible" aria-hidden="true">
        {entry ? <CheckIcon size={iconSize.compact} weight="bold" /> : <PlusIcon size={iconSize.compact} weight="bold" />}
        {holding && <svg className="hold-ring" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" pathLength="1" /></svg>}
      </motion.span>
    </button>
    {quick ? <span className="sr-only" id={hint}>Hold or press Shift+Enter to open the log editor.</span> : null}
  </>
}

export function ProgressList({ entries, label }: { entries: readonly LibraryEntry[]; label: string }) {
  const animate = useMotionEnabled()

  return (
    <ul className="progress-grid" aria-label={label}>
      <AnimatePresence initial={false} mode={animate ? 'popLayout' : 'sync'}>
        {entries.map((entry) => {
          const id = `${label}-${entry.media.id}`.replaceAll(' ', '-').toLowerCase()
          return (
            <AnimatedListItem
              key={entry.media.id}
              layout={animate ? 'position' : false}
              variants={rise}
              initial={animate ? 'hidden' : false}
              animate="visible"
              exit={animate ? 'exit' : undefined}
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
