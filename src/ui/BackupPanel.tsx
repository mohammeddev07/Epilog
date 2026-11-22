import { DownloadSimpleIcon, UploadSimpleIcon } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { library } from '../data/library'
import { useSync } from '../data/useSync'
import { backupFileName, backupSizeLimit } from '../domain/backup'
import type { Backup, RestorePreview } from '../domain/backup'
import { localDate } from '../domain/media'
import { rise, useMotionEnabled } from './motion'
import { iconSize } from './tokens'

export function BackupPanel({ onRestore }: { onRestore: (count: number) => void }) {
  const [preview, setPreview] = useState<RestorePreview>()
  const [preferBackup, setPreferBackup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const filePicker = useRef<HTMLInputElement>(null)
  const chooseFile = useRef<HTMLButtonElement>(null)
  const animate = useMotionEnabled()
  const syncState = useSync()
  const [snapshot, setSnapshot] = useState<{ backup: Backup; savedAt: number }>()

  // Signing in saves the pre-merge snapshot and removing this device's copy clears it; both finish with a sync.
  useEffect(() => {
    let live = true
    void library.mergeSnapshot().then((value) => { if (live) setSnapshot(value) }, () => {})
    return () => { live = false }
  }, [syncState])

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

  function download(backup: () => Promise<Backup>, name = backupFileName()) {
    void run(async () => {
      const file = new Blob([JSON.stringify(await backup(), null, 2)], { type: 'application/json' })
      if (file.size > backupSizeLimit) throw new Error('This library exceeds the 10 MB portable backup limit.')
      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url
      link.download = name
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
    <section aria-labelledby="backup-heading" className="settings-group backup-panel" aria-busy={busy}>
      <h2 id="backup-heading">Backup &amp; Restore</h2>
      <p className="muted">Move your reading progress, history, likes, ratings, and watchlist to another browser. Catalog art isn’t included.</p>
      <div className="action-row">
        <button type="button" className="button button-secondary" disabled={busy} onClick={() => download(library.exportBackup)}>
          <DownloadSimpleIcon size={iconSize.md} /> Export backup
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
          <UploadSimpleIcon size={iconSize.md} /> Choose backup file
        </button>
      </div>
      {snapshot ? (
        <button type="button" className="text-action" disabled={busy}
          onClick={() => download(async () => snapshot.backup, `epilog-library-before-sign-in-${localDate(new Date(snapshot.savedAt))}.json`)}>
          Export library from before sign-in ({new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(snapshot.savedAt)})
        </button>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">{error}</p>
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
