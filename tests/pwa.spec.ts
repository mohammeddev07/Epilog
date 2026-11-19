import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve, relative, isAbsolute, extname } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const localApp = 'http://127.0.0.1:4178'

const watch = {
  id: 'tmdb:tv:42',
  identity: { provider: 'tmdb', entity: 'tv', id: '42' },
  format: 'SERIES', anime: true,
  title: 'Moonlight Series', description: 'Test series', genres: [],
  seasons: [{ number: 1, episodeCount: 2 }],
  catalogedAt: Date.now(),
}

async function waitForOfflineShell(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
}

test('has an installable manifest and saves episodes after an offline deep-link reload', async ({ page, context }) => {
  await page.route('**/api/catalog/detail/**', (route) => route.fulfill({ json: { items: [watch] } }))
  await page.route('**/api/catalog/season/**', (route) => route.fulfill({ json: { episodes: [
    { season: 1, number: 1, title: 'First episode', externalId: '100' },
    { season: 1, number: 2, title: 'Second episode', externalId: '101' },
  ] } }))
  await page.goto(localApp + '/title/tmdb%3Atv%3A42')
  await waitForOfflineShell(page)
  const session = await context.newCDPSession(page)
  const installability = await session.send('Page.getInstallabilityErrors')
  expect(installability.installabilityErrors).toEqual([])
  const manifest = await (await page.request.get(localApp + '/manifest.webmanifest')).json()
  expect(manifest).toMatchObject({ name: 'Epilog', display: 'standalone', start_url: '/' })
  expect(manifest.icons).toEqual(expect.arrayContaining([expect.objectContaining({ sizes: '192x192' }), expect.objectContaining({ sizes: '512x512', purpose: 'maskable' })]))

  await page.getByRole('button', { name: 'Log this title' }).click()
  await page.getByLabel('Title for backups').fill('My Moonlight Series')
  await page.getByRole('button', { name: 'Save to library' }).click()
  await expect(page.getByRole('checkbox', { name: 'Watched First episode' })).toBeVisible()
  await page.getByRole('link', { name: 'Library', exact: true }).first().click()
  await page.getByRole('link', { name: /Moonlight Series/ }).click()
  await expect(page.getByRole('checkbox', { name: 'Watched First episode' })).toBeVisible()
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Moonlight Series' })).toBeVisible()
  const episode = page.getByRole('checkbox', { name: 'Watched First episode' })
  await episode.click()
  await expect(episode).toBeChecked()
  await page.reload()
  await expect(episode).toBeChecked()
})

const mime: Record<string, string> = {
  '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json',
}

test('installs an app update on request and keeps the IndexedDB library', async ({ page }) => {
  const dist = resolve('dist')
  let release = 1
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      const extension = extname(path)
      const file = resolve(dist, extension ? '.' + path : 'index.html')
      const target = relative(dist, file)
      if (path.startsWith('/api/') || target.startsWith('..') || isAbsolute(target)) {
        response.writeHead(404).end()
        return
      }
      const staticAsset = await readFile(file)
      const body = release === 2 && path === '/sw.js' ? Buffer.concat([staticAsset, Buffer.from('\n/* Epilog update fixture */\n')]) : staticAsset
      response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body)
    })().catch(() => response.writeHead(404).end())
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Update fixture did not start.')
    const origin = `http://127.0.0.1:${address.port}`
    await page.route('**/api/catalog/detail/**', (route) => route.fulfill({ json: { items: [watch] } }))
    await page.goto(origin + '/title/tmdb%3Atv%3A42')
    await waitForOfflineShell(page)
    await page.getByRole('button', { name: 'Log this title' }).click()
    await page.getByRole('button', { name: 'Save to library' }).click()
    await expect(page.getByRole('button', { name: 'Edit entry' })).toBeVisible()
    const previous = await page.evaluate(() => performance.timeOrigin)
    release = 2
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())?.update()
    })
    await expect(page.getByRole('button', { name: 'Update and reload' })).toBeVisible({ timeout: 12_000 })
    await Promise.all([
      page.waitForEvent('load'),
      page.getByRole('button', { name: 'Update and reload' }).click(),
    ])
    expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(previous)
    await expect(page.getByRole('button', { name: 'Edit entry' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Moonlight Series' })).toBeVisible()
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
})
