import { motion } from 'motion/react'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { SignIn } from '../ui/GoogleButton'
import { rise, useMotionEnabled } from '../ui/motion'

export function Welcome({ logo, onGuest, onSignedIn }: { logo: ReactNode; onGuest: () => void; onSignedIn: () => void }) {
  const animate = useMotionEnabled()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])
  const item = (index: number) => ({ variants: rise, custom: index, initial: animate ? 'hidden' : false, animate: 'visible' })

  return (
    <main className="welcome">
      <motion.p className="wordmark" {...item(0)}>{logo} Epilog</motion.p>
      <motion.h1 ref={heading} tabIndex={-1} {...item(1)}>Every story you love, in one place.</motion.h1>
      <motion.div className="welcome-actions" {...item(2)}>
        <SignIn onSignedIn={onSignedIn} />
        <button type="button" className="button button-secondary" onClick={onGuest}>Continue as guest</button>
      </motion.div>
      <motion.p className="muted" {...item(3)}>Guests keep their library on this device only.</motion.p>
      <motion.p {...item(4)}><Link to="/privacy" className="text-link">Privacy policy</Link></motion.p>
    </main>
  )
}
