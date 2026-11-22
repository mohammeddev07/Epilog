import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { parseBackup } from '../src/domain/backup-file'
import { mergeChange } from '../src/domain/sync'
import type { EntryData, SyncChange } from '../src/domain/sync'

test.use({ baseURL: 'http://127.0.0.1:4178' })

const welcome = 'Every story you love, in one place.'
const title = (id: string, name: string) => ({
  id: `tmdb:movie:${id}`, identity: { provider: 'tmdb', entity: 'movie', id }, format: 'MOVIE', anime: false,
  title: name, description: 'Test film', genres: [], year: 2025, catalogedAt: Date.now(),
})
const moon = title('42', 'Moon Lantern')
const sun = title('43', 'Sun Harbor')
const titles = [moon, sun]

// Google's script, replaced by a button that hands back a fake credential the fake server accepts.
const gisStub = `window.google = { accounts: { id: {
  initialize(options) { window.gisCallback = options.callback },
  renderButton(parent) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = 'Continue with Google'
    button.onclick = () => window.gisCallback({ credential: 'fake' })
    parent.replaceChildren(button)
  },
} } }`

const entry = (id: string, catalogRef: string, at: number): SyncChange => {
  const data: EntryData = {
    format: 'MOVIE', anime: false, catalogRef, createdAt: at,
    groups: { progress: { at: 0 }, liked: { at: 0 }, rating: { at: 0 }, watchlisted: { value: true, at }, label: { at: 0 } },
  }
  return { kind: 'entry', id, data, at }
}

/** In-memory stand-in for the Worker's account and sync routes: one record set per Google `sub`. */
function fakeServer() {
  const users = new Map<string, { revision: number; rows: Map<string, { change: SyncChange; revision: number }> }>()
  const network = { offline: false, expired: false }
  const calls = { logout: 0, deleted: 0 }
  const user = (sub: string) => {
    if (!users.has(sub)) users.set(sub, { revision: 0, rows: new Map() })
    return users.get(sub)!
  }
  function push(sub: string, changes: readonly SyncChange[]) {
    const account = user(sub)
    for (const change of changes) {
      const key = `${change.kind}:${change.id}`
      const current = account.rows.get(key)?.change
      const merged = mergeChange(current, change)
      if (JSON.stringify(merged) !== JSON.stringify(current)) account.rows.set(key, { change: merged, revision: ++account.revision })
    }
  }
  function records(sub: string, kind: SyncChange['kind']) {
    return [...user(sub).rows.values()].map(({ change }) => change).filter((change) => change.kind === kind)
  }

  async function attach(context: BrowserContext, sub: string) {
    await context.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({ contentType: 'text/javascript', body: gisStub }))
    await context.route('**/api/config', (route) => route.fulfill({ json: { googleClientId: 'test-client.apps.googleusercontent.com' } }))
    await context.route('**/api/auth/*', (route) => {
      expect(route.request().headers()['content-type']).toBe('application/json')
      if (!route.request().url().endsWith('/logout')) return route.fulfill({ json: { sub, email: `${sub}@example.test`, name: 'Ada' } })
      if (network.offline) return route.abort('internetdisconnected')
      calls.logout++
      return route.fulfill({ status: 204 })
    })
    await context.route('**/api/account', (route) => {
      expect(route.request().method()).toBe('DELETE')
      expect(route.request().headers()['content-type']).toBe('application/json')
      if (network.offline) return route.abort('internetdisconnected')
      users.delete(sub)
      calls.deleted++
      return route.fulfill({ status: 204 })
    })
    await context.route('**/api/sync', (route) => {
      expect(route.request().headers()['content-type']).toBe('application/json')
      if (network.offline) return route.abort('internetdisconnected') // routes still answer under setOffline
      if (network.expired) return route.fulfill({ status: 401, json: { error: 'unauthorized' } })
      const { cursor, changes } = route.request().postDataJSON() as { cursor: number; changes: SyncChange[] }
      push(sub, changes)
      const account = user(sub)
      const changed = [...account.rows.values()].filter((row) => row.revision > cursor).map(({ change }) => change)
      return route.fulfill({ json: { cursor: account.revision, changes: changed, remap: {}, more: false } })
    })
    await context.route((url) => url.pathname.startsWith('/api/catalog/'), (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api/catalog/', '')
      if (path.startsWith('detail/')) {
        const item = titles.find(({ id }) => id === decodeURIComponent(path.slice('detail/'.length)))
        return item ? route.fulfill({ json: { items: [item] } }) : route.fulfill({ status: 404, json: { error: 'not_found' } })
      }
      if (path === 'search/tmdb') {
        const query = (route.request().postDataJSON() as { query: string }).query.toLowerCase()
        return route.fulfill({ json: { items: titles.filter((item) => item.title.toLowerCase().includes(query)) } })
      }
      return route.fulfill({ json: { items: path.startsWith('popular/') ? titles : [], hasMore: false } })
    })
  }

  return { network, calls, push, records, attach }
}

