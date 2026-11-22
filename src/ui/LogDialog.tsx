import { BookFields, bookFields } from './BookFields'
import { motion } from 'motion/react'
import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { formatLabel, isCalendarDate, localDate, parseHours, statuses, titleLengthLimit } from '../domain/media'
import type { LibraryEntry, LogDraft, Media, Status } from '../domain/media'
import { Poster } from './MediaCards'
import { rise, useMotionEnabled } from './motion'
import { useModal } from './useModal'
import { SheetHeader } from './Sheet'

export interface LogSession {
  key: number
  locationKey: string
  media: Media
  trigger: HTMLElement
  initialStatus?: Status
}

interface Props {
  session: LogSession | null
  open: boolean
  entry?: LibraryEntry
  onClose: () => void
  onSave: (media: Media, draft: LogDraft) => Promise<void>
}

export function LogDialog({ session, open, entry, onClose, onSave }: Props) {
  const dialog = useModal(open, session?.trigger, session?.media.format === 'BOOK' ? '.book-fields input' : 'input:checked')
  const [busy, setBusy] = useState(false)

  return (
    <dialog
      ref={dialog}
      className="sheet"
      aria-labelledby="log-heading"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      {session ? (
        <LogForm
          key={session.key}
          media={session.media}
          initialStatus={session.initialStatus}
          entry={entry}
          busy={busy}
          setBusy={setBusy}
          onClose={onClose}
          onSave={onSave}
        />
      ) : null}
    </dialog>
  )
}

interface FormProps {
  media: Media
  initialStatus?: Status
  entry?: LibraryEntry
  busy: boolean
  setBusy: (busy: boolean) => void
  onClose: () => void
  onSave: Props['onSave']
}

function LogForm({ media, initialStatus, entry, busy, setBusy, onClose, onSave }: FormProps) {
  const [status, setStatus] = useState<Status>(initialStatus ?? entry?.status ?? (media.format === 'BOOK' ? 'In progress' : 'Planned'))
  const [date, setDate] = useState(localDate)
  const [another, setAnother] = useState(false)
  const [book, setBook] = useState(() => {
    const saved = entry?.media ?? media
    return saved.format === 'BOOK' ? bookFields(saved, entry?.reading) : undefined
  })
  const [hours, setHours] = useState(entry?.playtimeMinutes === undefined ? '' : String(entry.playtimeMinutes / 60))
  const [error, setError] = useState('')
  const [label, setLabel] = useState(entry?.label ?? '')
  const pending = useRef(false)
  const completion = useRef<{ date: string; id: string } | undefined>(undefined)
  const animate = useMotionEnabled()
  const previouslyCompleted = entry?.status === 'Completed'
  const needsDate = status === 'Completed' && (!previouslyCompleted || another)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      if (needsDate && !isCalendarDate(date)) throw new Error('Choose a valid completion date.')
      if (needsDate && completion.current?.date !== date) {
        completion.current = { date, id: crypto.randomUUID() }
      }
      if (book && !book.title.trim()) throw new Error('Enter a book title.')
      if (book && entry?.reading?.count && book.unit !== entry.reading.unit && !book.count.trim()) {
        throw new Error(`Enter your progress in ${book.unit}s to change the tracking unit.`)
      }
      const title = media.format === 'BOOK' && book ? { ...media, title: book.title.trim(), bookType: book.type } : media
      await onSave(title, {
        reading: book ? { unit: book.unit, count: Number(book.count), total: book.total ? Number(book.total) : undefined } : undefined,
        status,
        completion: needsDate ? completion.current : undefined,
        label: media.identity || entry?.label || media.title === 'Saved title' ? label : undefined,
        playtimeMinutes: media.format === 'GAME' ? parseHours(hours) : undefined,
      })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The title could not be saved. Try again.')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="sheet-body" noValidate aria-busy={busy}>
      <SheetHeader id="log-heading" title={entry ? 'Edit library entry' : 'Log a title'} closeLabel="Close log editor" onClose={onClose} disabled={busy} />
      {book ? <BookFields fields={book} onChange={setBook} disabled={busy} /> : <div className="log-summary">
        <Poster media={media} />
        <div><strong>{media.title}</strong><span className="muted">{formatLabel(media)}{media.year ? ` · ${media.year}` : ''}</span></div>
      </div>}
      <fieldset disabled={busy} className="status-options">
        <legend>Status</legend>
        <div>
          {statuses.map((option) => (
            <label key={option}>
              <input type="radio" name="status" checked={status === option} onChange={() => setStatus(option)} />
              {option}
            </label>
          ))}
        </div>
      </fieldset>
      {status === 'Completed' && previouslyCompleted ? (
        <label className="check-field">
          <input type="checkbox" checked={another} onChange={(event) => setAnother(event.target.checked)} disabled={busy} />
          Log another completion
        </label>
      ) : null}
      {needsDate ? (
        <motion.label className="field" initial={animate ? 'hidden' : false} animate="visible" variants={rise}>
          {media.format === 'MOVIE' ? 'Watch date' : 'Completion date'}
          <input type="date" value={date} required onChange={(event) => setDate(event.target.value)} disabled={busy} aria-describedby={media.format === 'SERIES' ? 'series-completion-help' : undefined} />
        </motion.label>
      ) : null}
      {needsDate && media.format === 'SERIES' ? (
        <motion.p id="series-completion-help" className="muted" initial={animate ? 'hidden' : false} animate="visible" variants={rise}>
          Episodes through the completion date will be marked watched.
        </motion.p>
      ) : null}
      {media.format === 'GAME' ? (
        <label className="field">
          Total hours <span className="muted">(optional)</span>
          <input type="number" min="0" step="any" inputMode="decimal" placeholder="e.g. 12.5" value={hours} onChange={(event) => setHours(event.target.value)} disabled={busy} />
        </label>
      ) : null}
      {!book && (media.identity || entry?.label || media.title === 'Saved title') ? (
        <label className="field">
          Title for backups <span className="muted">(optional)</span>
          <input type="text" maxLength={titleLengthLimit} value={label} onChange={(event) => setLabel(event.target.value)} disabled={busy} />
        </label>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">{error}</p>
      ) : null}
      <div className="sheet-actions">
        <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? 'Saving…' : entry ? 'Save changes' : 'Save to library'}
        </button>
      </div>
    </form>
  )
}
