import { useEffect, useState } from 'react'
import type { LibraryEntry } from '../domain/media'
import { library } from './library'

type LibraryState =
  | { status: 'loading' }
  | { status: 'ready'; entries: ReadonlyMap<string, LibraryEntry> }
  | { status: 'error' }

export function useLibrary(refresh: number) {
  const [state, setState] = useState<LibraryState>({ status: 'loading' })
  useEffect(() => {
    let active = true
    const subscription = library.watch().subscribe({
      next: (entries) => setState({ status: 'ready', entries }),
      error: () => setState({ status: 'error' }),
    })
    function purgeExpired() {
      void library.purgeExpired().catch(() => {
        if (active) setState({ status: 'error' })
      })
    }
    purgeExpired()
    window.addEventListener('focus', purgeExpired)
    const timer = window.setInterval(purgeExpired, 60_000)
    return () => {
      active = false
      subscription.unsubscribe()
      window.removeEventListener('focus', purgeExpired)
      window.clearInterval(timer)
    }
  }, [refresh])
  return state
}