async function open(browser: import('@playwright/test').Browser, server: ReturnType<typeof fakeServer>, sub: string) {
  const context = await browser.newContext()
  await server.attach(context, sub)
  return { context, page: await context.newPage() }
}

async function logFromSearch(page: Page, name: string) {
  await page.goto('/search')
  await page.getByRole('searchbox').fill(name)
  await page.getByRole('button', { name: `Log ${name}`, exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save to library' }).click()
  await expect(page.getByRole('button', { name: `Open saved entry for ${name}` })).toBeVisible()
}

async function signInFromSettings(page: Page) {
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
}

async function movieTitles(page: Page) {
  await page.goto('/library?category=Movies')
  return page.getByRole('list', { name: 'Library titles' })
}

test('first visit offers Google or guest; guest goes straight to the Dashboard and is not asked again', async ({ browser, page }) => {
  const { context, page: first } = await open(browser, fakeServer(), 'sub-guest')
  try {
    await first.goto('/')
    await expect(first.getByRole('heading', { level: 1, name: welcome })).toBeFocused()
    await expect(first.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
    await expect(first.getByText('Guests keep their library on this device only.')).toBeVisible()
    await expect(first.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', '/privacy')
    await first.getByRole('button', { name: 'Continue as guest' }).click()
    await expect(first.getByRole('heading', { name: 'Dashboard' })).toBeFocused()
    await first.reload()
    await expect(first.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(first.getByRole('heading', { name: welcome })).toHaveCount(0)
  } finally {
    await context.close()
  }

  // The demo never offers sign-in, even with a client ID available.
  await page.route('**/api/config', (route) => route.fulfill({ json: { googleClientId: 'test-client.apps.googleusercontent.com' } }))
  await page.goto('http://127.0.0.1:4176/')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByRole('heading', { name: welcome })).toHaveCount(0)
  await page.goto('http://127.0.0.1:4176/settings')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0)
})

test('shared /compare and /title links skip the welcome screen', async ({ browser }) => {
  const { context, page } = await open(browser, fakeServer(), 'sub-links')
  try {
    await page.goto('/compare')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('heading', { name: welcome })).toHaveCount(0)
    // A visit that opened on a shared link stays in the app, even on the Dashboard.
    await page.getByRole('navigation', { name: 'Primary' }).first().getByRole('link', { name: 'Dashboard' }).click()
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByRole('heading', { name: welcome })).toHaveCount(0)

    await page.goto(`/title/${encodeURIComponent(moon.id)}`)
    await expect(page.getByRole('heading', { name: 'Moon Lantern' })).toBeVisible()
    await expect(page.getByRole('heading', { name: welcome })).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('signing in merges the guest library, and a second device shows real titles and a removed watch', async ({ browser }) => {
  const server = fakeServer()
  const a = await open(browser, server, 'sub-ada')
  const b = await open(browser, server, 'sub-ada')
  try {
    // Device A: two titles and a watch as a guest, then sign in.
    await a.page.goto('/')
    await a.page.getByRole('button', { name: 'Continue as guest' }).click()
    await a.page.getByRole('list', { name: 'Popular This Week', exact: true }).getByRole('link', { name: /Moon Lantern/ }).click()
    await a.page.getByRole('button', { name: 'Watchlist', exact: true }).click() // so removing the watch keeps the title
    await a.page.getByRole('button', { name: 'Watch', exact: true }).click()
    await expect(a.page.getByRole('button', { name: 'Watched', exact: true })).toBeVisible()
    await logFromSearch(a.page, 'Sun Harbor')
    await signInFromSettings(a.page)
    await expect.poll(() => server.records('sub-ada', 'entry').length).toBe(2)
    expect(server.records('sub-ada', 'completion').filter(({ data }) => data)).toHaveLength(1)

    // Device B: a fresh browser signs in from the welcome screen and gets the library, by name.
    await b.page.goto('/')
    await b.page.getByRole('button', { name: 'Continue with Google' }).click()
    await expect(b.page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    const list = await movieTitles(b.page)
    await expect(list).toContainText('Moon Lantern')
    await expect(list).toContainText('Sun Harbor')
    await list.getByRole('link', { name: /Moon Lantern/ }).click()
    await expect(b.page.getByRole('button', { name: 'Watched', exact: true })).toBeVisible()

    // Device A removes the watch; device B shows it once it comes back into focus.
    await a.page.goto('/')
    await a.page.getByRole('list', { name: 'Popular This Week', exact: true }).getByRole('link', { name: /Moon Lantern/ }).click()
    await a.page.getByRole('button', { name: 'Watched', exact: true }).click()
    await a.page.getByRole('dialog', { name: 'Mark as not watched?' }).getByRole('button', { name: 'Remove' }).click()
    await expect(a.page.getByRole('button', { name: 'Watch', exact: true })).toBeVisible()
    await expect.poll(() => server.records('sub-ada', 'completion').filter(({ data }) => data).length).toBe(0)
    await b.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect(b.page.getByRole('button', { name: 'Watch', exact: true })).toBeVisible()
  } finally {
    await a.context.close()
    await b.context.close()
  }
})

test('offline edits sync after reconnecting', async ({ browser }) => {
  const server = fakeServer()
  server.push('sub-offline', [entry('m-moon', moon.id, 1000)])
  const { context, page } = await open(browser, server, 'sub-offline')
  const status = () => {
    const data = server.records('sub-offline', 'entry')[0]?.data as EntryData | null
    return data?.groups.progress.status
  }
  try {
    await page.goto('/')
    await page.getByRole('button', { name: 'Continue with Google' }).click()
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    const list = await movieTitles(page)
    await list.getByRole('link', { name: /Moon Lantern/ }).click()
    await expect(page.getByRole('heading', { name: 'Moon Lantern' })).toBeVisible()

    await context.setOffline(true)
    server.network.offline = true
    await page.getByRole('button', { name: 'Watch', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: /^Save/ }).click()
    await expect(page.getByRole('button', { name: 'Watched', exact: true })).toBeVisible()
    await page.waitForTimeout(2500) // past the sync debounce: nothing can reach the server
    expect(status()).toBeUndefined()

    server.network.offline = false
    await context.setOffline(false)
    await expect.poll(status).toBe('Completed')
  } finally {
    await context.close()
  }
})

test('a different account on a kept library asks to merge or replace', async ({ browser }) => {
  const server = fakeServer()
  server.push('sub-grace', [entry('m-sun', sun.id, 1000)])
  const { context, page } = await open(browser, server, 'sub-grace')
  try {
    await logFromSearch(page, 'Moon Lantern')
    // This library was kept by another account that signed out on this device.
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('epilog')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const transaction = request.result.transaction('meta', 'readwrite')
        transaction.objectStore('meta').put({ key: 'lastSub', value: 'sub-earlier' })
        transaction.oncomplete = () => { request.result.close(); resolve() }
        transaction.onerror = () => reject(transaction.error)
      }
    }))
    await signInFromSettings(page)
    const question = page.getByRole('dialog', { name: 'This device has another account’s library' })
    await expect(question.getByRole('button', { name: 'Merge into your account' })).toBeFocused()
    await question.getByRole('button', { name: 'Replace with your account’s library' }).click()
    await expect(question).toBeHidden()

    const list = await movieTitles(page)
    await expect(list).toContainText('Sun Harbor')
    await expect(list).not.toContainText('Moon Lantern')
    expect(server.records('sub-grace', 'entry').map(({ id }) => id)).toEqual(['m-sun'])
  } finally {
    await context.close()
  }
})

test('welcome and privacy pages pass axe', async ({ browser }) => {
  const { context, page } = await open(browser, fakeServer(), 'sub-axe')
  const axe = () => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  try {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
    await expect(page.locator('.welcome > *').last()).toHaveCSS('opacity', '1') // the entrance has finished
    expect((await axe()).violations).toEqual([])
    await page.getByRole('link', { name: 'Privacy policy' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy policy' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'What’s stored' })).toBeVisible()
    expect((await axe()).violations).toEqual([])
  } finally {
    await context.close()
  }
})

async function signInFromWelcome(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
}

const accountPanel = (page: Page) => page.getByRole('region', { name: 'Account' })

test('Settings shows the account and last sync, and a sync error offers Try again', async ({ browser }) => {
  const server = fakeServer()
  const { context, page } = await open(browser, server, 'sub-ada')
  try {
    await signInFromWelcome(page)
    await page.goto('/settings')
    const account = accountPanel(page)
    await expect(account.getByText('Ada', { exact: true })).toBeVisible()
    await expect(account.getByText('sub-ada@example.test')).toBeVisible()
    await expect(account.getByRole('status')).toContainText('Last synced')
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])

    server.network.offline = true
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect(account.getByRole('alert')).toHaveText('Sync didn’t finish. Epilog will try again shortly.')
    server.network.offline = false
    await account.getByRole('button', { name: 'Try again' }).click()
    await expect(account.getByRole('alert')).toHaveCount(0)
    await expect(account.getByRole('status')).toContainText('Last synced')
  } finally {
    await context.close()
  }
})

test('a guest can sign in from Settings, and an expired session asks to sign in again without losing queued edits', async ({ browser }) => {
  const server = fakeServer()
  const { context, page } = await open(browser, server, 'sub-ada')
  try {
    await page.goto('/')
    await page.getByRole('button', { name: 'Continue as guest' }).click()
    await signInFromSettings(page)
    const account = accountPanel(page)
    await expect(account.getByText('sub-ada@example.test')).toBeVisible()
    await expect(account.getByRole('heading', { name: 'Account' })).toBeFocused()

    server.network.expired = true
    await logFromSearch(page, 'Sun Harbor')
    await page.goto('/settings')
    await expect(account.getByRole('heading', { name: 'Sign in again' })).toBeVisible()
    await page.waitForTimeout(2500) // past the sync debounce: nothing reaches the server
    expect(server.records('sub-ada', 'entry')).toHaveLength(0)

    server.network.expired = false
    await account.getByRole('button', { name: 'Continue with Google' }).click()
    await expect(account.getByRole('status')).toContainText('Last synced')
    expect(server.records('sub-ada', 'entry').map(({ data }) => (data as EntryData).catalogRef)).toEqual([sun.id])
  } finally {
    await context.close()
  }
})

test('signing out can keep or remove this device’s copy', async ({ browser }) => {
  const server = fakeServer()
  server.push('sub-ada', [entry('m-moon', moon.id, 1000)])
  const { context, page } = await open(browser, server, 'sub-ada')
  const account = accountPanel(page)
  try {
    await signInFromWelcome(page)
    await page.goto('/settings')
    await account.getByRole('button', { name: 'Sign out' }).click()
    await page.getByRole('dialog', { name: 'Sign out?' }).getByRole('button', { name: 'Keep this device’s copy' }).click()
    await expect(account.getByRole('heading', { name: 'Account' })).toBeFocused()
    await expect(account.getByRole('status')).toHaveText('Signed out. This device keeps its library.')
    await expect(account.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
    expect(server.calls.logout).toBe(1)
    await expect(await movieTitles(page)).toContainText('Moon Lantern')

    // Offline, the server can't hear about it, but this device still signs out and says so.
    await signInFromSettings(page)
    await expect(account.getByText('sub-ada@example.test')).toBeVisible()
    server.network.offline = true
    await account.getByRole('button', { name: 'Sign out' }).click()
    await page.getByRole('dialog', { name: 'Sign out?' }).getByRole('button', { name: 'Remove it from this device' }).click()
    await expect(account.getByRole('status')).toHaveText('Signed out, and this device’s copy was removed. Epilog’s server couldn’t be reached, so its session ends on its own.')
    expect(server.calls.logout).toBe(1)
    await page.goto('/library')
    await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  } finally {
    await context.close()
  }
})

test('deleting the account erases server data and keeps the local library', async ({ browser }) => {
  const server = fakeServer()
  server.push('sub-ada', [entry('m-moon', moon.id, 1000)])
  const { context, page } = await open(browser, server, 'sub-ada')
  const account = accountPanel(page)
  const question = page.getByRole('dialog', { name: 'Delete your account?' })
  try {
    await signInFromWelcome(page)
    await page.goto('/settings')

    // A failed request changes nothing.
    server.network.offline = true
    await account.getByRole('button', { name: 'Delete account' }).click()
    await expect(question.getByText('This erases your synced library from Epilog’s server. This device keeps its copy.')).toBeVisible()
    await expect(question.getByRole('button', { name: 'Keep account' })).toBeFocused()
    await question.getByRole('button', { name: 'Delete account' }).click()
    await expect(question.getByRole('alert')).toHaveText('Couldn’t delete your account. Check your connection and try again.')
    await question.getByRole('button', { name: 'Keep account' }).click()
    await expect(question).toBeHidden()
    await expect(account.getByText('sub-ada@example.test')).toBeVisible()
    expect(server.records('sub-ada', 'entry')).toHaveLength(1)

    server.network.offline = false
    await account.getByRole('button', { name: 'Delete account' }).click()
    await question.getByRole('button', { name: 'Delete account' }).click()
    await expect(question).toBeHidden()
    await expect(account.getByRole('status')).toHaveText('Your account was deleted. This device keeps its library.')
    await expect(account.getByRole('heading', { name: 'Account' })).toBeFocused()
    await expect(account.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
    expect(server.calls.deleted).toBe(1)
    expect(server.records('sub-ada', 'entry')).toHaveLength(0)
    await expect(await movieTitles(page)).toContainText('Moon Lantern')
  } finally {
    await context.close()
  }
})

test('the pre-merge library can be exported for 30 days', async ({ browser }) => {
  const { context, page } = await open(browser, fakeServer(), 'sub-ada')
  const exportButton = page.getByRole('button', { name: /^Export library from before sign-in \(.+\)$/ })
  try {
    await logFromSearch(page, 'Moon Lantern')
    await page.goto('/settings')
    await expect(exportButton).toHaveCount(0)
    await page.getByRole('button', { name: 'Continue with Google' }).click()
    await expect(accountPanel(page).getByText('sub-ada@example.test')).toBeVisible()
    const downloadPending = page.waitForEvent('download')
    await exportButton.click()
    const download = await downloadPending
    expect(download.suggestedFilename()).toMatch(/^epilog-library-before-sign-in-\d{4}-\d{2}-\d{2}\.json$/)
    expect(parseBackup(await readFile(await download.path(), 'utf-8')).entries).toHaveLength(1)

    await page.clock.install({ time: Date.now() + 31 * 24 * 60 * 60_000 })
    await page.reload()
    await expect(page.getByRole('button', { name: 'Export backup' })).toBeVisible()
    await expect(exportButton).toHaveCount(0)
  } finally {
    await context.close()
  }
})
