import { useState } from 'react'
import { releaseYearRange, uniqueMedia } from '../domain/catalog'
import type { BrowseQuery, DiscoverSection } from '../domain/catalog'
import { inCategory } from '../domain/media'
import type { Media } from '../domain/media'
import { demoCatalog } from './demo'
import { demoMode, useBrowsePage, useConnection } from './useCatalog'

interface Feed {
  page: number
  items: Media[]
}

export function useBrowseTitles(category: DiscoverSection, query: BrowseQuery, enabled = true) {
  const [attempt, setAttempt] = useState(0)
  const [feed, setFeed] = useState<Feed>({ page: 1, items: [] })
  const connected = useConnection()
  const resource = useBrowsePage(category, query, feed.page, attempt, enabled)
  const { data, status } = resource
  const page = data && 'items' in data ? data : undefined
  const loading = status === 'loading'
  const pageItems = page?.items.filter((media) => inCategory(media, category)) ?? []
  const items = demoMode
    ? demoBrowse(category, query)
    : uniqueMedia([...feed.items, ...(feed.page === 1 || !loading ? pageItems : [])])
  const canLoadMore = !loading && page?.hasMore === true
  const canRetry = connected && ['partial', 'stale', 'unavailable', 'limited'].includes(status)

  function loadMore() {
    if (!canLoadMore) return
    setFeed((current) => current.page === feed.page ? { page: feed.page + 1, items } : current)
    setAttempt(0)
  }

  return { category, items, resource, loading, loadingMore: feed.page > 1 && loading, canLoadMore, loadMore, retry: canRetry ? () => setAttempt((value) => value + 1) : undefined }
}

function demoBrowse(category: DiscoverSection, query: BrowseQuery) {
  const items = demoCatalog.filter((media) => inCategory(media, category) && (!query.bookType || (media.format === 'BOOK' && media.bookType === query.bookType)))
  if (query.mode === 'release') {
    const { first, last } = releaseYearRange(query.period)
    return items.filter((media) => media.year !== undefined && media.year >= first && media.year <= last)
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
  }
  return query.mode === 'anticipated' ? items.filter(({ year }) => year !== undefined && year > new Date().getUTCFullYear()) : items
}
