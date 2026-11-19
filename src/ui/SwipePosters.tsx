import { animate, motion, useMotionTemplate, useMotionValue } from 'motion/react'
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
    if (!sideways || !onStep(dx > 0 ? -1 : 1)) settle()
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
          <div className="popular-cover" key={mediaKey(media)} style={{ left: (first + slot) * slideWidth + '%' }}>
            <Poster media={media} sharedId={popularPosterId(media)} eager />
          </div>
        ))}
      </motion.div>
    </div>
  )
}
