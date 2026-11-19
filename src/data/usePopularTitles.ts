import { useState } from 'react'
import { demoCatalog } from './demo'
import { demoMode, useConnection, usePopularity } from './useCatalog'
import { interleave, uniqueMedia } from '../domain/catalog'
import { inCategory } from '../domain/media'
import type { Category } from '../domain/media'

export function usePopularTitles(category: Category) {
  const [attempt, setAttempt] = useState(0)
  const connected = useConnection()
  const movies = usePopularity('Movies', attempt, category === 'All' || category === 'Movies')
  const tv = usePopularity('TV Shows', attempt, category === 'All' || category === 'TV Shows')
  const anime = usePopularity('Anime', attempt, category === 'All' || category === 'Anime')
  const games = usePopularity('Games', attempt, category === 'All' || category === 'Games')
  const shelves = { Movies: movies, 'TV Shows': tv, Anime: anime, Games: games }
  const visible = category === 'All' ? Object.entries(shelves) : [[category, shelves[category]]] as const
  const items = demoMode
    ? demoCatalog.filter((media) => inCategory(media, category))
    : uniqueMedia(interleave(visible.map(([, shelf]) => shelf.data && 'items' in shelf.data ? shelf.data.items : [])))
  const loading = visible.some(([, shelf]) => shelf.status === 'loading')
  const canRetry = connected && visible.some(([, shelf]) => ['partial', 'stale', 'unavailable', 'limited'].includes(shelf.status))
  return { items, visible, loading, retry: canRetry ? () => setAttempt((value) => value + 1) : undefined }
}
