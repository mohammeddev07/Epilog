import { ArrowClockwiseIcon } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { rise, useMotionEnabled } from './motion'
import { iconSize } from './tokens'

export default function InstallStatus() {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const animate = useMotionEnabled()
  const { needRefresh: [needsUpdate, setNeedsUpdate], updateServiceWorker } = useRegisterSW({
    immediate: true,
    onRegisterError: () => setError('Offline setup failed. Reload while online to try again.'),
  })

  async function update() {
    setBusy(true)
    setError('')
    try {
      await updateServiceWorker()
    } catch {
      setError('The update could not be applied. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AnimatePresence>
      {needsUpdate || error ? (
        <motion.aside
          className="update-banner"
          aria-busy={busy}
          aria-label="App update"
          variants={rise}
          initial={animate ? 'hidden' : false}
          animate="visible"
          exit={animate ? 'exit' : undefined}
        >
          {needsUpdate ? (
            <>
              <p role="status">An Epilog update is ready.</p>
              <div className="action-row">
                <button type="button" className="button button-primary" disabled={busy} onClick={() => void update()}>
                  <ArrowClockwiseIcon size={iconSize.sm} /> {busy ? 'Updating…' : 'Update and reload'}
                </button>
                <button type="button" className="button button-secondary" disabled={busy} onClick={() => setNeedsUpdate(false)}>Later</button>
              </div>
            </>
          ) : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
        </motion.aside>
      ) : null}
    </AnimatePresence>
  )
}
