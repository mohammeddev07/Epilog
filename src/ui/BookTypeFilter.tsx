import { bookTypes, bookTypeLabels } from '../domain/books'
import type { BookType } from '../domain/books'

export function BookTypeFilter({ value, onChange }: { value?: BookType; onChange: (type?: BookType) => void }) {
  return <label className="field book-type-filter">Book type
    <select className="control" value={value ?? ''} onChange={(event) => onChange(bookTypes.find((type) => type === event.target.value))}>
      <option value="">All book types</option>
      {bookTypes.map((type) => <option key={type} value={type}>{bookTypeLabels[type]}</option>)}
    </select>
  </label>
}
