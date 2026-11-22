import { bookTypes, bookTypeLabels, defaultUnit, readingUnits } from '../domain/books'
import type { BookType, ReadingProgress, ReadingUnit } from '../domain/books'
import { titleLengthLimit } from '../domain/media'
import type { Media } from '../domain/media'

export function bookFields(media: Extract<Media, { format: 'BOOK' }>, reading?: ReadingProgress) {
  return { title: media.title, type: media.bookType, unit: reading?.unit ?? defaultUnit(media.bookType),
    count: String(reading?.count ?? ''), total: String(reading?.total ?? '') }
}

type Fields = ReturnType<typeof bookFields>

export function BookFields({ fields, onChange, disabled }: { fields: Fields; onChange: (fields: Fields) => void; disabled: boolean }) {
  function changeUnit(unit: ReadingUnit, type: BookType = fields.type) {
    onChange({ ...fields, type, unit, count: unit === fields.unit ? fields.count : '', total: unit === fields.unit ? fields.total : '' })
  }
  return <fieldset className="book-fields" disabled={disabled}>
    <legend className="sr-only">Book and reading progress</legend>
    <label className="field">Book title<input required maxLength={titleLengthLimit} value={fields.title}
      onChange={(event) => onChange({ ...fields, title: event.target.value })} /></label>
    <label className="field">Book type<select className="control" value={fields.type} onChange={(event) => {
      const type = event.target.value as BookType
      changeUnit(fields.count || fields.total ? fields.unit : defaultUnit(type), type)
    }}>{bookTypes.map((type) => <option key={type} value={type}>{bookTypeLabels[type]}</option>)}</select></label>
    <label className="field">Track by<select className="control" value={fields.unit} onChange={(event) => changeUnit(event.target.value as ReadingUnit)}>
      {readingUnits.map((unit) => <option key={unit} value={unit}>{unit[0].toUpperCase() + unit.slice(1)}s</option>)}
    </select></label>
    <label className="field">{fields.unit[0].toUpperCase() + fields.unit.slice(1)}s read
      <input type="number" min="0" step="1" inputMode="numeric" placeholder="0" value={fields.count}
        onChange={(event) => onChange({ ...fields, count: event.target.value })} /></label>
    <label className="field">Total {fields.unit}s (optional)
      <input type="number" min="1" step="1" inputMode="numeric" value={fields.total}
        onChange={(event) => onChange({ ...fields, total: event.target.value })} /></label>
  </fieldset>
}
