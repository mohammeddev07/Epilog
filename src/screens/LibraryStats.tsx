import { ArrowLeftIcon } from '@phosphor-icons/react'
import type { CSSProperties } from 'react'
import { Link } from 'react-router'
import { useRuntimeBackfill } from '../data/useCatalog'
import type { CatalogIdentity } from '../domain/identity'
import type { LibraryEntry } from '../domain/media'
import { isFinished, kinds, libraryStats } from '../domain/stats'
import type { Ranked } from '../domain/stats'
import { bookTypeLabels } from '../domain/books'
import { iconSize } from '../ui/tokens'

const count = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const oneDecimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
/** Whole hours from 10 up; one decimal below, so short libraries don't read as 0. */
export const formatHours = (minutes: number) => (minutes >= 600 ? count : oneDecimal).format(minutes / 60)
const month = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const regions = new Intl.DisplayNames(undefined, { type: 'region' })
const languages = new Intl.DisplayNames(undefined, { type: 'language' })
const name = (names: Intl.DisplayNames, code: string) => { try { return names.of(code) ?? code } catch { return code } }

/** A single-series ranked bar list: one hue, labels and values as text, so the list is its own table view. */
function Bars({ title, rows, format = count.format }: { title: string; rows: Ranked; format?: (value: number) => string }) {
  if (!rows.length) return null
  const max = Math.max(...rows.map(([, value]) => value))
  const id = 'bars-' + title.toLowerCase().replaceAll(/\W+/g, '-')
  return (
    <section className="bars" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <ol>
        {rows.map(([label, value]) => (
          <li key={label} title={`${label}: ${format(value)}`}>
            <span className="bars-label">{label}</span>
            <span className="bars-track" aria-hidden="true"><span className="bars-fill" style={{ '--share': value / max } as CSSProperties} /></span>
            <span className="bars-value">{format(value)}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function LibraryStats({ entries }: { entries: readonly LibraryEntry[] }) {
  const stats = libraryStats(entries)
  const hours = (minutes: number) => `${formatHours(minutes)} hr`
  const untimed = entries.filter((entry) => entry.media.format !== 'GAME' && entry.media.format !== 'BOOK' && !entry.media.runtime && entry.media.identity &&
    (isFinished(entry) || entry.status === 'In progress')).map((entry) => entry.media.identity as CatalogIdentity)
  const { working } = useRuntimeBackfill(untimed)
  const totalMinutes = stats.watchMinutes + stats.playMinutes
  const days = totalMinutes / 1440
  // Only figures with something to say: empty and zero values are left out rather than shown as 0.
  const figures = ([
    totalMinutes ? [formatHours(totalMinutes), days >= 1 ? `Hours, about ${oneDecimal.format(days)} days` : 'Hours watched and played'] : null,
    [count.format(stats.finished), 'Titles finished'],
    stats.episodes ? [count.format(stats.episodes), 'Episodes watched'] : null,
    stats.finishedThisYear ? [count.format(stats.finishedThisYear), `Finished in ${new Date().getFullYear()}`] : null,
    stats.genres[0] ? [stats.genres[0][0], 'Top genre'] : null,
    stats.averageRating ? [oneDecimal.format(stats.averageRating), 'Average rating, out of 5'] : null,
    stats.rewatched ? [count.format(stats.rewatched), stats.rewatched === 1 ? 'Title rewatched' : 'Titles rewatched'] : null,
    stats.longestStreakWeeks > 1 ? [`${stats.longestStreakWeeks} weeks`, 'Longest weekly streak'] : null,
    stats.busiestMonth && stats.busiestMonth[1] > 1 ? [month.format(new Date(`${stats.busiestMonth[0]}-01T00:00:00`)), `Busiest month, ${stats.busiestMonth[1]} finished`] : null,
    stats.backlogMinutes ? [formatHours(stats.backlogMinutes), 'Hours on your watchlist'] : null,
  ] as const).filter((figure) => figure !== null)
  const byKind = kinds.map((kind) => [kind, stats.minutesByKind[kind]] as const).filter(([, minutes]) => minutes > 0)

  return (
    <>
      <header className="page-intro">
        <div>
          <Link className="text-action back-link" to="/library"><ArrowLeftIcon size={iconSize.sm} aria-hidden="true" /> Library</Link>
          <h1 tabIndex={-1}>Stats</h1>
          <p>Your viewing, playing, and reading totals.</p>
        </div>
      </header>
      {entries.length ? (
        <>
          <dl className="figures">
            {figures.map(([value, label]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          {stats.reading.titles > 0 && <section className="shelf reading-stats" aria-labelledby="reading-stats">
            <h2 id="reading-stats">Reading</h2>
            <dl className="figures">
              <div><dt>Pages read</dt><dd>{count.format(stats.reading.units.page)}</dd></div>
              <div><dt>Chapters read</dt><dd>{count.format(stats.reading.units.chapter)}</dd></div>
              <div><dt>Volumes read</dt><dd>{count.format(stats.reading.units.volume)}</dd></div>
              <div><dt>Books completed</dt><dd>{count.format(stats.reading.completed)}</dd></div>
            </dl>
            <table><caption>Books by type</caption>
              <thead><tr><th scope="col">Book type</th><th scope="col">In library</th><th scope="col">Completed</th></tr></thead>
              <tbody>{stats.reading.byType.map((row) => <tr key={row.type}>
                <th scope="row">{bookTypeLabels[row.type]}</th><td>{row.titles}</td><td>{row.completed}</td>
              </tr>)}</tbody>
            </table>
          </section>}
          {stats.missingRuntime ? (
            <p className="muted stats-note" role="status">
              {working
                ? `Adding runtimes for ${stats.missingRuntime} ${stats.missingRuntime === 1 ? 'title' : 'titles'}…`
                : `Hours leave out ${stats.missingRuntime} ${stats.missingRuntime === 1 ? 'title' : 'titles'} without a known runtime. They’re added the next time you open Stats online.`}
            </p>
          ) : null}
          <div className="bars-grid">
            <Bars title="Where your hours go" rows={byKind} format={hours} />
            <Bars title="Hours per game" rows={stats.gameHours} format={hours} />
          </div>
          <div className="bars-grid">
            <Bars title="Genres" rows={stats.genres} />
            <Bars title="Countries" rows={stats.countries.map(([code, value]) => [name(regions, code), value] as const)} />
            <Bars title="Languages" rows={stats.languages.map(([code, value]) => [name(languages, code), value] as const)} />
          </div>
          <div className="bars-grid">
            <Bars title="Decades" rows={stats.decades} />
            <Bars title="Your ratings" rows={stats.ratings} />
          </div>
        </>
      ) : (
        <div className="empty-state">
          <h2>No stats yet</h2>
          <p>Your stats appear as you log what you watch and play.</p>
          <Link className="button button-secondary" to="/search">Find a title</Link>
        </div>
      )}
    </>
  )
}
