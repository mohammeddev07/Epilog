import { MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react'
import { useRef } from 'react'
import { iconSize } from './tokens'

interface Props {
  id?: string
  className?: string
  label: string
  placeholder: string
  value: string
  maxLength?: number
  onChange: (value: string) => void
}

export function SearchField({ id, className, label, placeholder, value, maxLength, onChange }: Props) {
  const input = useRef<HTMLInputElement>(null)

  return (
    <div className={className ? `search-field ${className}` : 'search-field'}>
      <MagnifyingGlassIcon size={iconSize.md} aria-hidden="true" />
      <input
        ref={input} id={id} type="search" aria-label={label} placeholder={placeholder}
        value={value} maxLength={maxLength} onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button type="button" className="icon-button search-clear" aria-label="Clear search" onClick={() => {
          onChange('')
          input.current?.focus({ preventScroll: true })
        }}>
          <XIcon size={iconSize.sm} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}
