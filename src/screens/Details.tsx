import { ArrowLeftIcon, PencilSimpleIcon, PlusIcon } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { displayDate, formatLabel, isWatchlisted, progressText } from '../domain/media'
import type { LibraryEntry, Media } from '../domain/media'
import { EpisodeTracker } from '../ui/EpisodeTracker'
import type { SetEpisode } from '../ui/EpisodeTracker'
import { Poster } from '../ui/MediaCards'
import type { OpenLog } from '../ui/MediaCards'
import { rise, useMotionEnabled } from '../ui/motion'

interface Props {
  media: Media
  entry?: LibraryEntry
  back?: () => void
  triggerId?: string
  onLog: OpenLog
  onEpisode: SetEpisode
  onRemove: (media: Media) => Promise<void>
}

export function Details({ media, entry, back, triggerId, onLog, onEpisode, onRemove }: Props) {
  const animate = useMotionEnabled()
  const episodes = media.format === 'SERIES' ? media.episodes : undefined

  return (
    <article className="title-detail">
      {back ? (
        <button type="button" className="text-action back-link" onClick={back}><ArrowLeftIcon size={18} /> Back</button>
      ) : (
        <Link className="text-action back-link" to="/library"><ArrowLeftIcon size={18} /> Library</Link>
      )}
      <div className="detail-header">
        <Poster media={media} sharedId={triggerId} eager />
        <div className="detail-copy">
          <p className="title-kicker">{formatLabel(media)}{media.year ? ` · ${media.year}` : ''}</p>
          <h1 tabIndex={-1}>{media.title}</h1>
          {media.description ? <p>{media.description}</p> : null}
          {media.genres.length ? <ul className="genres" aria-label="Genres">{media.genres.map((genre) => <li key={genre}>{genre}</li>)}</ul> : null}
          {entry ? (
            <div className="detail-status">
              {entry.status ? <motion.span key={entry.status} className="status-label" data-status={entry.status} initial={animate ? 'hidden' : false} animate="visible" variants={rise}>{entry.status}</motion.span> : null}
              {progressText(entry) !== (entry.status ?? 'Saved') ? (
                <motion.span className="muted" key={progressText(entry)} initial={animate ? 'hidden' : false} animate="visible" variants={rise}>{progressText(entry)}</motion.span>
              ) : null}
              {entry.liked ? <span className="status-label">Liked</span> : null}
              {entry.rating ? <span className="status-label">Rated {entry.rating}/5</span> : null}
              {isWatchlisted(entry) ? <span className="status-label">Watchlist</span> : null}
            </div>
          ) : null}
          <button type="button" className="button button-primary" onClick={(event) => onLog(media, event.currentTarget)}>
            {entry ? <PencilSimpleIcon size={20} /> : <PlusIcon size={20} weight="bold" />}
            {entry ? 'Edit entry' : 'Log this title'}
          </button>
        </div>
      </div>
      {entry && media.format === 'SERIES' ? <EpisodeTracker entry={entry} episodes={episodes} onEpisode={onEpisode} /> : null}
      {entry ? (
        <section className="shelf detail-section" aria-labelledby="history-heading">
          <h2 id="history-heading">Completion history</h2>
          {entry.completions.length ? (
            <ul className="history-list">
              {entry.completions.toSorted((a, b) => b.date.localeCompare(a.date)).map((completion) => (
                <li key={completion.id}><time dateTime={completion.date}>{displayDate(completion.date)}</time></li>
              ))}
            </ul>
          ) : (
            <p className="muted">No dated completions yet.</p>
          )}
        </section>
      ) : null}
      {entry ? <RemoveEntry onRemove={() => onRemove(media)} /> : null}
    </article>
  )
}

function RemoveEntry({ onRemove }: { onRemove: () => Promise<void> }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const animate = useMotionEnabled()

  async function remove() {
    setBusy(true)
    setError('')
    try {
      await onRemove()
    } catch {
      setError('This entry could not be removed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="shelf detail-section">
      <button type="button" className="text-action danger-action" ref={trigger} aria-expanded={confirm} aria-controls="remove-entry" onClick={() => setConfirm(!confirm)} disabled={busy}>
        Remove from library
      </button>
      {confirm ? (
        <motion.div id="remove-entry" className="remove-entry" variants={rise} initial={animate ? 'hidden' : false} animate="visible">
          <p>Remove this entry and its tracking history from this browser?</p>
          <div className="action-row">
            <button type="button" className="button button-danger" onClick={() => void remove()} disabled={busy}>Remove entry</button>
            <button type="button" className="button button-secondary" onClick={() => { setConfirm(false); trigger.current?.focus() }} disabled={busy}>Keep entry</button>
          </div>
          {error ? <p role="alert" className="form-error">{error}</p> : null}
        </motion.div>
      ) : null}
    </section>
  )
}
