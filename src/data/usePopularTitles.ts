import { useState } from 'react'
import { discoverSections, interleave, uniqueMedia } from '../domain/catalog'
import type { DiscoverSection } from '../domain/catalog'
import { inCategory } from '../domain/media'
import type { Category, Media } from '../domain/media'
import { demoCatalog } from './demo'
import { demoMode, useConnection, usePopularity } from './useCatalog'

interface Feed {
  page: number
  items: Media[]
  sections?: DiscoverSection[]
}

export function usePopularTitles(category: Category) {
  const [attempt, setAttempt] = useState(0)
  const [feed, setFeed] = useState<Feed>({ page: 1, items: [] })
  const connected = useConnection()
  const sections = feed.sections ?? (category === 'All' ? discoverSections : [category])
  const movies = usePopularity('Movies', attempt, sections.includes('Movies'), feed.page)
  const tv = usePopularity('TV Shows', attempt, sections.includes('TV Shows'), feed.page)
  const anime = usePopularity('Anime', attempt, sections.includes('Anime'), feed.page)
  const games = usePopularity('Games', attempt, sections.includes('Games'), feed.page)
  const shelves = { Movies: movies, 'TV Shows': tv, Anime: anime, Games: games }
  const visible = sections.map((section) => [section, shelves[section]] as const)
  const loading = visible.some(([, shelf]) => shelf.status === 'loading')
  const nextSections: DiscoverSection[] = []
  const pageItems = interleave(visible.map(([section, { data }]) => {
    if (!data || !('items' in data)) return []
    if (data.hasMore) nextSections.push(section)
    return data.items.filter((media) => inCategory(media, section))
  }))
  const items = demoMode
    ? demoCatalog.filter((media) => inCategory(media, category))
    : uniqueMedia([...feed.items, ...(feed.page === 1 || !loading ? pageItems : [])])
  const canLoadMore = !loading && nextSections.length > 0
  const canRetry = connected && visible.some(([, shelf]) => ['partial', 'stale', 'unavailable', 'limited'].includes(shelf.status))

  function loadMore() {
    if (!canLoadMore) return
    setFeed((current) => current.page === feed.page ? { page: feed.page + 1, items, sections: nextSections } : current)
    setAttempt(0)
  }

  return { items, visible, loading, loadingMore: feed.page > 1 && loading, canLoadMore, loadMore, retry: canRetry ? () => setAttempt((value) => value + 1) : undefined }
}
