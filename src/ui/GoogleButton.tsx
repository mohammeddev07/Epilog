import { useEffect, useRef, useState } from 'react'
import { signIn, useGoogleClientId } from '../data/account'
import { SheetHeader } from './Sheet'
import { useModal } from './useModal'

declare global {
  interface Window {
    google?: { accounts: { id: {
      initialize(options: { client_id: string; callback: (response: { credential: string }) => void; use_fedcm_for_button: boolean }): void
      renderButton(parent: HTMLElement, options: Record<string, string | number>): void
    } } }
  }
}

const scriptUrl = 'https://accounts.google.com/gsi/client'
let script: Promise<void> | undefined

function loadScript() {
  script ??= new Promise((resolve, reject) => {
    const element = document.createElement('script')
    element.src = scriptUrl
    element.async = true
    element.onload = () => resolve()
    element.onerror = () => {
      element.remove()
      script = undefined
      reject(new Error('Google sign-in could not load.'))
    }
    document.head.append(element)
  })
  return script
}

/** Google's own button (FedCM, callback flow). Renders nothing in the demo or when sign-in isn't configured. */
export function GoogleButton({ onCredential }: { onCredential: (credential: string) => void }) {
  const clientId = useGoogleClientId()
  const container = useRef<HTMLDivElement>(null)
  const latest = useRef(onCredential)
  useEffect(() => { latest.current = onCredential })
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!clientId) return
    let live = true
    loadScript().then(() => {
      const parent = container.current
      if (!live || !parent || !window.google) return
      window.google.accounts.id.initialize({ client_id: clientId, callback: ({ credential }) => latest.current(credential), use_fedcm_for_button: true })
      window.google.accounts.id.renderButton(parent, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: 280 })
    }, () => { if (live) setFailed(true) })
    return () => { live = false }
  }, [clientId])

  if (!clientId) return null
  return (
    <>
      <div ref={container} className="google-button" />
      {failed ? <p role="alert" className="form-error">Google sign-in couldn’t load. Check your connection and reload to try again.</p> : null}
    </>
  )
}

type Answer = (choice: 'merge' | 'replace' | undefined) => void
const cancelled = new Error('Sign-in cancelled.')

/** The Google button plus what signing in needs around it: the merge question, progress and errors. */
export function SignIn({ onSignedIn }: { onSignedIn?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [answer, setAnswer] = useState<Answer>()
  const root = useRef<HTMLDivElement>(null)
  const dialog = useModal(Boolean(answer), root, '[data-merge-focus]')

  const choose = () => new Promise<'merge' | 'replace'>((resolve, reject) => {
    setAnswer(() => (choice: 'merge' | 'replace' | undefined) => {
      setAnswer(undefined)
      if (choice) resolve(choice)
      else reject(cancelled)
    })
  })

  async function start(credential: string) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await signIn(credential, choose)
      onSignedIn?.()
    } catch (reason) {
      if (reason !== cancelled) setError('Couldn’t sign in. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sign-in" ref={root} tabIndex={-1}>
      <GoogleButton onCredential={(credential) => void start(credential)} />
      {busy && !answer ? <p role="status" className="muted">Signing in…</p> : null}
      {error ? <p role="alert" className="form-error">{error}</p> : null}
      <dialog ref={dialog} className="sheet" aria-labelledby="merge-heading" onCancel={(event) => { event.preventDefault(); answer?.(undefined) }}>
        <div className="sheet-body">
          <SheetHeader id="merge-heading" title="This device has another account’s library" closeLabel="Cancel sign-in" onClose={() => answer?.(undefined)} />
          <p className="muted">Merge it into the account you’re signing in to, or replace it with that account’s library. Replacing removes this device’s copy.</p>
          <div className="sheet-actions">
            <button type="button" className="button button-primary" data-merge-focus onClick={() => answer?.('merge')}>Merge into your account</button>
            <button type="button" className="button button-danger" onClick={() => answer?.('replace')}>Replace with your account’s library</button>
          </div>
        </div>
      </dialog>
    </div>
  )
}
