import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import type { useBrowseTitles } from '../data/useBrowseTitles'
import { crossfade, useMotionEnabled } from './motion'

type CatalogStatus = 'idle' | 'loading' | 'ready' | 'partial' | 'stale' | 'unavailable' | 'offline' | 'limited' | 'missing'

export function catalogMessage(label: string, status: CatalogStatus, retryAfter?: number) {
  switch (status) {
    case 'loading': return `Checking ${label}…`
    case 'limited': return `${label} is busy. Try again in about ${retryAfter ?? 4} seconds.`
    case 'partial': return `Some ${label} results are temporarily unavailable.`
    case 'stale': return `Showing previously fetched results for ${label}.`
    case 'offline': return `Go online to reach ${label}.`
    case 'unavailable': return `${label} is unavailable. Try again.`
    case 'missing': return `${label} could not find this title.`
    default: return ''
  }
}

export const offlineCacheError = 'This browser could not save some catalog data for offline use.'

export function CatalogFeedback({ messages, retry, loading, ready }: {
  messages: string[]
  retry?: () => void
  loading?: boolean
  ready: boolean
}) {
  const animate = useMotionEnabled()
  const [requested, setRequested] = useState(false)
  const refreshed = requested && ready && !messages.length
  useEffect(() => {
    if (!refreshed) return
    const timer = window.setTimeout(() => setRequested(false), 2400)
    return () => window.clearTimeout(timer)
  }, [refreshed])
  if (!messages.length && !refreshed) return null
  return (
    <motion.div className="catalog-feedback" variants={crossfade} initial={animate ? 'hidden' : false} animate="visible">
      <div role="status">
        {refreshed && <p>Catalog refreshed.</p>}
        {messages.map((message) => <p key={message}>{message}</p>)}
      </div>
      {messages.length > 0 && retry && !loading ? <button type="button" className="text-action" onClick={() => { setRequested(true); retry() }}>Try again</button> : null}
    </motion.div>
  )
}

export function CatalogSkeleton() {
  return <div className="poster-grid catalog-tiles" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <span key={index} className="poster-art" data-loading />)}</div>
}

export function BrowseFeedback({ category, resource, loading, retry }: ReturnType<typeof useBrowseTitles>) {
  const messages = [catalogMessage(`${category} catalog`, resource.status, resource.retryAfter)].filter(Boolean)
  if (resource.cacheError) messages.push(offlineCacheError)
  return <CatalogFeedback key={resource.key} ready={resource.status === 'ready'} messages={messages} loading={loading} retry={retry} />
}
