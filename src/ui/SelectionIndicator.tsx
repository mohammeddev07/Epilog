import { motion } from 'motion/react'
import { duration, easeOut, useMotionEnabled } from './motion'

export function SelectionIndicator({ id, className = 'selection-indicator' }: { id: string; className?: string }) {
  const animate = useMotionEnabled()
  return <motion.span aria-hidden="true" className={className} layoutId={animate ? id : undefined}
    transition={{ duration: duration.filter, ease: easeOut }} />
}
