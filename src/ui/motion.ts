import { useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { Transition, Variants } from 'motion/react'

export const duration = { fast: 0.15, filter: 0.18, sheet: 0.24, base: 0.25, slow: 0.4 }
export const easeOut = [0.2, 0.75, 0.25, 1] as const
export const layoutSpring = { type: 'spring', stiffness: 380, damping: 34, mass: 0.85 } satisfies Transition
// Shared poster flight: near-critical (ζ≈0.97) so the art lands without a visible bounce in ~420ms.
export const posterSpring = { type: 'spring', stiffness: 300, damping: 32, mass: 0.9 } satisfies Transition
export const carouselSpring = { type: 'spring', stiffness: 290, damping: 30, mass: 0.85 } satisfies Transition
const stagger = 0.035

export const motionProperties = {
  '--motion-fast': `${duration.fast}s`,
  '--motion-filter': `${duration.filter}s`,
  '--motion-sheet': `${duration.sheet}s`,
  '--motion-base': `${duration.base}s`,
  '--motion-slow': `${duration.slow}s`,
  '--motion-ease': `cubic-bezier(${easeOut.join(', ')})`,
} as CSSProperties

const reducedMotion = '(prefers-reduced-motion: reduce)'

function getPreference() {
  return window.matchMedia(reducedMotion).matches
}

function subscribe(onChange: () => void) {
  const query = window.matchMedia(reducedMotion)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export function useMotionEnabled() {
  return !useSyncExternalStore(subscribe, getPreference, () => false)
}

export const rise = {
  hidden: { opacity: 0, y: 8 },
  visible: (index = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: duration.base, ease: easeOut, delay: Math.min(index, 7) * stagger },
  }),
  exit: { opacity: 0, y: -4, transition: { duration: duration.fast, ease: easeOut } },
} satisfies Variants

export const crossfade = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: duration.filter, ease: easeOut } },
} satisfies Variants
