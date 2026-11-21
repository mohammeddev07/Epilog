import { animate, motion, useMotionTemplate, useMotionValue, useTransform } from 'motion/react'
import type { MotionValue } from 'motion/react'
import { useLayoutEffect, useRef } from 'react'
import type { PointerEvent } from 'react'
import { mediaKey } from '../domain/catalog'
import type { Media } from '../domain/media'
import { Poster } from './MediaCards'
import { carouselSpring, useMotionEnabled } from './motion'

const swipeDistance = 45
const slideWidth = 100

export function popularPosterId(title: Media) {
  return 'popular-poster-' + mediaKey(title)
}

interface Gesture {
  id: number
  x: number
  y: number
  width: number
  offset: number
  slot: number // cover the press started on: 0 current, ±1 neighbours
}

// Depth deck, scrubbed by the track offset: p is a cover's distance from centre in slides (0 centre, ±1 neighbours).
const depth = (p: number) => Math.min(1, Math.abs(p))

function Cover({ media, position, offset, slot }: { media: Media; position: number; offset: MotionValue<number>; slot: number }) {
  const p = useTransform(offset, (value) => (value + position * slideWidth) / slideWidth)
  const scale = useTransform(p, (value) => 1 - 0.14 * depth(value))
  const rotateY = useTransform(p, (value) => Math.max(-1, Math.min(1, value)) * -22)
  const zIndex = useTransform(p, (value) => 10 - Math.round(depth(value) * 10))
  const shade = useTransform(p, (value) => depth(value) * 0.5)
  const glow = useTransform(p, (value) => 0.6 * (1 - depth(value)))
  const parallax = useTransform(p, (value) => `${Math.max(-1, Math.min(1, value)) * -7}%`)

  return (
    <motion.div
      className="popular-cover" data-slot={slot}
      style={{ left: position * slideWidth + '%', scale, rotateY, zIndex, transformPerspective: 1100, '--parallax': parallax } as never}
    >
      {media.poster ? <motion.img className="popular-glow" src={media.poster} alt="" style={{ opacity: glow }} draggable={false} referrerPolicy="no-referrer" /> : null}
      <Poster media={media} sharedId={popularPosterId(media)} eager />
      <motion.span className="popular-shade" style={{ opacity: shade }} />
    </motion.div>
  )
}

export function SwipePosters({ items, index, onStep }: {
  items: readonly Media[]
  index: number
  onStep: (direction: -1 | 1) => boolean
}) {
  const motionEnabled = useMotionEnabled()
  const offset = useMotionValue(-index * slideWidth)
  const transform = useMotionTemplate`${offset}%`
  const previousIndex = useRef(index)
  const gesture = useRef<Gesture | undefined>(undefined)
  const first = Math.max(0, index - 1)

  useLayoutEffect(() => {
    const distance = Math.abs(index - previousIndex.current)
    previousIndex.current = index
    const target = -index * slideWidth
    if (!motionEnabled || distance !== 1) {
      offset.jump(target)
      return
    }
    const playback = animate(offset, target, carouselSpring)
    return () => playback.stop()
  }, [index, motionEnabled, offset])

  function start(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0) return
    offset.stop()
    gesture.current = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      width: event.currentTarget.clientWidth, offset: offset.get(),
      slot: Number((event.target as Element).closest('[data-slot]')?.getAttribute('data-slot') ?? 0),
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function drag(event: PointerEvent<HTMLDivElement>) {
    const start = gesture.current
    if (!motionEnabled || !start || start.id !== event.pointerId || !start.width) return
    const dx = event.clientX - start.x
    if (Math.abs(dx) <= Math.abs(event.clientY - start.y)) return
    const percent = Math.min(slideWidth, Math.max(-slideWidth, dx * slideWidth / start.width))
    const atEdge = (dx > 0 && index === 0) || (dx < 0 && index === items.length - 1)
    offset.set(start.offset + percent * (atEdge ? 0.16 : 1))
  }

  function settle() {
    const target = -index * slideWidth
    if (motionEnabled) void animate(offset, target, carouselSpring)
    else offset.jump(target)
  }

  function end(event: PointerEvent<HTMLDivElement>) {
    const start = gesture.current
    if (!start || start.id !== event.pointerId) return
    gesture.current = undefined
    const dx = event.clientX - start.x
    const sideways = Math.abs(dx) >= swipeDistance && Math.abs(dx) > Math.abs(event.clientY - start.y)
    if (sideways && onStep(dx > 0 ? -1 : 1)) return
    // A tap on a peeking neighbour steps to it.
    if (Math.abs(dx) < 6 && start.slot && onStep(start.slot > 0 ? 1 : -1)) return
    settle()
  }

  return (
    <div
      className="popular-stage" role="group" tabIndex={0} aria-label="Poster. Swipe or use the left and right arrow keys to browse."
      onPointerDown={start} onPointerMove={drag} onPointerUp={end}
      onPointerCancel={() => { gesture.current = undefined; settle() }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        onStep(event.key === 'ArrowLeft' ? -1 : 1)
      }}
    >
      <motion.div className="popular-track" style={{ x: transform }} aria-hidden="true">
        {items.slice(first, index + 2).map((media, slot) => (
          <Cover key={mediaKey(media)} media={media} position={first + slot} offset={offset} slot={first + slot - index} />
        ))}
      </motion.div>
    </div>
  )
}
