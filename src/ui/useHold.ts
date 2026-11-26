import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, PointerEvent, TouchEvent } from 'react'
import { duration } from './motion'

const holdDuration = duration.hold * 1000
const holdMovementTolerance = 10

/** Tap runs `onTap`; holding the pointer (or Shift+Enter) runs `onHold` instead. Spread `handlers` onto a button. */
export function useHold({ disabled, onTap, onHold }: {
  disabled: boolean
  onTap: () => void
  onHold: (trigger: HTMLButtonElement) => void
}) {
  const press = useRef<{ id: number; x: number; y: number; timer: number } | undefined>(undefined)
  const suppressClick = useRef(false)
  const [holding, setHolding] = useState(false)

  const cancelHold = useEffectEvent(interrupt)
  useEffect(() => {
    window.addEventListener('blur', cancelHold)
    document.addEventListener('visibilitychange', cancelHold)
    return () => {
      window.removeEventListener('blur', cancelHold)
      document.removeEventListener('visibilitychange', cancelHold)
      window.clearTimeout(press.current?.timer)
    }
  }, [])

  function interrupt() {
    if (!press.current) return
    suppressClick.current = true
    stopPress()
  }

  function stopPress() {
    window.clearTimeout(press.current?.timer)
    press.current = undefined
    setHolding(false)
  }

  const handlers = {
    'aria-keyshortcuts': 'Shift+Enter',
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      if (disabled || !event.isPrimary || event.button !== 0) return
      const trigger = event.currentTarget
      stopPress()
      suppressClick.current = false
      setHolding(true)
      trigger.setPointerCapture(event.pointerId)
      const timer = window.setTimeout(() => {
        suppressClick.current = true
        stopPress()
        onHold(trigger)
      }, holdDuration)
      press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, timer }
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      const start = press.current
      if (start?.id !== event.pointerId) return
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > holdMovementTolerance) interrupt()
    },
    onPointerUp(event: PointerEvent<HTMLButtonElement>) { if (press.current?.id === event.pointerId) stopPress() },
    // After a hold the sheet rises under the finger; cancel the tap the browser would fire on lift-off.
    onTouchEnd(event: TouchEvent<HTMLButtonElement>) { if (suppressClick.current) event.preventDefault() },
    onPointerCancel(event: PointerEvent<HTMLButtonElement>) { if (press.current?.id === event.pointerId) interrupt() },
    onLostPointerCapture(event: PointerEvent<HTMLButtonElement>) { if (press.current?.id === event.pointerId) interrupt() },
    onBlur: interrupt,
    onContextMenu(event: MouseEvent<HTMLButtonElement>) { event.preventDefault() },
    onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
      if (event.key === 'Escape') interrupt()
      if (event.key !== 'Enter' || !event.shiftKey) return
      event.preventDefault()
      if (!disabled && !event.repeat) onHold(event.currentTarget)
    },
    onClick(event: MouseEvent<HTMLButtonElement>) {
      if (event.detail > 0 && suppressClick.current) return
      if (!disabled) onTap()
    },
  }

  return { holding, handlers }
}
