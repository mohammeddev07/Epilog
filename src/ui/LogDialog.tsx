import { XIcon } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { formatLabel, isCalendarDate, localDate, parseHours, statuses, titleLengthLimit } from '../domain/media'
import type { LibraryEntry, LogDraft, Media, Status } from '../domain/media'
import { Poster } from './MediaCards'
import { rise, useMotionEnabled } from './motion'

export interface LogSession {
  key: number
  media: Media
  trigger: HTMLElement
}

interface Props {
  session: LogSession | null
  open: boolean
  entry?: LibraryEntry
  onClose: () => void
  onSave: (media: Media, draft: LogDraft) => Promise<void>
}

export function LogDialog({ session, open, entry, onClose, onSave }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)

  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) {
      element.showModal()
      element.querySelector<HTMLElement>('input:checked')?.focus({ preventScroll: true })
    }
    if (!open && element.open) {
      element.close()
      session?.trigger.focus({ preventScroll: true })
    }
  }, [open, session])

  return (
    <dialog
      ref={dialog}
      className="log-dialog"
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
  entry?: LibraryEntry
  busy: boolean
  setBusy: (busy: boolean) => void
  onClose: () => void
  onSave: Props['onSave']
}

function LogForm({ media, entry, busy, setBusy, onClose, onSave }: FormProps) {
  const [status, setStatus] = useState<Status>(entry?.status ?? 'Planned')
  const [date, setDate] = useState(localDate)
  const [another, setAnother] = useState(false)
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
      await onSave(media, {
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
    <form onSubmit={submit} className="log-form" noValidate aria-busy={busy}>
      <div className="dialog-grip" aria-hidden="true" />
      <div className="dialog-title">
        <h2 id="log-heading">{entry ? 'Edit library entry' : 'Log a title'}</h2>
        <button type="button" className="icon-button" aria-label="Close log editor" onClick={onClose} disabled={busy}>
          <XIcon size={22} />
        </button>
      </div>
      <div className="log-summary">
        <Poster media={media} />
        <div><strong>{media.title}</strong><span className="muted">{formatLabel(media)}{media.year ? ` · ${media.year}` : ''}</span></div>
      </div>
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
          <input type="date" value={date} required onChange={(event) => setDate(event.target.value)} disabled={busy} />
        </motion.label>
      ) : null}
      {media.format === 'GAME' ? (
        <label className="field">
          Total hours <span className="muted">(optional)</span>
          <input type="number" min="0" step="any" inputMode="decimal" placeholder="e.g. 12.5" value={hours} onChange={(event) => setHours(event.target.value)} disabled={busy} />
        </label>
      ) : null}
      {media.identity || entry?.label || media.title === 'Saved title' ? (
        <label className="field">
          Title for backups <span className="muted">(optional)</span>
          <input type="text" maxLength={titleLengthLimit} value={label} onChange={(event) => setLabel(event.target.value)} disabled={busy} />
        </label>
      ) : null}
      {error ? (
        <motion.p className="form-error" role="alert" initial={animate ? 'hidden' : false} animate="visible" variants={rise}>
          {error}
        </motion.p>
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? 'Saving…' : entry ? 'Save changes' : 'Save to library'}
        </button>
      </div>
    </form>
  )
}
