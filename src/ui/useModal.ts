import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

export function useModal(open: boolean, trigger?: HTMLElement | RefObject<HTMLElement | null>, initialFocus = '') {
  const dialog = useRef<HTMLDialogElement>(null)

  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) {
      element.showModal()
      if (initialFocus) element.querySelector<HTMLElement>(initialFocus)?.focus({ preventScroll: true })
    }
    if (!open && element.open) {
      element.close()
      const target = trigger && 'current' in trigger ? trigger.current : trigger
      if (target?.isConnected && !target.closest('[hidden], [inert]')) target.focus({ preventScroll: true })
    }
  }, [open, trigger, initialFocus])

  return dialog
}
