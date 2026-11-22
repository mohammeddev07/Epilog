import { bookTypes } from '../domain/books'
import { defaultPopularCategory, defaultReleasePeriod, discoverSections, parseReleasePeriod } from '../domain/catalog'
import type { BrowseQuery, DiscoverSection } from '../domain/catalog'

export function browsePath(category: DiscoverSection, query: BrowseQuery, title?: string) {
  const params = new URLSearchParams({ category })
  if (query.mode !== 'popular') params.set('view', query.mode)
  if (query.mode === 'release') {
    params.set('decade', String(query.period.decade))
    if (query.period.year !== undefined) params.set('year', String(query.period.year))
  }
  if (category === 'Books' && query.bookType) params.set('type', query.bookType)
  if (title) params.set('title', title)
  return '/popular?' + params.toString()
}

export function readPopularLocation(query: string) {
  const params = new URLSearchParams(query)
  const mode = params.get('view')
  const browse: BrowseQuery = mode === 'release'
    ? { mode, period: parseReleasePeriod(params.get('decade'), params.get('year')) ?? defaultReleasePeriod }
    : mode === 'rated' || mode === 'anticipated' ? { mode } : { mode: 'popular' }
  if (params.get('category') === 'Books') {
    return { category: 'Books' as const, title: params.get('title'), browse: { ...browse, bookType: bookTypes.find((type) => type === params.get('type')) } }
  }
  return {
    category: discoverSections.find((category) => category === params.get('category')) ?? defaultPopularCategory,
    title: params.get('title'),
    browse,
  }
}
