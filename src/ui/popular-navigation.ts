import { categories } from '../domain/media'
import type { Category } from '../domain/media'

export function popularPath(category: Category, title?: string) {
  const params = new URLSearchParams()
  if (category !== 'All') params.set('category', category)
  if (title) params.set('title', title)
  return params.size ? '/popular?' + params.toString() : '/popular'
}

export function readPopularLocation(query: string) {
  const params = new URLSearchParams(query)
  return {
    category: categories.find((category) => category === params.get('category')) ?? 'All',
    title: params.get('title'),
  }
}
