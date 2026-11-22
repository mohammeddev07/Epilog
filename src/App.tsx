import { BooksIcon, HouseIcon, MagnifyingGlassIcon, GearSixIcon } from '@phosphor-icons/react'
import { AnimatePresence, LayoutGroup, motion, MotionConfig } from 'motion/react'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, matchPath, NavLink, useLocation, useNavigate } from 'react-router'
import { demoById } from './data/demo'
import { discoverSections, mediaKey, providerDisplayName } from './domain/catalog'
import { parseCatalogKey } from './domain/identity'
import { peekPreview } from './data/catalog-client'
import { useCatalogDetail, useConnection, demoMode, useSnapshotHydration, warmCatalog } from './data/useCatalog'
import { statuses } from './domain/media'
import { library } from './data/library'
import { useLibrary } from './data/useLibrary'
import { sync } from './data/sync'
import { rememberWelcome, shouldWelcome, useSignInAvailable } from './data/account'
import type { Episode, LibraryEntry, LogDraft, Media, PreferenceChange, Status } from './domain/media'
import { Compare } from './screens/Compare'
import { Dashboard } from './screens/Dashboard'
import { Details } from './screens/Details'
import { Library } from './screens/Library'
import { Popular } from './screens/Popular'
import { Privacy } from './screens/Privacy'
import { Search } from './screens/Search'
import { appearanceKey, Settings, themes } from './screens/Settings'
import type { Theme } from './screens/Settings'
import { Welcome } from './screens/Welcome'
import { readDetailOrigin } from './ui/detail-navigation'
import type { DetailOrigin } from './ui/detail-navigation'
import { CatalogFeedback, catalogMessage, CatalogSkeleton, offlineCacheError } from './ui/CatalogFeedback'
import { LogDialog } from './ui/LogDialog'
import type { LogSession } from './ui/LogDialog'
import { crossfade, duration, rise, useMotionEnabled } from './ui/motion'
import { PosterTransition } from './ui/PosterTransition'
import { SelectionIndicator } from './ui/SelectionIndicator'
import { iconSize } from './ui/tokens'

const InstallStatus = lazy(() => import('./ui/InstallStatus'))

// Owl mark (docs/brand/symbol-logos.html #03). Eyes, beak and smile are cut-outs, so it works on any background.
const owlPath = 'M13 21L16.6 8.6Q17.3 6.6 18.9 8L27 15.5Q32 14 37 15.5L45.1 8Q46.7 6.6 47.4 8.6L51 21V39Q51 57 32 57Q13 57 13 39ZM15.2 28a8.3 8.3 0 1 0 16.6 0a8.3 8.3 0 1 0-16.6 0ZM32.2 28a8.3 8.3 0 1 0 16.6 0a8.3 8.3 0 1 0-16.6 0ZM29.2 35.4Q32 34.2 34.8 35.4L32.7 40.3Q32 41.4 31.3 40.3ZM19.4 43.6Q20.6 43 21.2 43.9Q25 49.4 32 49.7Q39 49.4 42.8 43.9Q43.4 43 44.6 43.6Q45.2 44.4 44.6 45.2Q40 51.9 32 52.2Q24 51.9 19.4 45.2Q18.8 44.4 19.4 43.6Z'
// Pupils are drawn separately so the owl can blink.
const owlPupils = 'M20.6 26.5a3.9 3.9 0 1 0 7.8 0a3.9 3.9 0 1 0-7.8 0ZM37.6 26.5a3.9 3.9 0 1 0 7.8 0a3.9 3.9 0 1 0-7.8 0Z'
const LogoMark = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="7 4 50 55" aria-hidden="true">
    <path d={owlPath} fill="currentColor" fillRule="evenodd" />
    <path className="logo-pupils" d={owlPupils} fill="currentColor" />
  </svg>
)

// Once there's a library worth keeping, ask the browser not to clear it under storage pressure.
let persistenceRequested = false
function keepLibrary() {
  if (persistenceRequested) return
  persistenceRequested = true
  void navigator.storage?.persist?.().catch(() => undefined)
}

function readTheme(): Theme {
  return themes.find((theme) => theme === document.documentElement.dataset.theme) ?? 'system'
}

const navigation = [
  { to: '/', label: 'Dashboard', Icon: HouseIcon, mobile: true },
  { to: '/library', label: 'Library', Icon: BooksIcon, mobile: true },
  { to: '/search', label: 'Search', Icon: MagnifyingGlassIcon, mobile: false },
  { to: '/settings', label: 'Settings', Icon: GearSixIcon, mobile: false },
] as const

const noEntries = new Map<string, LibraryEntry>()

export function App() {
  const location = useLocation()
  return <PosterTransition url={location.pathname + location.search + location.hash}
    origin={matchPath('/title/:id', location.pathname) ? readDetailOrigin(location.state) : undefined} enabled={useMotionEnabled()}>
    <Application />
  </PosterTransition>
}

