import { useLocation, useNavigate } from 'react-router'

export interface DetailOrigin {
  url: string
  triggerId: string
  posterId: string
  scrollY: number
}

export function titlePath(id: string) {
  return `/title/${encodeURIComponent(id)}`
}

export function useOpenDetail() {
  const navigate = useNavigate()
  const location = useLocation()

  return (id: string, triggerId: string, posterId = triggerId) => {
    const state: DetailOrigin = {
      url: location.pathname + location.search + location.hash,
      triggerId,
      posterId,
      scrollY: window.scrollY,
    }
    navigate(titlePath(id), { state })
  }
}

export function readDetailOrigin(state: unknown): DetailOrigin | undefined {
  if (!state || typeof state !== 'object') return
  if ('url' in state && typeof state.url === 'string' &&
    'triggerId' in state && typeof state.triggerId === 'string' &&
    'posterId' in state && typeof state.posterId === 'string' &&
    'scrollY' in state && typeof state.scrollY === 'number') {
    return { url: state.url, triggerId: state.triggerId, posterId: state.posterId, scrollY: state.scrollY }
  }
}
