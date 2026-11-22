import { motion } from 'motion/react'
import { Component } from 'react'
import type { ReactNode } from 'react'
import type { DetailOrigin } from './detail-navigation'
import { posterSpring } from './motion'

interface Props {
  url: string
  origin?: DetailOrigin
  enabled: boolean
  children: ReactNode
}

interface Snapshot {
  id: string
  src: string
  from: DOMRect
}

interface Flight extends Snapshot {
  url: string
  to: DOMRect
  target: HTMLElement
}

// Measure the outgoing page before React hides it. Measure the destination after
// its scroll restoration. A viewport layer can travel outside a clipped shelf.
function visiblePoster(id: string) {
  const poster = document.querySelector<HTMLElement>(`.page:not([hidden]) [data-poster-id="${CSS.escape(id)}"]`)
  if (!poster) return
  const rect = poster.getBoundingClientRect()
  if (rect.width && rect.height && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth) return poster
}

export class PosterTransition extends Component<Props, { flight?: Flight }> {
  state: { flight?: Flight } = {}
  private overlay: HTMLImageElement | null = null

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const { enabled, url, origin } = this.props
    if (!enabled || previous.url === url) return null
    const id = origin?.url === previous.url ? origin.posterId : previous.origin?.url === url ? previous.origin.posterId : undefined
    if (!id) return null
    const poster = visiblePoster(id)
    const image = poster?.querySelector('img')
    const source = this.overlay ?? image
    if (!poster || !source?.complete || !source.naturalWidth) return null
    return { id, src: source.currentSrc, from: (this.overlay ?? poster).getBoundingClientRect() }
  }

  componentDidUpdate(previous: Props, _: unknown, snapshot: Snapshot | null) {
    if (previous.url === this.props.url && previous.enabled === this.props.enabled) return
    this.release()
    if (snapshot && this.props.enabled) {
      const target = visiblePoster(snapshot.id)
      if (target) {
        const to = target.getBoundingClientRect()
        target.dataset.landing = ''
        this.setState({ flight: { ...snapshot, to, target, url: this.props.url } })
        window.addEventListener('scroll', this.onScroll, true)
        window.addEventListener('resize', this.finish)
        return
      }
    }
    if (this.state.flight) this.setState({ flight: undefined })
  }

  componentWillUnmount() { this.release() }

  private release() {
    if (this.state.flight) delete this.state.flight.target.dataset.landing
    window.removeEventListener('scroll', this.onScroll, true)
    window.removeEventListener('resize', this.finish)
  }

  private onScroll = () => {
    const flight = this.state.flight
    if (!flight) return
    const rect = flight.target.getBoundingClientRect()
    if (Math.abs(rect.top - flight.to.top) > 1 || Math.abs(rect.left - flight.to.left) > 1) this.finish()
  }

  private finish = () => {
    this.release()
    this.setState({ flight: undefined })
  }

  render() {
    const { flight } = this.state
    return <>
      {this.props.children}
      {flight && <motion.img key={flight.url} ref={(node) => { this.overlay = node }}
        src={flight.src} referrerPolicy="no-referrer" alt="" aria-hidden="true" className="poster-flight"
        style={{ left: flight.to.left, top: flight.to.top, width: flight.to.width, height: flight.to.height }}
        initial={{ x: flight.from.left - flight.to.left, y: flight.from.top - flight.to.top,
          scaleX: flight.from.width / flight.to.width, scaleY: flight.from.height / flight.to.height }}
        animate={{ x: 0, y: 0, scaleX: 1, scaleY: 1 }} transition={posterSpring}
        onAnimationComplete={() => { if (this.state.flight === flight) this.finish() }}
      />}
    </>
  }
}
