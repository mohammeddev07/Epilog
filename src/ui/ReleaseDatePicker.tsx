import { releaseDecades, releaseYearRange } from '../domain/catalog'
import type { ReleasePeriod } from '../domain/catalog'

export function ReleaseDatePicker({ value, onChange }: {
  value: ReleasePeriod
  onChange: (period: ReleasePeriod) => void
}) {
  const { decade, year } = value
  const { first, last } = releaseYearRange({ decade })
  const years = Array.from({ length: last - first + 1 }, (_, index) => first + index)

  return (
    <div className="release-date-picker" role="group" aria-label="Release date filters">
      <label className="field">
        Decade
        <select className="control" value={decade} onChange={(event) => {
          const next = releaseDecades.find((option) => String(option) === event.target.value)
          if (next !== undefined) onChange({ decade: next })
        }}>
          {releaseDecades.map((option) => <option key={option} value={option}>{option}s</option>)}
        </select>
      </label>
      <label className="field">
        Year
        <select className="control" value={year ?? ''} onChange={(event) => {
          const next = years.find((option) => String(option) === event.target.value)
          onChange({ decade, year: next })
        }}>
          <option value="">Any year</option>
          {years.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
    </div>
  )
}
