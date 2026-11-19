import { BookmarkSimpleIcon, EyeIcon, GameControllerIcon, HeartIcon, StarIcon, XIcon } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useRef, useState } from 'react'
import { isWatchlisted, ratings, trackingAction } from '../domain/media'
import type { LibraryEntry, Media, PreferenceChange } from '../domain/media'
import type { OpenLog } from './MediaCards'
import { rise, useMotionEnabled } from './motion'
import { useModal } from './useModal'

export type SavePreference = (media: Media, change: PreferenceChange) => Promise<void>

interface Props {
  media: Media
  entry?: LibraryEntry
  onInteract: () => void
  onLog: OpenLog
  onPreference: SavePreference
}

export function PopularActions({ media, entry, onInteract, onLog, onPreference }: Props) {
  const [ratingOpen, setRatingOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const rateButton = useRef<HTMLButtonElement>(null)
  const rating = entry?.rating
  const dialog = useModal(ratingOpen, rateButton, '[data-rating-focus]')
  const animate = useMotionEnabled()
  const completed = entry?.status === 'Completed'
  const isGame = media.format === 'GAME'
  const WatchIcon = isGame ? GameControllerIcon : EyeIcon
  const watch = trackingAction(media, entry)
  const liked = entry?.liked === true
  const watchlisted = isWatchlisted(entry)

  async function save(change: PreferenceChange) {
    if (pending.current) return
    pending.current = true
    onInteract()
    setBusy(true)
    setError('')
    try {
      await onPreference(media, change)
      if (change.kind === 'rating') setRatingOpen(false)
    } catch {
      setError('Your change could not be saved. Try again.')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  function closeRating() {
    if (pending.current) return
    setError('')
    setRatingOpen(false)
  }

  return (
    <div className="popular-actions">
      <div className="popular-action-bar" role="group" aria-label="Title actions" aria-busy={busy}>
        <button
          type="button" className="button popular-action" data-active={completed || undefined} aria-disabled={busy}
          onClick={(event) => {
            if (pending.current) return
            onInteract()
            onLog(media, event.currentTarget, 'Completed')
          }}
        >
          <motion.span key={watch} variants={rise} initial={animate ? 'hidden' : false} animate="visible" aria-hidden="true">
            <WatchIcon size={24} weight={completed ? 'fill' : 'regular'} />
          </motion.span>
          {watch}
        </button>
        <button type="button" className="button popular-action" aria-pressed={liked} aria-disabled={busy} onClick={() => void save({ kind: 'like', value: !liked })}>
          <motion.span key={String(liked)} variants={rise} initial={animate ? 'hidden' : false} animate="visible" aria-hidden="true">
            <HeartIcon size={24} weight={liked ? 'fill' : 'regular'} />
          </motion.span>
          Like
        </button>
        <button
          ref={rateButton} type="button" className="button popular-action" data-active={Boolean(rating) || undefined}
          aria-haspopup="dialog" aria-label={rating ? 'Rate, ' + rating + ' out of 5 stars' : undefined} aria-disabled={busy}
          onClick={() => {
            if (pending.current) return
            onInteract()
            setError('')
            setRatingOpen(true)
          }}
        >
          <StarIcon size={24} weight={rating ? 'fill' : 'regular'} />
          <motion.span key={rating ?? 'unrated'} variants={rise} initial={animate ? 'hidden' : false} animate="visible">
            {rating ? rating + '/5' : 'Rate'}
          </motion.span>
        </button>
        <button type="button" className="button popular-action" aria-pressed={watchlisted} aria-disabled={busy} onClick={() => void save({ kind: 'watchlist', value: !watchlisted })}>
          <motion.span key={String(watchlisted)} variants={rise} initial={animate ? 'hidden' : false} animate="visible" aria-hidden="true">
            <BookmarkSimpleIcon size={24} weight={watchlisted ? 'fill' : 'regular'} />
          </motion.span>
          Watchlist
        </button>
      </div>
      {error && !ratingOpen ? <motion.p role="alert" className="form-error" variants={rise} initial={animate ? 'hidden' : false} animate="visible">{error}</motion.p> : null}
      <dialog ref={dialog} className="log-dialog" aria-labelledby="rating-heading" onCancel={(event) => { event.preventDefault(); closeRating() }}>
        <div className="log-form">
          <div className="dialog-grip" aria-hidden="true" />
          <div className="dialog-title">
            <h2 id="rating-heading">Rate {media.title}</h2>
            <button type="button" className="icon-button" aria-label="Close rating" onClick={closeRating} disabled={busy}><XIcon size={22} /></button>
          </div>
          <div className="rating-options" role="group" aria-label="Stars">
            {ratings.map((value) => (
              <button
                key={value} type="button" className="icon-button" disabled={busy}
                aria-label={value === 1 ? '1 star' : value + ' stars'} aria-pressed={value === rating}
                data-rating-focus={value === (rating ?? ratings[0]) || undefined}
                onClick={() => void save({ kind: 'rating', value })}
              >
                <StarIcon size={23} weight={rating && value <= rating ? 'fill' : 'regular'} />
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