function Application() {
  const [refresh, setRefresh] = useState(0)
  const state = useLibrary(refresh)
  const entries = state.status === 'ready' ? state.entries : noEntries
  useSnapshotHydration(entries)
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
  // The welcome screen only greets a visit that opened on the Dashboard; a shared link skips it for the whole visit.
  const [openedOn] = useState(location.pathname)
  const [welcomed, setWelcomed] = useState(false)
  const signInAvailable = useSignInAvailable()
  const welcoming = !welcomed && state.status === 'ready' && location.pathname === '/' && shouldWelcome(openedOn, entries.size, signInAvailable !== false)
  const welcomePending = welcoming && signInAvailable === undefined
  const welcome = welcoming && signInAvailable === true
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
    ? selectedEntry.media.format === 'BOOK' && remote.item?.format === 'BOOK'
      ? { ...selectedEntry.media, description: remote.item.description || selectedEntry.media.description,
        poster: remote.item.poster ?? selectedEntry.media.poster }
      : { ...(remote.item ?? selectedEntry.media), id: selectedEntry.media.id }
    : detailId ? remote.item ?? peekPreview(detailId) ?? (demoMode ? demoById.get(detailId) : undefined) : undefined
  const detailPending = Boolean(identity && !detail && remote.status === 'loading')
  const detailMessages = [
    identity ? catalogMessage(providerDisplayName(identity.provider), remote.status, remote.retryAfter) : '',
    remote.cacheError ? offlineCacheError : '',
  ].filter(Boolean)
  const origin = detailId ? readDetailOrigin(location.state) : undefined
  const browse = origin?.url ?? (detailId ? '' : location.pathname + location.search + location.hash)
  const [browseUrl, hash] = browse.split('#')
  const [path, query] = browseUrl.split('?')
  const browseParams = new URLSearchParams(query)
  const rawStatus = browseParams.get('status')
  const defaultStatus = rawStatus === 'Watchlist' ? rawStatus : statuses.find((status) => status === rawStatus) ?? null
  const defaultCategory = discoverSections.find((section) => section === browseParams.get('category'))

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
    if (last) setLogOpen(false)

    if (!detailId && last?.origin?.url === location.pathname + location.search + location.hash) {
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
  }, [detailId, location.key, location.pathname, location.search, location.hash, origin, path, state.status, detailPending])

  function changeTheme(value: Theme) {
    setTheme(value)
    try {
      localStorage.setItem(appearanceKey, value)
      setStorageError(false)
    } catch {
      setStorageError(true)
    }
  }

  useEffect(() => sync.start(), [])

  const showedWelcome = useRef(false)
  useLayoutEffect(() => {
    if (welcome) showedWelcome.current = true
    else if (showedWelcome.current) {
      showedWelcome.current = false
      main.current?.querySelector<HTMLElement>('.page:not([hidden]) h1')?.focus({ preventScroll: true })
    }
  }, [welcome])

  function finishWelcome(choice: 'guest' | 'google') {
    rememberWelcome(choice)
    setWelcomed(true)
  }

  useEffect(() => {
    // Let the visible screen load first, then refresh the shelves people open next.
    const controller = new AbortController()
    const timer = window.setTimeout(() => void warmCatalog(controller.signal), 1500)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [])

  useEffect(() => {
    if (!announcement.id) return
    const timer = window.setTimeout(() => setDismissedAnnouncement(announcement.id), 4000)
    return () => window.clearTimeout(timer)
  }, [announcement.id])

  useEffect(() => {
    if (!highlightId) return
    const timer = window.setTimeout(() => setHighlightId(undefined), duration.slow * 1000)
    return () => window.clearTimeout(timer)
  }, [highlightId, announcement.id])

  function announce(message: string) {
    setAnnouncement((previous) => ({ message, id: previous.id + 1 }))
  }

  const editing = session ? entries.get(session.media.id) ?? [...entries.values()].find((entry) => mediaKey(entry.media) === mediaKey(session.media)) : undefined

  function openLog(media: Media, trigger: HTMLElement, initialStatus?: Status) {
    setSession((previous) => ({ key: (previous?.key ?? 0) + 1, media, trigger, initialStatus, locationKey: location.key }))
    setLogOpen(true)
  }

  async function save(media: Media, draft: LogDraft) {
    const { id, created } = await library.save(media, draft)
    if (created) keepLibrary()
    setHighlightId(id)
    announce(created ? `${media.title} saved to Library.` : `Changes to ${media.title} saved.`)
  }

  async function completeToday(media: Media) {
    const { id, changed } = await library.completeToday(media)
    if (!changed) return
    setHighlightId(id)
    announce(`${media.title} marked ${media.format === 'BOOK' ? 'read' : media.format === 'GAME' ? 'played' : 'watched'}.`)
  }

  async function uncomplete(media: Media) {
    const { id, removed, completed } = await library.uncomplete(media)
    if (!removed) setHighlightId(id)
    announce(completed ? `Latest completion removed from ${media.title}.`
      : `${media.title} marked ${media.format === 'BOOK' ? 'unread' : media.format === 'GAME' ? 'unplayed' : 'unwatched'}.`)
  }

  async function setEpisode(entry: LibraryEntry, episodes: readonly Episode[], watched: boolean, season?: number) {
    await library.setEpisode(entry.media.id, episodes, watched)
    const name = season === undefined ? episodes[0].title : season === 0 ? 'Specials' : `Season ${season}`
    announce(`${name} marked ${watched ? 'watched' : 'unwatched'}.`)
  }

  async function savePreference(media: Media, change: PreferenceChange) {
    const { id } = await library.savePreference(media, change)
    setHighlightId(id)
    if (change.kind === 'like') announce(change.value ? `${media.title} liked.` : `Like removed from ${media.title}.`)
    if (change.kind === 'watchlist') announce(change.value ? `${media.title} added to Watchlist.` : `${media.title} removed from Watchlist.`)
    if (change.kind === 'rating') announce(change.value === null ? `Rating removed from ${media.title}.` : `${media.title} rated ${change.value} out of 5.`)
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

  if (welcome) {
    return (
      <MotionConfig reducedMotion={animate ? 'never' : 'always'}>
        <Welcome logo={<LogoMark size={iconSize.display} />} onGuest={() => finishWelcome('guest')} onSignedIn={() => finishWelcome('google')} />
      </MotionConfig>
    )
  }

  return (
    <MotionConfig reducedMotion={animate ? 'never' : 'always'}>
      <div className="app-shell" data-motion={animate ? 'full' : 'reduced'} data-popular-view={path === '/popular' && !detailId || undefined}>
        <a href="#main-content" className="skip-link">Skip to content</a>
        <aside className="sidebar">
          <Link to="/" className="wordmark"><LogoMark size={iconSize.display} /> Epilog</Link>
          <nav aria-label="Primary">
            {navigation.map(({ to, label, Icon }) => (
              <NavLink key={to} to={to} end className={linkProps}>
                {({ isActive }) => <>{isActive && <SelectionIndicator id="sidebar-selection" />}<Icon size={iconSize.lg} /> {label}</>}
              </NavLink>
            ))}
          </nav>
        </aside>
        <header className="mobile-header">
          <Link to="/" className="wordmark"><LogoMark size={iconSize.xl} /> Epilog</Link>
          <div>
            {navigation.filter(({ mobile }) => !mobile).map(({ to, label, Icon }) => (
              <NavLink key={to} to={to} className="icon-button header-link" aria-label={label}>
                {({ isActive }) => <>{isActive && <SelectionIndicator id="header-selection" />}<Icon size={iconSize.sm} /></>}
              </NavLink>
            ))}
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1} ref={main}>
          <LayoutGroup>
            {state.status === 'loading' || welcomePending ? <LibraryLoading /> : null}
            {state.status === 'error' ? (
              <motion.div className="empty-state" variants={rise} initial={animate ? 'hidden' : false} animate="visible">
                <h1 tabIndex={-1}>Library unavailable</h1>
                <p role="alert">Epilog could not open this browser’s local storage. Check that browser storage is enabled and try again.</p>
                <button type="button" className="button button-secondary" onClick={retryStorage}>Try again</button>
              </motion.div>
            ) : null}
            {path && state.status === 'ready' && !welcomePending ? (
              <div className="page" key={browse} hidden={Boolean(detailId)}>
                {path === '/' ? <Dashboard entries={entries} onLog={openLog} />
                  : path === '/library' ? <Library entries={entries} view={browseParams.get('view')} defaultStatus={defaultStatus} defaultCategory={defaultCategory} highlightId={highlightId} />
                  : path === '/popular' ? <Popular entries={entries} query={query ?? ''} onLog={openLog} onComplete={completeToday} onUncomplete={uncomplete} onPreference={savePreference} />
                  : path === '/search' ? <Search entries={entries} onLog={(media, trigger, status) => openLog(media, trigger, status ?? (browseParams.get('action') === 'watch' ? 'Completed' : undefined))} />
                  : path === '/compare' ? <Compare hash={hash} entries={entries} onLog={openLog} />
                  : path === '/privacy' ? <Privacy />
                  : path === '/settings' ? <Settings theme={theme} onTheme={changeTheme} storageError={storageError} onRestore={(count) => announce(count ? 'Backup restored.' : 'Backup reviewed. Your library is already up to date.')} />
                  : <MissingPage />}
              </div>
            ) : null}
            {detailId && state.status === 'ready' ? (
              <motion.div key={detailId} className="page" variants={crossfade} initial={animate && !origin ? 'hidden' : false} animate="visible">
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
                <CatalogFeedback messages={detailPending ? [] : detailMessages} ready={remote.status === 'ready'}
                  retry={connected ? () => setRetryDetail((value) => value + 1) : undefined} loading={remote.status === 'loading'} />
              </motion.div>
            ) : null}
          </LayoutGroup>
        </main>
        <nav className="mobile-nav" aria-label="Primary">
          {navigation.filter(({ mobile }) => mobile).map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} end className={linkProps}>
              {({ isActive }) => <>{isActive && <SelectionIndicator id="dock-selection" />}<Icon size={iconSize.lg} /> {label}</>}
            </NavLink>
          ))}
        </nav>
        {import.meta.env.PROD ? <Suspense fallback={null}><InstallStatus /></Suspense> : null}
        <LogDialog
          session={session}
          open={logOpen && session?.locationKey === location.key}
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
