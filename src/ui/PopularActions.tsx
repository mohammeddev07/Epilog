import { BookOpenIcon, BookmarkSimpleIcon, EyeIcon, GameControllerIcon, HeartIcon, StarIcon } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useId, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { displayDate, isWatchlisted, latestCompletion, ratings, trackingAction } from '../domain/media'
import type { LibraryEntry, Media, PreferenceChange } from '../domain/media'
import type { OpenLog } from './MediaCards'
import { crossfade, duration, easeOut, useMotionEnabled } from './motion'
import { useModal } from './useModal'
import { SheetHeader } from './Sheet'
import { useHold } from './useHold'
import { iconSize } from './tokens'

export type SavePreference = (media: Media, change: PreferenceChange) => Promise<void>

interface Props {
  media: Media
  entry?: LibraryEntry
  onInteract: () => void
  onLog: OpenLog
  onComplete: (media: Media) => Promise<void>
  onUncomplete: (media: Media) => Promise<void>
  onPreference: SavePreference
}

export function PopularActions({ media, entry, onInteract, onLog, onComplete, onUncomplete, onPreference }: Props) {
  const [ratingOpen, setRatingOpen] = useState(false)
  const [unwatchOpen, setUnwatchOpen] = useState(false)
  const [saving, setSaving] = useState<'watch' | 'unwatch' | 'add' | 'remove' | 'like' | 'rating'>()
  const busy = saving !== undefined
  const [error, setError] = useState('')
  const pending = useRef(false)
  const rateButton = useRef<HTMLButtonElement>(null)
  const rating = entry?.rating
  const dialog = useModal(ratingOpen, rateButton, '[data-rating-focus]')
  const watchButton = useRef<HTMLButtonElement>(null)
  const unwatchDialog = useModal(unwatchOpen, watchButton, '[data-unwatch-focus]')
  const done = trackingAction(media, entry).toLowerCase()
  const latest = latestCompletion(entry)
  const rewatched = (entry?.completions.length ?? 0) > 1
  const liked = entry?.liked === true
  const watchlisted = isWatchlisted(entry)

  async function saveAction(kind: NonNullable<typeof saving>, action: () => Promise<void>) {
    if (pending.current) return
    pending.current = true
    onInteract()
    setSaving(kind)
    setError('')
    try {
      await action()
    } catch {
      if (kind === 'add' || kind === 'remove') {
        setError(`Couldn’t ${kind === 'add' ? 'add this title to' : 'remove this title from'} Watchlist. Press Watchlist to retry.`)
      } else if (kind === 'unwatch') {
        setError('Couldn’t remove this completion. Try again.')
      } else if (kind === 'watch') {
        setError(`Couldn’t save this completion. Press ${trackingAction(media, entry)} to retry.`)
      } else {
        setError('Your change could not be saved. Try again.')
      }
    } finally {
      pending.current = false
      setSaving(undefined)
    }
  }

  function save(change: PreferenceChange) {
    const kind = change.kind === 'watchlist' ? (change.value ? 'add' : 'remove') : change.kind
    return saveAction(kind, async () => {
      await onPreference(media, change)
      if (change.kind === 'rating') setRatingOpen(false)
    })
  }

  function closeUnwatch() {
    if (pending.current) return
    setError('')
    setUnwatchOpen(false)
  }

  function closeRating() {
    if (pending.current) return
    setError('')
    setRatingOpen(false)
  }

  return (
    <div className="popular-actions">
      <div className="popular-action-bar" role="group" aria-label="Title actions" aria-busy={busy}>
        <WatchAction media={media} entry={entry} busy={busy} saving={saving === 'watch'} buttonRef={watchButton}
          onTap={() => void saveAction('watch', () => onComplete(media))}
          onUndo={() => {
            if (pending.current) return
            onInteract()
            setError('')
            setUnwatchOpen(true)
          }}
          onHold={(trigger) => {
          if (pending.current) return
          onInteract()
          onLog(media, trigger, 'Completed')
        }} />
        <button type="button" className="button popular-action" aria-pressed={liked} aria-disabled={busy} onClick={() => void save({ kind: 'like', value: !liked })}>
          <ToggleIcon on={liked}><HeartIcon size={iconSize.xl} /><HeartIcon size={iconSize.xl} weight="fill" /></ToggleIcon>
          {saving === 'like' ? 'Saving…' : 'Like'}
        </button>
        <button
          ref={rateButton} type="button" className="button popular-action" data-active={Boolean(rating) || undefined}
          aria-haspopup="dialog" aria-label={rating ? 'Rate, ' + rating + '/5 stars' : undefined} aria-disabled={busy}
          onClick={() => {
            if (pending.current) return
            onInteract()
            setError('')
            setRatingOpen(true)
          }}
        >
          <ToggleIcon on={Boolean(rating)}><StarIcon size={iconSize.xl} weight={rating ? 'fill' : 'regular'} /></ToggleIcon>
          <span>{saving === 'rating' ? 'Saving…' : rating ? rating + '/5' : 'Rate'}</span>
        </button>
        <button type="button" className="button popular-action" aria-pressed={watchlisted} aria-disabled={busy} onClick={() => void save({ kind: 'watchlist', value: !watchlisted })}>
          <ToggleIcon on={watchlisted}><BookmarkSimpleIcon size={iconSize.xl} /><BookmarkSimpleIcon size={iconSize.xl} weight="fill" /></ToggleIcon>
          {saving === 'add' ? 'Adding…' : saving === 'remove' ? 'Removing…' : 'Watchlist'}
        </button>
      </div>
      {error && !ratingOpen && !unwatchOpen ? <p role="alert" className="form-error">{error}</p> : null}
      <dialog ref={unwatchDialog} className="sheet" aria-labelledby="unwatch-heading" onCancel={(event) => { event.preventDefault(); closeUnwatch() }}>
        <div className="sheet-body">
          <SheetHeader id="unwatch-heading" title={rewatched ? 'Remove the latest completion?' : `Mark as not ${done}?`} closeLabel="Close" onClose={closeUnwatch} disabled={busy} />
          <p className="muted">
            {latest ? `This removes the completion logged on ${displayDate(latest.date)}. ` : ''}
            {rewatched ? `Earlier ones stay, so ${media.title} remains ${done}.` : 'Your like, rating, and Watchlist stay as they are.'}
          </p>
          <div className="sheet-actions">
            <button type="button" className="button button-secondary" data-unwatch-focus onClick={closeUnwatch} disabled={busy}>Keep</button>
            <button type="button" className="button button-danger" disabled={busy}
              onClick={() => void saveAction('unwatch', async () => { await onUncomplete(media); setUnwatchOpen(false) })}>
              {saving === 'unwatch' ? 'Removing…' : 'Remove'}
            </button>
          </div>
          {error && unwatchOpen ? <p className="form-error" role="alert">{error}</p> : null}
        </div>
      </dialog>
      <dialog ref={dialog} className="sheet" aria-labelledby="rating-heading" onCancel={(event) => { event.preventDefault(); closeRating() }}>
        <div className="sheet-body">
          <SheetHeader id="rating-heading" title={`Rate ${media.title}`} closeLabel="Close rating" onClose={closeRating} disabled={busy} />
          <div className="rating-options" role="group" aria-label="Stars">
            {ratings.map((value) => (
              <button
                key={value} type="button" className="icon-button" disabled={busy}
                aria-label={value === 1 ? '1 star' : value + ' stars'} aria-pressed={value === rating}
                data-rating-focus={value === (rating ?? ratings[0]) || undefined}
                onClick={() => void save({ kind: 'rating', value })}
              >
                <StarIcon size={iconSize.xl} weight={rating && value <= rating ? 'fill' : 'regular'} />
              </button>
            ))}
          </div>
          {rating ? <button type="button" className="text-action rating-clear" onClick={() => void save({ kind: 'rating', value: null })} disabled={busy}>Clear rating</button> : null}
          {error && ratingOpen ? <p className="form-error" role="alert">{error}</p> : null}
        </div>
      </dialog>
    </div>
  )
}

