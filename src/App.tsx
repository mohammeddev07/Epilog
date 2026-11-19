import { BooksIcon, HouseIcon, MagnifyingGlassIcon, GearSixIcon } from '@phosphor-icons/react'
import { AnimatePresence, LayoutGroup, motion, MotionConfig } from 'motion/react'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, matchPath, NavLink, useLocation, useNavigate } from 'react-router'
import { demoById } from './data/demo'
import { mediaKey } from './domain/catalog'
import { parseCatalogKey } from './domain/identity'
import { peekPreview } from './data/catalog-client'
import { useCatalogDetail, useConnection, demoMode } from './data/useCatalog'
import { statuses } from './domain/media'
import { library } from './data/library'
import { useLibrary } from './data/useLibrary'
import type { Episode, LibraryEntry, LogDraft, Media } from './domain/media'
import { Dashboard } from './screens/Dashboard'
import { Details } from './screens/Details'
import { Library } from './screens/Library'
import { Search } from './screens/Search'
import { appearanceKey, Settings, themes } from './screens/Settings'
import type { Theme } from './screens/Settings'
import { readDetailOrigin } from './ui/detail-navigation'
import type { DetailOrigin } from './ui/detail-navigation'
import { CatalogFeedback, catalogMessage, CatalogSkeleton, offlineCacheError } from './ui/CatalogFeedback'
import { LogDialog } from './ui/LogDialog'
import type { LogSession } from './ui/LogDialog'
import { crossfade, motionProperties, rise, useMotionEnabled } from './ui/motion'

const InstallStatus = lazy(() => import('./ui/InstallStatus'))

const LogoMark = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="6 6 20 20" aria-hidden="true">
    <path d="M22.5 9.5H10.5v13h6M10.5 16h8" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="22" cy="22.5" r="2" fill="currentColor" />
  </svg>
)

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(appearanceKey)
    return themes.find((theme) => theme === saved) ?? 'system'
  } catch {
    return 'system'
  }
}

const navigation = [
  { to: '/', label: 'Dashboard', Icon: HouseIcon, mobile: true },
  { to: '/library', label: 'Library', Icon: BooksIcon, mobile: true },
  { to: '/search', label: 'Search', Icon: MagnifyingGlassIcon, mobile: false },
  { to: '/settings', label: 'Settings', Icon: GearSixIcon, mobile: false },
] as const

const noEntries = new Map<string, LibraryEntry>()

