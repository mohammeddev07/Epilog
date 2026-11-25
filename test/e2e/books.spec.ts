import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { parseBackup } from '../../src/domain/backup-file'

const readingFigure = (page: Page, label: string) =>
  page.getByRole('region', { name: 'Reading' }).locator('.figures div').filter({ hasText: label }).locator('dd')

async function openStats(page: Page) {
  await page.getByRole('link', { name: 'Library', exact: true }).first().click()
  await page.getByRole('navigation', { name: 'Library sections' }).getByRole('link', { name: /^Stats/ }).click()
}

test('adds a book, updates and completes its progress, and restores it on a phone', async ({ page, browser }) => {
  await page.goto('/title/the-glass-orchard')
  const dialog = page.getByRole('dialog')
  await page.getByRole('button', { name: 'Start reading' }).click()
  await expect(dialog.getByLabel('Book type')).toHaveValue('Novel')
  await expect(dialog.getByLabel('Track by')).toHaveValue('page')
  await dialog.getByLabel('Pages read').fill('40')
  await dialog.getByLabel('Total pages (optional)').fill('320')
  await dialog.getByRole('button', { name: 'Save to library' }).click()
  await expect(page.getByText('40 of 320 pages read')).toBeVisible()

  await page.getByRole('button', { name: 'Edit reading progress' }).click()
  await dialog.getByLabel('Pages read').fill('120')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('120 of 320 pages read')).toBeVisible()

  await page.getByRole('button', { name: 'Edit reading progress' }).click()
  await dialog.getByRole('radio', { name: 'Completed' }).check()
  await dialog.getByLabel('Completion date').fill('2026-11-20')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('320 of 320 pages read')).toBeVisible()
  await page.reload()
  await expect(page.getByText('320 of 320 pages read')).toBeVisible()

  await openStats(page)
  await expect(readingFigure(page, 'Pages read')).toHaveText('320')
  await expect(readingFigure(page, 'Chapters read')).toHaveText('0')
  await expect(readingFigure(page, 'Books completed')).toHaveText('1')
  await expect(page.getByRole('row', { name: /^Novels/ })).toHaveText(/Novels\s*1\s*1/)

  await page.getByRole('link', { name: 'Settings' }).click()
  for (const name of ['Appearance', 'Library Preferences', 'Backup & Restore', 'App Information']) {
    await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible()
  }
  const downloadPending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export backup' }).click()
  const path = await (await downloadPending).path()
  const backup = parseBackup(await readFile(path, 'utf-8'))
  expect(backup.entries[0]).toMatchObject({
    status: 'Completed', media: { format: 'BOOK', bookType: 'Novel', label: 'The Glass Orchard' },
    reading: { unit: 'page', count: 320, total: 320 },
  })

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const target = await phone.newPage()
  try {
    await target.goto('/search')
    await target.getByLabel('Media category').selectOption('Books')
    await target.getByLabel('Book type').selectOption('Manhwa')
    await target.getByRole('button', { name: 'Add a book manually' }).click()
    const sheet = target.getByRole('dialog')
    await sheet.getByLabel('Book title').fill('Tower Diaries')
    await expect(sheet.getByLabel('Track by')).toHaveValue('chapter')
    await sheet.getByLabel('Chapters read').fill('12')
    await sheet.getByRole('button', { name: 'Save to library' }).click()
    await expect(sheet).toBeHidden()

    await target.goto('/settings')
    await target.getByLabel('Epilog backup file').setInputFiles(path)
    await expect(target.getByText('1 new · 0 already in library · 0 conflicts')).toBeVisible()
    await target.getByRole('button', { name: 'Restore backup', exact: true }).click()
    await expect(target.getByText('Backup restored.', { exact: true }).first()).toBeAttached()

    await target.getByRole('link', { name: 'Library', exact: true }).first().click()
    await target.getByRole('navigation', { name: 'Library sections' }).getByRole('link', { name: /^Books/ }).click()
    const grid = target.getByRole('list', { name: 'Library titles' })
    await expect(grid.getByRole('link')).toHaveCount(2)
    await target.getByRole('button', { name: 'Filter', exact: true }).click()
    await target.getByRole('dialog', { name: 'Filter and sort' }).getByLabel('Book type').selectOption('Manhwa')
    await target.getByRole('dialog', { name: 'Filter and sort' }).getByRole('button', { name: 'Done' }).click()
    await expect(grid.getByRole('link')).toHaveText([/Tower Diaries/])

    await openStats(target)
    await expect(readingFigure(target, 'Pages read')).toHaveText('320')
    await expect(readingFigure(target, 'Chapters read')).toHaveText('12')
    await expect(readingFigure(target, 'Books completed')).toHaveText('1')
    expect(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    await phone.close()
  }
})

test('Books has every Dashboard shelf, filtered by type, with Open Library covers', async ({ page }) => {
  const requested: string[] = []
  const poster = 'https://covers.openlibrary.org/b/id/9-L.jpg?default=false'
  const book = (title: string) => ({ id: 'openlibrary:work:OL7W', identity: { provider: 'openlibrary', entity: 'work', id: 'OL7W' },
    title, format: 'BOOK', bookType: 'Manga', genres: [], description: '', catalogedAt: 1, poster })
  await page.route((url) => /^\/api\/catalog\/(popular|discover)\//.test(url.pathname), (route) => {
    const url = new URL(route.request().url())
    requested.push(url.pathname + url.search)
    const shelf = url.pathname.split('/').at(-2)
    return route.fulfill({ json: { items: url.pathname.endsWith('/books') ? [book(`${shelf} manga`)] : [], hasMore: false } })
  })
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  await page.route('https://covers.openlibrary.org/**', (route) => route.fulfill({ contentType: 'image/png', body: pixel }))
  await page.goto('http://127.0.0.1:4178/')
  await page.getByRole('group', { name: 'Popular This Week categories' }).getByRole('button', { name: 'Books' }).click()
  await page.getByLabel('Book type').selectOption('Manga')
  for (const [heading, shelf] of [['Popular This Week', 'popular'], ['Highest Rated', 'rated'], ['Most Anticipated', 'anticipated'], ['Release Date', 'release']]) {
    const region = page.getByRole('region', { name: heading, exact: true })
    await region.scrollIntoViewIfNeeded()
    await expect(region.getByRole('link', { name: new RegExp(`${shelf} manga`) })).toBeVisible()
  }
  const cover = page.locator(`img[src="${poster}"]`).first()
  await expect(cover).toBeVisible()
  expect(await cover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
  for (const path of ['/popular/books?type=Manga', '/discover/rated/books?type=Manga', '/discover/anticipated/books?type=Manga', '/discover/release/books?decade=2020&type=Manga']) {
    expect(requested).toContain('/api/catalog' + path)
  }
})
