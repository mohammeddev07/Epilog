import { useEffect, useRef, useState } from 'react'
import { deleteAccount, signOut, useGoogleClientId } from '../data/account'
import { library } from '../data/library'
import { sync } from '../data/sync'
import { useSync } from '../data/useSync'
import { SignIn } from './GoogleButton'
import { SheetHeader } from './Sheet'
import { useModal } from './useModal'

type Account = NonNullable<Awaited<ReturnType<typeof library.account>>>
const syncedAt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function AccountPanel() {
  const state = useSync()
  const clientId = useGoogleClientId()
  // `undefined` until the first read, so a signed-in device never flashes the guest sign-in.
  const [account, setAccount] = useState<Account | null>()
  const [sheet, setSheet] = useState<'sign-out' | 'delete'>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [unsynced, setUnsynced] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const refocus = useRef(false)
  const signOutButton = useRef<HTMLButtonElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const signOutDialog = useModal(sheet === 'sign-out', signOutButton, '[data-sign-out-focus]')
  const deleteDialog = useModal(sheet === 'delete', deleteButton, '[data-delete-focus]')

  // Sync state changes whenever the account does (sign-in, sign-out and deletion all finish with a sync).
  useEffect(() => {
    let live = true
    void library.account().then((value) => { if (live) setAccount(value ?? null) })
    return () => { live = false }
  }, [state])

  // The section's contents swap after signing in or out; keep focus in it rather than dropping it to <body>.
  useEffect(() => {
    if (!refocus.current || account === undefined) return
    refocus.current = false
    heading.current?.focus({ preventScroll: true })
  })

  function open(kind: 'sign-out' | 'delete') {
    setError('')
    setNotice('')
    setSheet(kind)
    if (kind === 'sign-out') void library.pendingChanges(1).then((changes) => setUnsynced(changes.length > 0), () => setUnsynced(false))
  }

  function close() {
    if (!busy) setSheet(undefined)
  }

  async function finish(action: () => Promise<string>, failure: string) {
    setBusy(true)
    setError('')
    try {
      const message = await action()
      refocus.current = true
      setSheet(undefined)
      setNotice(message) // the account itself re-reads with the sync state, which both actions end by changing
    } catch {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }

  const leave = (keep: boolean) => finish(async () => {
    const reached = await signOut(keep)
    return (keep ? 'Signed out. This device keeps its library.' : 'Signed out, and this device’s copy was removed.')
      + (reached ? '' : ' Epilog’s server couldn’t be reached, so its session ends on its own.')
  }, 'Couldn’t sign out. Try again.')

  const erase = () => finish(async () => {
    await deleteAccount()
    return 'Your account was deleted. This device keeps its library.'
  }, 'Couldn’t delete your account. Check your connection and try again.')

  if (account === undefined || (account === null && !clientId && !notice)) return null
  const lastSyncAt = ('lastSyncAt' in state ? state.lastSyncAt : undefined) ?? account?.lastSyncAt

  return (
    <section aria-labelledby="account-heading" className="settings-group account-panel">
      <h2 id="account-heading" ref={heading} tabIndex={-1}>Account</h2>
      {notice ? <p role="status" className="muted">{notice}</p> : null}
      {!account ? (
        <>
          <p className="muted">Sign in to keep your library in sync across your devices.</p>
          <SignIn onSignedIn={() => { refocus.current = true; setNotice('') }} />
        </>
      ) : (
        <>
          <p className="account-summary"><strong>{account.name}</strong><span className="muted">{account.email}</span></p>
          {state.status === 'signed-out' ? (
            <>
              <h3>Sign in again</h3>
              <p className="muted">Your session ended, so syncing has paused. This device keeps your library and the changes waiting to sync.</p>
              <SignIn onSignedIn={() => { refocus.current = true }} />
            </>
          ) : (
            <p role="status" className="muted">
              {state.status === 'syncing' ? 'Syncing…' : lastSyncAt ? `Last synced ${syncedAt.format(lastSyncAt)}` : 'Not synced yet'}
            </p>
          )}
          {state.status === 'error' ? (
            <>
              <p role="alert" className="form-error">{state.message}</p>
              <button type="button" className="text-action" onClick={() => void sync.syncNow()}>Try again</button>
            </>
          ) : null}
          <div className="action-row">
            <button ref={signOutButton} type="button" className="button button-secondary" aria-haspopup="dialog" onClick={() => open('sign-out')}>Sign out</button>
            {state.status === 'signed-out' ? null : (
              <button ref={deleteButton} type="button" className="button button-danger" aria-haspopup="dialog" onClick={() => open('delete')}>Delete account</button>
            )}
          </div>
        </>
      )}
      <dialog ref={signOutDialog} className="sheet" aria-labelledby="sign-out-heading" aria-busy={busy} onCancel={(event) => { event.preventDefault(); close() }}>
        <div className="sheet-body">
          <SheetHeader id="sign-out-heading" title="Sign out?" closeLabel="Cancel" onClose={close} disabled={busy} />
          <p className="muted">Your synced library stays in your account. Keep this device’s copy to go on using it as a guest, or remove it.</p>
          {unsynced ? <p className="muted">Some changes on this device haven’t synced yet. Removing this device’s copy loses them.</p> : null}
          <div className="sheet-actions">
            <button type="button" className="button button-primary" data-sign-out-focus disabled={busy} onClick={() => void leave(true)}>Keep this device’s copy</button>
            <button type="button" className="button button-danger" disabled={busy} onClick={() => void leave(false)}>Remove it from this device</button>
          </div>
          {error && sheet === 'sign-out' ? <p role="alert" className="form-error">{error}</p> : null}
        </div>
      </dialog>
      <dialog ref={deleteDialog} className="sheet" aria-labelledby="delete-heading" aria-busy={busy} onCancel={(event) => { event.preventDefault(); close() }}>
        <div className="sheet-body">
          <SheetHeader id="delete-heading" title="Delete your account?" closeLabel="Close" onClose={close} disabled={busy} />
          <p className="muted">This erases your synced library from Epilog’s server. This device keeps its copy.</p>
          <div className="sheet-actions">
            <button type="button" className="button button-secondary" data-delete-focus disabled={busy} onClick={close}>Keep account</button>
            <button type="button" className="button button-danger" disabled={busy} onClick={() => void erase()}>{busy ? 'Deleting…' : 'Delete account'}</button>
          </div>
          {error && sheet === 'delete' ? <p role="alert" className="form-error">{error}</p> : null}
        </div>
      </dialog>
    </section>
  )
}