const pop = {
  off: { scale: 1 },
  on: { scale: [1, 1.32, 0.92, 1], transition: { duration: duration.slow, ease: easeOut } },
}
const burst = {
  off: { opacity: 0, scale: 0.4 },
  on: { opacity: [0.7, 0], scale: [0.4, 1.7], transition: { duration: duration.slow, ease: easeOut } },
}

/** Pops, with a ring bursting out, when the action turns on; mounting already on stays still. */
function ToggleIcon({ on, className = 'toggle-icon', children }: { on: boolean; className?: string; children: ReactNode }) {
  return (
    <motion.span className={className} aria-hidden="true" variants={pop} initial={false} animate={on ? 'on' : 'off'}>
      {children}
      <motion.span className="toggle-burst" variants={burst} />
    </motion.span>
  )
}

function WatchAction({ media, entry, busy, saving, buttonRef, onTap, onUndo, onHold }: {
  media: Media
  entry?: LibraryEntry
  busy: boolean
  saving: boolean
  buttonRef: RefObject<HTMLButtonElement | null>
  onTap: () => void
  onUndo: () => void
  onHold: (trigger: HTMLButtonElement) => void
}) {
  const hint = useId()
  const animate = useMotionEnabled()
  const completed = entry?.status === 'Completed'
  const WatchIcon = media.format === 'BOOK' ? BookOpenIcon : media.format === 'GAME' ? GameControllerIcon : EyeIcon
  const label = trackingAction(media, entry)
  const { holding, handlers } = useHold({ disabled: busy, onTap: () => (completed ? onUndo() : onTap()), onHold })

  return (
    <>
      <button
        ref={buttonRef} type="button" className="button popular-action popular-watch-action" data-active={completed || undefined} aria-disabled={busy}
        aria-describedby={hint} {...handlers}
      >
        <ToggleIcon on={completed} className="toggle-icon watch-icon">
          <WatchIcon size={iconSize.xl} /><WatchIcon size={iconSize.xl} weight="fill" />
          {holding && <svg className="hold-ring" viewBox="0 0 32 32">
            <circle cx="16" cy="16" r="14" pathLength="1" />
          </svg>}
        </ToggleIcon>
        <span className="action-label">
          <AnimatePresence initial={false}>
            <motion.span key={label} variants={crossfade} initial={animate ? 'hidden' : false} animate="visible">
              {saving ? 'Saving…' : label}
            </motion.span>
          </AnimatePresence>
        </span>
      </button>
      <span className="sr-only" id={hint}>{completed ? 'Press to remove this completion. ' : ''}Hold or press Shift+Enter to open the log editor.</span>
    </>
  )
}
