import { XIcon } from '@phosphor-icons/react'
import { iconSize } from './tokens'

// Shared header for <dialog className="sheet"> modals: phone grip, title, and close button.
export function SheetHeader({ id, title, closeLabel, onClose, disabled }: {
  id: string
  title: string
  closeLabel: string
  onClose: () => void
  disabled?: boolean
}) {
  return (
    <>
      <div className="sheet-grip" aria-hidden="true" />
      <div className="sheet-header">
        <h2 id={id}>{title}</h2>
        <button type="button" className="icon-button" aria-label={closeLabel} onClick={onClose} disabled={disabled}>
          <XIcon size={iconSize.lg} aria-hidden="true" />
        </button>
      </div>
    </>
  )
}
