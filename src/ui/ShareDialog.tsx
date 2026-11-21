import { CopyIcon, ShareNetworkIcon } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { demoById } from '../data/demo'
import { demoMode } from '../data/useCatalog'
import type { LibraryEntry, Media } from '../domain/media'
import { badges, buildProfile, earned, encodeProfile, shareUrl } from '../domain/share'
import { BadgeList } from './Badges'
import { SheetHeader } from './Sheet'
import { iconSize } from './tokens'
import { useModal } from './useModal'

const shareable = (media: Media) => Boolean(media.identity) || (demoMode && demoById.has(media.id))
const nameKey = 'epilog:share-name:v1'
const readName = () => { try { return localStorage.getItem(nameKey) ?? '' } catch { return '' } }

export function ShareDialog({ open, trigger, entries, onClose }: {
  open: boolean
  trigger: RefObject<HTMLElement | null>
  entries: readonly LibraryEntry[]
  onClose: () => void
}) {
  const dialog = useModal(open, trigger)
  const [name, setName] = useState(readName)
  const [link, setLink] = useState<{ for: string; url: string }>()
  const [status, setStatus] = useState('')
  const profile = buildProfile(entries, name, shareable)
  const signature = JSON.stringify(profile)
  const url = link?.for === signature ? link.url : ''
  const count = profile.i.length
  const won = earned(badges(entries))

  useEffect(() => {
    if (!open || !count) return
    let current = true
    void encodeProfile(JSON.parse(signature)).then((payload) => {
      if (current) setLink({ for: signature, url: shareUrl(location.origin, payload) })
    })
    return () => { current = false }
  }, [open, count, signature])

  function rename(value: string) {
    setName(value)
    try { localStorage.setItem(nameKey, value) } catch { /* the name is a convenience; sharing still works */ }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setStatus('Link copied.')
    } catch {
      setStatus('Copy failed. Select the link and copy it.')
    }
  }

  async function share() {
    try {
      await navigator.share({ title: 'My Epilog library', text: `Compare our taste on Epilog: ${count} titles, ${won.length} badges.`, url })
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      await copy()
    }
  }

  return (
    <dialog ref={dialog} className="sheet" aria-labelledby="share-heading" onCancel={(event) => { event.preventDefault(); onClose() }}>
      <div className="sheet-body">
        <SheetHeader id="share-heading" title="Share your library" closeLabel="Close share" onClose={onClose} />
        {count ? (
          <>
            <p className="muted">Friends open your link and see your taste match, the titles you share, and your best picks they haven’t seen.</p>
            <BadgeList entries={entries} compact />
            <label className="field">
              Your name <span className="muted">(optional)</span>
              <input type="text" maxLength={40} value={name} onChange={(event) => rename(event.target.value)} placeholder="Shown to friends" />
            </label>
            <input className="control share-link" readOnly value={url} aria-label="Share link" onFocus={(event) => event.currentTarget.select()} />
            <p className="muted share-note">The link holds the {count} {count === 1 ? 'title' : 'titles'} you’ve watched or played, with ratings and likes. Nothing is uploaded.</p>
            <div className="sheet-actions">
              <button type="button" className="button button-secondary" disabled={!url} onClick={() => void copy()}><CopyIcon size={iconSize.md} aria-hidden="true" /> Copy link</button>
              {'share' in navigator ? (
                <button type="button" className="button button-primary" disabled={!url} onClick={() => void share()}><ShareNetworkIcon size={iconSize.md} aria-hidden="true" /> Share</button>
              ) : null}
            </div>
            <p role="status" className="muted">{status}</p>
          </>
        ) : (
          <p className="muted">Mark something watched, played, or rated first. Your link shares what you’ve seen.</p>
        )}
      </div>
    </dialog>
  )
}
