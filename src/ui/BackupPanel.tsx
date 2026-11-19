import { DownloadSimpleIcon, UploadSimpleIcon } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useRef, useState } from 'react'
import { library } from '../data/library'
import { backupFileName, backupSizeLimit } from '../domain/backup'
import type { RestorePreview } from '../domain/backup'
import { rise, useMotionEnabled } from './motion'

export function BackupPanel({ onRestore }: { onRestore: (count: number) => void }) {
  const [preview, setPreview] = useState<RestorePreview>()
  const [preferBackup, setPreferBackup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const filePicker = useRef<HTMLInputElement>(null)
  const chooseFile = useRef<HTMLButtonElement>(null)
  const animate = useMotionEnabled()

  async function run(operation: () => Promise<void>, fallback: string) {
    setError('')
    setBusy(true)
    try {
      await operation()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback)
    } finally {
      setBusy(false)
    }
  }

  function download() {
    void run(async () => {
      const backup = await library.exportBackup()
      const file = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
      if (file.size > backupSizeLimit) throw new Error('This library exceeds the 10 MB portable backup limit.')
      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url
      link.download = backupFileName()
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    }, 'The library could not be exported. Try again.')
  }

  function review(file: File | undefined) {
    if (!file) return
    setPreview(undefined)
    setPreferBackup(false)
    void run(async () => {
      if (file.size > backupSizeLimit) throw new Error('The backup exceeds 10 MB.')
      const { parseBackup } = await import('../domain/backup-file')
      setPreview(await library.previewRestore(parseBackup(await file.text())))
    }, 'The backup could not be read. Try again.')
  }

  function restore() {
    if (!preview) return
    void run(async () => {
      const count = await library.applyRestore(preview, preferBackup)
      setPreview(undefined)
      onRestore(count)
      requestAnimationFrame(() => chooseFile.current?.focus())
    }, 'The backup could not be restored. Try again.')
  }

  return (
    <section aria-labelledby="backup-heading" className="settings-panel backup-panel">
      <h2 id="backup-heading">Backup and restore</h2>
      <p className="muted">Export your tracking history, likes, ratings, and watchlist to move your library to another browser. Catalog art and provider metadata stay out of the backup.</p>
      <div className="action-row">
        <button type="button" className="button button-secondary" disabled={busy} onClick={download}>
          <DownloadSimpleIcon size={19} /> Export backup
        </button>
        <input
          className="sr-only"
          ref={filePicker}
          type="file"
          accept=".json,application/json"
          aria-label="Epilog backup file"
          tabIndex={-1}
          onChange={(event) => {
            review(event.currentTarget.files?.[0])
            event.currentTarget.value = ''
          }}
        />
        <button type="button" className="button button-secondary" disabled={busy} ref={chooseFile} onClick={() => filePicker.current?.click()}>
          <UploadSimpleIcon size={19} /> Choose backup file
        </button>
      </div>
      {error ? (
        <motion.p className="form-error" role="alert" variants={rise} initial={animate ? 'hidden' : false} animate="visible">{error}</motion.p>
      ) : null}
      {preview ? (
        <motion.div className="backup-preview" variants={rise} initial={animate ? 'hidden' : false} animate="visible">
          <h3>Review restore</h3>
          <p role="status">
            {preview.newCount} new · {preview.duplicateCount} already in library · {preview.conflicts.length} {preview.conflicts.length === 1 ? 'conflict' : 'conflicts'}
          </p>
          {preview.conflicts.length ? (
            <>
              <ul className="backup-conflicts" aria-label="Conflicting fields">
                {preview.conflicts.slice(0, 30).map(({ media, field, current, incoming }, index) => (
                  <li key={`${media.id}-${index}`}>
                    <strong>{media.label ?? media.id} · {field}</strong>
                    <span>Current: {current} · Backup: {incoming}</span>
                  </li>
                ))}
              </ul>
              {preview.conflicts.length > 30 ? <p>Showing the first 30 conflicting fields.</p> : null}
              <fieldset className="status-options" disabled={busy}>
                <legend>For conflicting fields</legend>
                <div>
                  <label><input type="radio" name="backup-conflicts" checked={!preferBackup} onChange={() => setPreferBackup(false)} /> Keep current values</label>
                  <label><input type="radio" name="backup-conflicts" checked={preferBackup} onChange={() => setPreferBackup(true)} /> Use backup values</label>
                </div>
              </fieldset>
            </>
          ) : null}
          <div className="action-row">
            <button type="button" className="button button-primary" disabled={busy} onClick={restore}>
              {busy ? 'Restoring…' : 'Restore backup'}
            </button>
            <button type="button" className="button button-secondary" disabled={busy} onClick={() => { setPreview(undefined); setError(''); chooseFile.current?.focus() }}>Cancel review</button>
          </div>
        </motion.div>
      ) : null}
    </section>
  )
}
