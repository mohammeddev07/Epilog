import { readFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { parseBackup } from '../src/domain/backup-file'

test('persists repeat film completions and supports confirmed removal', async ({ page }) => {
  await page.goto('/title/the-last-signal')
  const dialog = page.getByRole('dialog')
  await page.getByRole('button', { name: 'Watch', exact: true }).click()
  await dialog.getByRole('radio', { name: 'Completed' }).check()
  await dialog.getByLabel('Watch date').fill('2026-11-18')
  await dialog.getByRole('button', { name: 'Save to library' }).click()
  await page.getByRole('button', { name: 'Watched', exact: true }).click()
  await dialog.getByRole('checkbox', { name: 'Log another completion' }).check()
  await dialog.getByLabel('Watch date').fill('2026-11-18')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.locator('time[datetime="2026-11-18"]')).toHaveCount(2)
  await page.reload()
  await expect(page.locator('time[datetime="2026-11-18"]')).toHaveCount(2)
  await page.getByRole('button', { name: 'Remove from library' }).click()
  await page.getByRole('button', { name: 'Keep entry' }).click()
  await expect(page.locator('time')).toHaveCount(2)
  await page.getByRole('button', { name: 'Remove from library' }).click()
  await page.getByRole('button', { name: 'Remove entry' }).click()
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
})

test('records and unmarks a manual anime episode while disconnected', async ({ page, context }) => {
  await page.goto('/title/lantern-season')
  await page.getByRole('button', { name: 'Watch', exact: true }).click()
  await page.getByRole('radio', { name: 'Planned' }).check()
  await page.getByRole('button', { name: 'Save to library' }).click()
  await context.setOffline(true)
  await page.getByText('Log an episode by number').click()
  await page.getByRole('spinbutton', { name: 'Season number' }).fill('3')
  await page.getByRole('spinbutton', { name: 'Episode number' }).fill('17')
  await page.getByRole('button', { name: 'Mark watched' }).click()
  const episode = page.getByRole('checkbox', { name: 'Watched Episode 17' })
  await expect(episode).toBeChecked()
  await expect(page.getByText('1 episode watched', { exact: true })).toBeVisible()
  await episode.click()
  await expect(page.getByText('0 episodes watched', { exact: true })).toBeVisible()
  await context.setOffline(false)
  await page.reload()
  await expect(page.getByText('0 episodes watched', { exact: true })).toBeVisible()
})

test('moves a backup to a fresh profile, previews repeats and conflicts, and rejects malformed files', async ({ page, browser }) => {
  await page.goto('/title/starlight-courier')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.getByRole('radio', { name: 'In progress' }).check()
  await page.getByLabel('Total hours').fill('7.5')
  await page.getByRole('button', { name: 'Save to library' }).click()
  await page.getByRole('link', { name: 'Settings' }).click()
  const downloadPending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export backup' }).click()
  const download = await downloadPending
  const path = await download.path()
  const backup = parseBackup(await readFile(path, 'utf-8'))
  expect(backup.entries[0]).toMatchObject({ status: 'In progress', playtimeMinutes: 450 })

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', colorScheme: 'dark' })
  const target = await phone.newPage()
  try {
    await target.goto('/settings')
    const file = target.getByLabel('Epilog backup file')
    await file.setInputFiles(path)
    await expect(target.getByText('1 new · 0 already in library · 0 conflicts')).toBeVisible()
    const violations = await new AxeBuilder({ page: target }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    expect(violations.violations).toEqual([])
    await target.getByRole('button', { name: 'Restore backup', exact: true }).click()
    await expect(target.getByText('Backup restored.', { exact: true }).first()).toBeAttached()
    await file.setInputFiles(path)
    await expect(target.getByText('0 new · 1 already in library · 0 conflicts')).toBeVisible()
    await target.getByRole('button', { name: 'Restore backup', exact: true }).click()
    await expect(target.getByText('Your library is already up to date.', { exact: false }).first()).toBeAttached()

    const modified = { ...backup, entries: [{ ...backup.entries[0], status: 'Dropped' }] }
    await file.setInputFiles({ name: 'different.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(modified)) })
    await expect(target.getByText('0 new · 1 already in library · 1 conflict')).toBeVisible()
    await expect(target.getByRole('radio', { name: 'Keep current values' })).toBeChecked()
    await target.getByRole('button', { name: 'Restore backup', exact: true }).click()
    await expect(target.getByRole('heading', { name: 'Review restore' })).toBeHidden()
    await file.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{') })
    await expect(target.getByRole('alert')).toContainText('not valid JSON')
    await target.getByRole('link', { name: 'Library', exact: true }).click()
    await expect(target.getByRole('list', { name: 'Library titles' }).getByRole('link')).toHaveCount(1)
    await target.getByRole('link', { name: /Starlight Courier/ }).click()
    await expect(target.getByText('7.5 hr played')).toBeVisible()
    await expect(target.getByRole('article').getByText('In progress', { exact: true })).toBeVisible()
  } finally {
    await phone.close()
  }
})

test('shows distinct watched and watchlist totals above the four Library categories', async ({ page }) => {
  const rows = [
    { id: 'the-last-signal', format: 'MOVIE', anime: false, status: 'Completed', completions: [
      { id: 'first-watch', date: '2026-11-11' }, { id: 'second-watch', date: '2026-11-18' },
    ] },
    { id: 'glass-tide', format: 'MOVIE', anime: false, status: 'Planned' },
    { id: 'northbound', format: 'SERIES', anime: false, status: 'Completed' },
    { id: 'lantern-season', format: 'SERIES', anime: true, status: 'Completed', watchlisted: true },
    { id: 'starlight-courier', format: 'GAME', anime: false, status: 'Planned' },
  ]
  const entries = rows.map(({ id, format, anime, status, watchlisted, completions }) => ({
    media: { id, format, anime }, status, watchlisted, completions: completions ?? [],
    episodes: [], createdAt: 1, updatedAt: 2,
  }))
  await page.goto('/settings')
  await page.getByLabel('Epilog backup file').setInputFiles({
    name: 'library.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'epilog-library', version: 2, entries })),
  })
  await page.getByRole('button', { name: 'Restore backup', exact: true }).click()
  await page.getByRole('link', { name: 'Library', exact: true }).click()
  const categoryTabs = page.getByRole('group', { name: 'Library categories' })
  await expect(categoryTabs.getByRole('button')).toHaveText(['Movies', 'TV Shows', 'Anime', 'Games'])
  const totals = page.locator('.library-totals')
  await expect(totals.locator('dd')).toHaveText(['1', '1'])
  const search = page.getByRole('searchbox', { name: 'Search library' })
  await search.fill('No matching title')
  await expect(page.getByRole('heading', { name: 'No matching titles' })).toBeVisible()
  await expect(totals.locator('dd')).toHaveText(['1', '1'])
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(search).toBeFocused()

  await categoryTabs.getByRole('button', { name: 'TV Shows' }).click()
  await expect(totals.locator('dd')).toHaveText(['1', '0'])
  const grid = page.getByRole('list', { name: 'Library titles' })
  await expect(grid.getByRole('link')).toHaveCount(1)
  await expect(grid.getByRole('link', { name: /Northbound/ })).toBeVisible()
  await categoryTabs.getByRole('button', { name: 'Anime' }).click()
  await expect(totals.locator('dd')).toHaveText(['1', '1'])
  await expect(grid.getByRole('link', { name: /Lantern Season/ })).toBeVisible()
  await categoryTabs.getByRole('button', { name: 'Games' }).click()
  await expect(totals).toContainText('Played')
  await expect(totals.locator('dd')).toHaveText(['0', '1'])
})
