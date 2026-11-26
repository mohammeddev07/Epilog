import { PaperPlaneTiltIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { LibraryEntry } from '../domain/media'
import { compare, decodeProfile, itemMedia } from '../domain/share'
import type { Profile } from '../domain/share'
import { EarnedBadges } from '../ui/Badges'
import { PosterGrid } from '../ui/MediaCards'
import type { OpenLog, QuickComplete } from '../ui/MediaCards'
import { ShareDialog } from '../ui/ShareDialog'
import { iconSize } from '../ui/tokens'

type Decoded = { payload: string; profile?: Profile; error?: string }

export function Compare({ entries, onLog, onComplete, hash }: { hash?: string; entries: ReadonlyMap<string, LibraryEntry>; onLog: OpenLog; onComplete: QuickComplete }) {
  const payload = new URLSearchParams(hash).get('p') ?? ''
  const [decoded, setDecoded] = useState<Decoded>()
  const [sharing, setSharing] = useState(false)
  const sendBack = useRef<HTMLButtonElement>(null)
  const mine = [...entries.values()]

  useEffect(() => {
    let current = true
    decodeProfile(payload).then(
      (profile) => { if (current) setDecoded({ payload, profile }) },
      (cause: Error) => { if (current) setDecoded({ payload, error: cause.message }) },
    )
    return () => { current = false }
  }, [payload])

  const ready = decoded?.payload === payload ? decoded : undefined
  const profile = ready?.profile
  const owner = profile?.n ?? 'A friend'
  // One h1 element across loading, error and ready, so the focus App moves to it on arrival survives the decode.
  const title = !ready ? 'Opening shared library' : profile ? `${owner}’s library` : 'Link not valid'
  if (!profile) {
    return (
      <div className="compare">
        <header className="page-intro"><div><h1 tabIndex={-1}>{title}</h1></div></header>
        {ready ? (
          <div className="empty-state">
            <p>{ready.error} Ask your friend to share it again.</p>
            <Link to="/" className="button button-secondary">Go to Dashboard</Link>
          </div>
        ) : null}
      </div>
    )
  }

  const { match, shared, picks } = compare(mine, profile)
  const hasSeen = shared.length > 0 || mine.some((entry) => entry.status === 'Completed' || entry.status === 'In progress' || entry.rating)

  return (
    <div className="compare">
      <header className="page-intro">
        <div>
          <h1 tabIndex={-1}>{title}</h1>
          <p>{profile.i.length} {profile.i.length === 1 ? 'title' : 'titles'} in this shared library.</p>
        </div>
        <button type="button" className="button button-primary" ref={sendBack} onClick={() => setSharing(true)}>
          <PaperPlaneTiltIcon size={iconSize.md} aria-hidden="true" /> Send yours back
        </button>
      </header>
      <section className="compare-match" aria-label="Taste match">
        {hasSeen ? (
          <>
            <p className="compare-figure"><strong>{match}%</strong> taste match</p>
            <p className="muted">You’ve both seen {shared.length} {shared.length === 1 ? 'title' : 'titles'}.</p>
          </>
        ) : (
          <p className="muted">Log a few titles you’ve seen to get your taste match with {owner}.</p>
        )}
        <EarnedBadges ids={profile.b} />
      </section>
      {picks.length ? (
        <section className="shelf" aria-labelledby="picks-heading">
          <h2 id="picks-heading">{owner === 'A friend' ? 'Their' : `${owner}’s`} picks you haven’t seen</h2>
          <PosterGrid items={picks.map(itemMedia)} entries={entries} shelf="Picks you haven’t seen" onLog={onLog} onComplete={onComplete} />
        </section>
      ) : null}
      {shared.length ? (
        <section className="shelf" aria-labelledby="shared-heading">
          <h2 id="shared-heading">You’ve both seen</h2>
          <PosterGrid items={shared.map(itemMedia)} entries={entries} shelf="Both seen" />
        </section>
      ) : null}
      <ShareDialog open={sharing} trigger={sendBack} entries={mine} onClose={() => setSharing(false)} />
    </div>
  )
}
