import { BookmarkSimpleIcon, EyeIcon, GameControllerIcon, HeartIcon, StarIcon } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useEffect, useId, useRef, useState } from 'react'
import { isWatchlisted, ratings, trackingAction } from '../domain/media'
import type { LibraryEntry, Media, PreferenceChange } from '../domain/media'
import type { OpenLog } from './MediaCards'
import { rise, useMotionEnabled } from './motion'
import { useModal } from './useModal'
import { SheetHeader } from './Sheet'
import { iconSize } from './tokens'

export type SavePreference = (media: Media, change: PreferenceChange) => Promise<void>

interface Props {
  media: Media
  entry?: LibraryEntry
  onInteract: () => void
  onLog: OpenLog
  onComplete: (media: Media) => Promise<void>
  onPreference: SavePreference
}

const holdDuration = 500
const holdMovementTolerance = 10

export function PopularActions({ media, entry, onInteract, onLog, onComplete, onPreference }: Props) {
  const [ratingOpen, setRatingOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const rateButton = useRef<HTMLButtonElement>(null)
  const rating = entry?.rating
  const dialog = useModal(ratingOpen, rateButton, '[data-rating-focus]')
  const animate = useMotionEnabled()
  const liked = entry?.liked === true
  const watchlisted = isWatchlisted(entry)

  async function saveAction(action: () => Promise<void>) {
    if (pending.current) return
    pending.current = true
    onInteract()
    setBusy(true)
    setError('')
    try {
      await action()
    } catch {
      setError('Your change could not be saved. Try again.')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  function save(change: PreferenceChange) {
    return saveAction(async () => {
      await onPreference(media, change)
      if (change.kind === 'rating') setRatingOpen(false)
    })
  }

  function closeRating() {
    if (pending.current) return
    setError('')
    setRatingOpen(false)
  }

  return (
    <div className="popular-actions">
      <div className="popular-action-bar" role="group" aria-label="Title actions" aria-busy={busy}>
        <WatchAction media={media} entry={entry} busy={busy} onTap={() => void saveAction(() => onComplete(media))} onHold={(trigger) => {
          if (pending.current) return
          onInteract()
          onLog(media, trigger, 'Completed')
        }} />
        <button type="button" className="button popular-action" aria-pressed={liked} aria-disabled={busy} onClick={() => void save({ kind: 'like', value: !liked })}>
          <motion.span key={String(liked)} variants={rise} initial={animate ? 'hidden' : false} animate="visible" aria-hidden="true">
            <HeartIcon size={iconSize.xl} weight={liked ? 'fill' : 'regular'} />
          </motion.span>
          Like
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
          <StarIcon size={iconSize.xl} weight={rating ? 'fill' : 'regular'} />
          <motion.span key={rating ?? 'unrated'} variants={rise} initial={animate ? 'hidden' : false} animate="visible">
            {rating ? rating + '/5' : 'Rate'}
          </motion.span>
        </button>
        <button type="button" className="button popular-action" aria-pressed={watchlisted} aria-disabled={busy} onClick={() => void save({ kind: 'watchlist', value: !watchlisted })}>
          <motion.span key={String(watchlisted)} variants={rise} initial={animate ? 'hidden' : false} animate="visible" aria-hidden="true">
            <BookmarkSimpleIcon size={iconSize.xl} weight={watchlisted ? 'fill' : 'regular'} />
          </motion.span>
          Watchlist
        </button>
      </div>
      {error && !ratingOpen ? <motion.p role="alert" className="form-error" variants={rise} initial={animate ? 'hidden' : false} animate="visible">{error}</motion.p> : null}
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

function WatchAction({ media, entry, busy, onTap, onHold }: {
  media: Media
  entry?: LibraryEntry
  busy: boolean
  onTap: () => void
  onHold: (trigger: HTMLButtonElement) => void
}) {
  const hint = useId()
  const animate = useMotionEnabled()
  const completed = entry?.status === 'Completed'
  const WatchIcon = media.format === 'GAME' ? GameControllerIcon : EyeIcon
  const label = trackingAction(media, entry)
  const press = useRef<{ id: number; x: number; y: number; timer: number } | undefined>(undefined)
  const suppressClick = useRef(false)

  useEffect(() => () => window.clearTimeout(press.current?.timer), [])

  function stopPress() {
    window.clearTimeout(press.current?.timer)
    press.current = undefined
  }

  return (
    <>
      <button
        type="button" className="button popular-action popular-watch-action" data-active={completed || undefined} aria-disabled={busy}
        aria-describedby={hint} aria-keyshortcuts="Shift+Enter"
        onPointerDown={(event) => {
          if (busy || !event.isPrimary || event.button !== 0) return
          const trigger = event.currentTarget
          stopPress()
          suppressClick.current = false
          trigger.setPointerCapture(event.pointerId)
          const timer = window.setTimeout(() => {
            suppressClick.current = true
            stopPress()
            onHold(trigger)
          }, holdDuration)
          press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, timer }
        }}
        onPointerMove={(event) => {
          const start = press.current
          if (start?.id !== event.pointerId) return
          if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > holdMovementTolerance) {
            suppressClick.current = true
            stopPress()
          }
        }}
        onPointerUp={stopPress}
        // After a hold the sheet rises under the finger; cancel the tap the browser would fire on lift-off.
        onTouchEnd={(event) => { if (suppressClick.current) event.preventDefault() }}
        onPointerCancel={stopPress}
        onLostPointerCapture={stopPress}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !event.shiftKey) return
          event.preventDefault()
          if (!busy && !event.repeat) onHold(event.currentTarget)
        }}
        onClick={(event) => {
          if (event.detail > 0 && suppressClick.current) return
          if (!busy && !completed) onTap()
        }}
      >
        <motion.span key={label} variants={rise} initial={animate ? 'hidden' : false} animate="visible" aria-hidden="true">
          <WatchIcon size={iconSize.xl} weight={completed ? 'fill' : 'regular'} />
        </motion.span>
        {label}
      </button>
      <span className="sr-only" id={hint}>Hold or press Shift+Enter to open the log editor.</span>
    </>
  )
}
