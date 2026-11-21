import { CompassIcon, FireIcon, ListChecksIcon, RepeatIcon, StarIcon, TelevisionIcon, TrophyIcon } from '@phosphor-icons/react'
import type { LibraryEntry } from '../domain/media'
import { badges, streak } from '../domain/share'
import { iconSize } from './tokens'

const icons = { first: ListChecksIcon, ten: TrophyIcon, all: CompassIcon, critic: StarIcon, binge: TelevisionIcon, encore: RepeatIcon }

/** Streak + badges. Earned badges read as achievements; locked ones show progress, never colour alone. */
export function BadgeList({ entries, compact = false }: { entries: readonly LibraryEntry[]; compact?: boolean }) {
  const weeks = streak(entries)
  const list = badges(entries)
  const shown = compact ? list.filter((badge) => badge.progress >= badge.goal) : list
  return (
    // tabIndex: the row scrolls sideways on phones, so keyboard users need to be able to focus it.
    <ul className="badge-row" aria-label="Badges" tabIndex={0}>
      {weeks ? (
        <li className="badge" data-earned>
          <FireIcon size={iconSize.sm} weight="fill" aria-hidden="true" /> {weeks}-week streak
        </li>
      ) : null}
      {shown.map((badge) => {
        const Icon = icons[badge.id as keyof typeof icons]
        const done = badge.progress >= badge.goal
        return (
          <li key={badge.id} className="badge" data-earned={done || undefined} title={badge.detail}>
            <Icon size={iconSize.sm} weight={done ? 'fill' : 'regular'} aria-hidden="true" />
            {badge.label}
            {done ? <span className="sr-only">, earned</span> : <span className="badge-progress">{badge.progress}/{badge.goal}</span>}
          </li>
        )
      })}
    </ul>
  )
}

/** A friend's earned badges, from the ids in their share link. */
export function EarnedBadges({ ids }: { ids: readonly string[] }) {
  const list = badges([]).filter((badge) => ids.includes(badge.id))
  if (!list.length) return null
  return (
    <ul className="badge-row" aria-label="Their badges">
      {list.map((badge) => {
        const Icon = icons[badge.id as keyof typeof icons]
        return <li key={badge.id} className="badge" data-earned title={badge.detail}><Icon size={iconSize.sm} weight="fill" aria-hidden="true" /> {badge.label}</li>
      })}
    </ul>
  )
}