export function App() {
  const [refresh, setRefresh] = useState(0)
  const state = useLibrary(refresh)
  const entries = state.status === 'ready' ? state.entries : noEntries
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [storageError, setStorageError] = useState(false)
  const [session, setSession] = useState<LogSession | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const [announcement, setAnnouncement] = useState({ message: '', id: 0 })
  const [dismissedAnnouncement, setDismissedAnnouncement] = useState(0)
  const [highlightId, setHighlightId] = useState<string>()
  const location = useLocation()
  const navigate = useNavigate()
  const animate = useMotionEnabled()
  const main = useRef<HTMLElement>(null)
  const previous = useRef<{ key: string; origin?: DetailOrigin }>(undefined)
  const [retryDetail, setRetryDetail] = useState(0)
  const connected = useConnection()
  const rawId = matchPath('/title/:id', location.pathname)?.params.id
  const detailId = rawId ? decodeId(rawId) : undefined
  const selectedEntry = detailId ? entries.get(detailId) ?? [...entries.values()].find((entry) => mediaKey(entry.media) === detailId) : undefined
  const identity = selectedEntry?.media.identity ?? (detailId ? parseCatalogKey(detailId) : undefined)
  const remote = useCatalogDetail(identity, retryDetail)
  const detail = selectedEntry
    ? { ...(remote.item ?? selectedEntry.media), id: selectedEntry.media.id }
    : detailId ? remote.item ?? peekPreview(detailId) ?? (demoMode ? demoById.get(detailId) : undefined) : undefined
  const detailPending = Boolean(identity && !detail && remote.status === 'loading')
  const detailMessages = [
    identity ? catalogMessage(identity.provider === 'igdb' ? 'IGDB' : 'TMDB', remote.status, remote.retryAfter) : '',
    remote.cacheError ? offlineCacheError : '',
  ].filter(Boolean)
  const origin = detailId ? readDetailOrigin(location.state) : undefined
  const browse = origin?.url ?? (detailId ? '' : location.pathname + location.search)
  const [path, query] = browse.split('?')
  const rawStatus = new URLSearchParams(query).get('status')
  const defaultStatus = statuses.find((status) => status === rawStatus) ?? null

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useLayoutEffect(() => {
    const originalRestoration = history.scrollRestoration
    history.scrollRestoration = 'manual'
    return () => { history.scrollRestoration = originalRestoration }
  }, [])

  useLayoutEffect(() => {
    if (state.status === 'loading' || detailPending) return
    const last = previous.current
    if (last?.key === location.key) return
    previous.current = { key: location.key, origin }
    if (!last && !detailId) return

    if (!detailId && last?.origin?.url === location.pathname + location.search) {
      window.scrollTo(0, last.origin.scrollY)
      const trigger = document.getElementById(last.origin.triggerId)
      if (trigger) {
        trigger.focus({ preventScroll: true })
        return
      }
    } else {
      window.scrollTo(0, 0)
    }

    const focus = path === '/search' && !detailId
      ? document.getElementById('catalog-search')
      : main.current?.querySelector<HTMLElement>('.page:not([hidden]) h1')
    focus?.focus({ preventScroll: true })
  }, [detailId, location.key, location.pathname, location.search, origin, path, state.status, detailPending])

  function changeTheme(value: Theme) {
    setTheme(value)
    try {
      localStorage.setItem(appearanceKey, value)
      setStorageError(false)
    } catch {
      setStorageError(true)
    }
  }

  useEffect(() => {
    if (!announcement.id) return
    const timer = window.setTimeout(() => setDismissedAnnouncement(announcement.id), 4000)
    return () => window.clearTimeout(timer)
  }, [announcement.id])

  function announce(message: string) {
    setAnnouncement((previous) => ({ message, id: previous.id + 1 }))
  }

  const editing = session ? entries.get(session.media.id) ?? [...entries.values()].find((entry) => mediaKey(entry.media) === mediaKey(session.media)) : undefined

  function openLog(media: Media, trigger: HTMLElement) {
    setSession((previous) => ({ key: (previous?.key ?? 0) + 1, media, trigger }))
    setLogOpen(true)
  }

  async function save(media: Media, draft: LogDraft) {
    const { id, created } = await library.save(media, draft)
    setHighlightId(id)
    announce(created ? `${media.title} saved to Library.` : `Changes to ${media.title} saved.`)
  }

  async function setEpisode(entry: LibraryEntry, episode: Episode, watched: boolean) {
    await library.setEpisode(entry.media.id, episode, watched)
    announce(watched ? `${episode.title} marked watched.` : `${episode.title} marked unwatched.`)
  }

  async function remove(media: Media) {
    await library.remove(media.id)
    await navigate('/library', { replace: true })
    announce(`${media.title} removed from Library.`)
  }

  function retryStorage() {
    setRefresh((value) => value + 1)
  }

  const linkProps = ({ isActive }: { isActive: boolean }) => isActive ? 'nav-link active' : 'nav-link'

  return (
    <MotionConfig reducedMotion={animate ? 'never' : 'always'}>
      <div className="app-shell" style={motionProperties} data-motion={animate ? 'full' : 'reduced'}>
        <a href="#main-content" className="skip-link">Skip to content</a>
        <aside className="sidebar">
          <Link to="/" className="wordmark"><span className="brand-mark"><LogoMark size={20} /></span> Epilog</Link>
          <nav aria-label="Primary">
            {navigation.map(({ to, label, Icon }) => (
              <NavLink key={to} to={to} end className={linkProps}><Icon size={21} /> {label}</NavLink>
            ))}
          </nav>
        </aside>
        <header className="mobile-header">
          <Link to="/" className="wordmark"><span className="brand-mark"><LogoMark size={19} /></span> Epilog</Link>
          <div>
            <NavLink to="/search" className="icon-button" aria-label="Search"><MagnifyingGlassIcon size={22} /></NavLink>
            <NavLink to="/settings" className="icon-button" aria-label="Settings"><GearSixIcon size={22} /></NavLink>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1} ref={main}>
          <LayoutGroup>
            {state.status === 'loading' ? <LibraryLoading /> : null}
            {state.status === 'error' ? (
              <motion.div className="empty-state" variants={rise} initial={animate ? 'hidden' : false} animate="visible">
                <h1 tabIndex={-1}>Library unavailable</h1>
                <p role="alert">Epilog could not open this browser’s local storage. Check that browser storage is enabled and try again.</p>
                <button type="button" className="button button-secondary" onClick={retryStorage}>Try again</button>
              </motion.div>
            ) : null}
            {path && state.status === 'ready' ? (
              <motion.div
                className="page"
                key={browse}
                hidden={Boolean(detailId)}
                variants={crossfade}
                initial={animate ? 'hidden' : false}
                animate="visible"
              >
                {path === '/' ? <Dashboard entries={entries} onLog={openLog} />
                  : path === '/library' ? <Library entries={entries} defaultStatus={defaultStatus} highlightId={highlightId} />
                  : path === '/search' ? <Search entries={entries} onLog={openLog} />
                  : path === '/settings' ? <Settings theme={theme} onTheme={changeTheme} storageError={storageError} onRestore={(count) => announce(count ? 'Backup restored.' : 'Backup reviewed. Your library is already up to date.')} />
                  : <MissingPage />}
              </motion.div>
            ) : null}
            {detailId && state.status === 'ready' ? (
              <motion.div key={detailId} className="page" variants={crossfade} initial={animate ? 'hidden' : false} animate="visible">
                {detailPending ? <><h1 tabIndex={-1}>Loading title</h1><CatalogSkeleton /></> : detail ? (
                  <Details
                    media={detail}
                    entry={selectedEntry ? { ...selectedEntry, media: detail } : undefined}
                    back={origin ? () => { void navigate(-1) } : undefined}
                    triggerId={origin?.posterId}
                    onLog={openLog}
                    onEpisode={setEpisode}
                    onRemove={remove}
                  />
                ) : <MissingPage title={identity && remote.status !== 'missing' ? 'Title temporarily unavailable' : 'Title not found'} />}
                {detailMessages.length && !detailPending ? (
                  <CatalogFeedback messages={detailMessages} retry={connected ? () => setRetryDetail((value) => value + 1) : undefined} loading={remote.status === 'loading'} />
                ) : null}
              </motion.div>
            ) : null}
          </LayoutGroup>
        </main>
        <nav className="mobile-nav" aria-label="Primary">
          {navigation.filter(({ mobile }) => mobile).map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} end className={linkProps}><Icon size={22} /> {label}</NavLink>
          ))}
        </nav>
        {import.meta.env.PROD ? <Suspense fallback={null}><InstallStatus /></Suspense> : null}
        <LogDialog
          session={session}
          open={logOpen}
          entry={editing}
          onClose={() => setLogOpen(false)}
          onSave={save}
        />
        <div className="sr-only" role="status" aria-atomic="true">
          <span key={announcement.id}>{announcement.message}</span>
        </div>
        <div className="save-announcement" aria-hidden="true">
          <AnimatePresence>
            {announcement.id > dismissedAnnouncement ? (
              <motion.span key={announcement.id} variants={rise} initial={animate ? 'hidden' : false} animate="visible" exit={animate ? 'exit' : undefined}>
                {announcement.message}
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </MotionConfig>
  )
}

function MissingPage({ title = 'Page not found' }: { title?: string }) {
  return (
    <div className="empty-state">
      <h1 tabIndex={-1}>{title}</h1>
      <p>Try searching for a title or return to your dashboard.</p>
      <Link to="/" className="button button-secondary">Go to Dashboard</Link>
    </div>
  )
}

function LibraryLoading() {
  return (
    <div role="status" className="loading-library">
      <span>Opening your library…</span>
      <div className="loading-tiles" aria-hidden="true"><span /><span /><span /></div>
    </div>
  )
}

function decodeId(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
