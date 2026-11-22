import { CheckCircleIcon, ChecksIcon } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useCatalogSeason } from '../data/useCatalog'
import { CatalogFeedback, catalogMessage, CatalogSkeleton, offlineCacheError } from './CatalogFeedback'
import { episodeKey, episodeWatchState, isEpisodePosition, localDate, manualEpisode, nextEpisode } from '../domain/media'
import type { Episode, LibraryEntry } from '../domain/media'
import { rise, useMotionEnabled } from './motion'
import { iconSize } from './tokens'

export type SetEpisode = (entry: LibraryEntry, episodes: readonly Episode[], watched: boolean, season?: number) => Promise<void>

export function EpisodeTracker({ entry, episodes = [], onEpisode }: {
  entry: LibraryEntry
  episodes?: readonly Episode[]
  onEpisode: SetEpisode
}) {
  const [selection, setSelection] = useState<number>()
  const [retry, setRetry] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const animate = useMotionEnabled()
  const watched = new Map(entry.watched.map((item) => [episodeKey(item), item]))
  const known = entry.media.format === 'SERIES' ? entry.media.seasons ?? [] : []
  const seasons = [...new Set([
    ...known.map(({ number }) => number),
    ...entry.watched.map(({ season }) => season),
    ...episodes.map(({ season }) => season),
  ])].sort((a, b) => a - b)
  const completed = entry.status === 'Completed'
  const firstUnfinished = completed ? undefined : known.find(({ number, episodeCount }) => number > 0 && (
    episodeCount === undefined || !episodeCount || entry.watched.filter((episode) => episode.season === number && episode.number <= episodeCount).length < episodeCount
  ))
  const defaultSeason = firstUnfinished?.number ?? nextEpisode(entry)?.season ?? seasons.find((number) => number > 0) ?? seasons[0]
  const currentSeason = selection !== undefined && seasons.includes(selection) ? selection : defaultSeason
  const catalog = useCatalogSeason(entry.media.identity, currentSeason, retry)
  const available = new Map([...watched, ...[...episodes, ...(catalog.episodes ?? [])].map((episode) => [episodeKey(episode), episode] as const)])
  const isWatched = episodeWatchState(entry)
  const next = nextEpisode(entry) ?? (!completed && currentSeason === defaultSeason
    ? catalog.episodes?.find((episode) => episode.season > 0 && !isWatched(episode))
    : undefined)
  const seasonEpisodes = [...available.values()].filter((episode) => episode.season === currentSeason)
    .sort((first, second) => first.number - second.number)
  // Only aired episodes: marking a season never ticks ones that haven't been released yet.
  const today = localDate()
  const aired = seasonEpisodes.filter((episode) => !episode.airDate || episode.airDate <= today)
  const watchedCount = aired.filter(isWatched).length
  const seasonDone = aired.length > 0 && watchedCount === aired.length
  const seasonName = currentSeason === 0 ? 'specials' : `season ${currentSeason}`
  const feedback = [catalogMessage('episode catalog', catalog.status, catalog.retryAfter), catalog.cacheError ? offlineCacheError : ''].filter(Boolean)

  async function save(episode: Episode | readonly Episode[], checked: boolean, season?: number) {
    const episodes = [episode].flat()
    if (pending.current || !episodes.length) return
    pending.current = true
    setBusy(true)
    setSelection(episodes[0].season)
    setError('')
    try {
      await onEpisode(entry, episodes, checked, season)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Episode progress could not be saved. Try again.')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  function markManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const season = String(fields.get('season') ?? '')
    const number = String(fields.get('number') ?? '')
    const position = { season: Number(season), number: Number(number) }
    if (!season || !number || !isEpisodePosition(position)) {
      setError('Enter a whole-number season and episode. Use season 0 for specials.')
      return
    }
    void save(available.get(episodeKey(position)) ?? manualEpisode(position), true)
  }

  return (
    <section className="shelf detail-section" aria-labelledby="episodes-heading" aria-busy={busy}>
      <h2 id="episodes-heading">Episodes</h2>
      {next ? <p className="muted">Next up · Season {next.season}, episode {next.number} · {next.title}</p> : null}
      <CatalogFeedback key={catalog.key} ready={catalog.status === 'ready'} messages={feedback} retry={catalog.status === 'offline' ? undefined : () => setRetry((value) => value + 1)} loading={catalog.status === 'loading'} />
      {catalog.status === 'loading' && !catalog.episodes ? <CatalogSkeleton /> : null}
      {currentSeason !== undefined ? (
        <>
          <label className="episode-season">Season
            <select value={currentSeason} onChange={(event) => setSelection(Number(event.target.value))}>
              {seasons.map((season) => <option key={season} value={season}>{season === 0 ? 'Specials' : season}</option>)}
            </select>
          </label>
          {aired.length ? (
            <>
              <div className="season-progress">
                <span>{watchedCount} of {aired.length} aired episodes watched</span>
                <span className="season-progress-track" aria-hidden="true">
                  <span style={{ transform: `scaleX(${watchedCount / aired.length})` }} />
                </span>
              </div>
              <button
                type="button" className="button button-secondary season-action" aria-disabled={busy || undefined}
                onClick={() => void save(seasonDone ? aired : aired.filter((episode) => !isWatched(episode)), !seasonDone, currentSeason)}
              >
                {seasonDone ? <CheckCircleIcon size={iconSize.md} weight="fill" aria-hidden="true" /> : <ChecksIcon size={iconSize.md} aria-hidden="true" />}
                Mark {seasonName} {seasonDone ? 'unwatched' : 'watched'}
              </button>
            </>
          ) : null}
          <motion.ul className="episode-list" key={currentSeason} initial={animate ? 'hidden' : false} animate="visible" variants={rise}>
            {seasonEpisodes.map((episode) => (
                <li key={episodeKey(episode)}>
                  <label className="episode-row">
                    <span><span className="muted">{episode.number}.</span> {episode.title}</span>
                    <span className="check-field">
                      Watched
                      <input
                        type="checkbox"
                        aria-label={`Watched ${episode.title}`}
                        checked={isWatched(episode)}
                        aria-disabled={busy || undefined}
                        onChange={(event) => void save(episode, event.target.checked)}
                      />
                    </span>
                  </label>
                </li>
              ))}
          </motion.ul>
        </>
      ) : <p className="muted">Episode details are unavailable. You can still mark an episode by number.</p>}
      <details className="manual-episode">
        <summary>Log an episode by number</summary>
        <form className="manual-episode-form" onSubmit={markManual} noValidate>
          <label className="field">Season number<input type="number" name="season" min="0" defaultValue={currentSeason ?? 1} required /></label>
          <label className="field">Episode number<input type="number" name="number" min="1" required /></label>
          <button type="submit" className="button button-secondary" disabled={busy}>Mark watched</button>
        </form>
      </details>
      {error ? <p role="alert" className="form-error">{error}</p> : null}
    </section>
  )
}
