import { motion } from 'motion/react'
import type { usePopularTitles } from '../data/usePopularTitles'
import { rise, useMotionEnabled } from './motion'

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

export function CatalogFeedback({ messages, retry, loading }: {
  messages: string[]
  retry?: () => void
  loading?: boolean
}) {
  const animate = useMotionEnabled()
  if (!messages.length) return null
  return (
    <motion.div className="catalog-feedback" variants={rise} initial={animate ? 'hidden' : false} animate="visible">
      <div role="status">
        {messages.map((message) => <p key={message}>{message}</p>)}
      </div>
      {retry && !loading ? <button type="button" className="text-action" onClick={retry}>Try again</button> : null}
    </motion.div>
  )
}

export function CatalogSkeleton() {
  return <div className="loading-tiles catalog-tiles" aria-hidden="true"><span /><span /><span /><span /></div>
}

export function PopularFeedback({ visible, loading, retry }: ReturnType<typeof usePopularTitles>) {
  const messages = visible.map(([name, shelf]) => catalogMessage(`${name} catalog`, shelf.status, shelf.retryAfter)).filter(Boolean)
  if (visible.some(([, shelf]) => shelf.cacheError)) messages.push(offlineCacheError)
  return <CatalogFeedback messages={messages} loading={loading} retry={retry} />
}
