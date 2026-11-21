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

test('marks a whole season watched in one click and can undo it', async ({ page }) => {
  await page.goto('/title/northbound')
  await page.getByRole('button', { name: 'Watch', exact: true }).click()
  await page.getByRole('radio', { name: 'In progress' }).check()
  await page.getByRole('button', { name: 'Save to library' }).click()
  await page.getByRole('combobox', { name: 'Season' }).selectOption('1')
  const episodes = ['Whiteout', 'The Beacon', 'Tree Line'].map((title) => page.getByRole('checkbox', { name: `Watched ${title}` }))
  await page.getByRole('button', { name: 'Mark season 1 watched' }).click()
  for (const episode of episodes) await expect(episode).toBeChecked()
  await expect(page.getByRole('status').filter({ hasText: 'Season 1 marked watched.' })).toBeAttached()
  await expect(page.getByText('3 of 5 episodes', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('combobox', { name: 'Season' }).selectOption('1')
  await page.getByRole('button', { name: 'Mark season 1 unwatched' }).click()
  for (const episode of episodes) await expect(episode).not.toBeChecked()
  await page.getByRole('combobox', { name: 'Season' }).selectOption('2')
  await expect(page.getByRole('button', { name: 'Mark season 2 watched' })).toBeVisible()
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
    await target.getByRole('navigation', { name: 'Library sections' }).getByRole('link', { name: /^Games/ }).click()
    await expect(target.getByRole('list', { name: 'Library titles' }).getByRole('link')).toHaveCount(1)
    await target.getByRole('link', { name: /Starlight Courier/ }).click()
    await expect(target.getByText('7.5 hr played')).toBeVisible()
    await expect(target.getByRole('article').getByText('In progress', { exact: true })).toBeVisible()
  } finally {
    await phone.close()
  }
})

test('lists Library sections that open filterable titles, and a stats page', async ({ page }) => {
  const rows = [
    { id: 'the-last-signal', format: 'MOVIE', anime: false, status: 'Completed', createdAt: 3, rating: 4, completions: [
      { id: 'first-watch', date: '2026-11-11' }, { id: 'second-watch', date: '2026-11-11' },
    ] },
    { id: 'glass-tide', format: 'MOVIE', anime: false, status: 'Completed', createdAt: 5 },
    { id: 'northbound', format: 'SERIES', anime: false, status: 'Planned', createdAt: 1 },
    { id: 'starlight-courier', format: 'GAME', anime: false, status: 'In progress', createdAt: 1, playtimeMinutes: 450 },
  ]
  const entries = rows.map(({ id, format, anime, status, completions, createdAt, rating, playtimeMinutes }) => ({
    media: { id, format, anime }, status, completions: completions ?? [], episodes: [], createdAt, updatedAt: 6,
    ...(rating ? { rating } : {}), ...(playtimeMinutes ? { playtimeMinutes } : {}),
  }))
  await page.goto('/settings')
  await page.getByLabel('Epilog backup file').setInputFiles({
    name: 'library.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'epilog-library', version: 2, entries })),
  })
  await page.getByRole('button', { name: 'Restore backup', exact: true }).click()
  await page.getByRole('link', { name: 'Library', exact: true }).click()
  const sections = page.getByRole('navigation', { name: 'Library sections' }).getByRole('link')
  // Whole rows are links: section, finished count, watchlist, saved total.
  await expect(sections).toHaveText([/^Movies2 watched2$/, /^TV shows0 watched, 1 on watchlist1$/, /^Games0 played1$/, /^Anime0 watched0$/, /^Stats/])

  await sections.filter({ hasText: /^Movies/ }).click()
  await expect(page).toHaveURL(/\/library\?category=Movies$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Movies' })).toBeFocused()
  const grid = page.getByRole('list', { name: 'Library titles' })
  // Filters live behind one Filter button; defaults count as no filter.
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  const filters = page.getByRole('dialog', { name: 'Filter and sort' })
  await expect(filters.getByLabel('Status')).toBeFocused()
  await expect(filters.getByLabel('Status')).toHaveValue('')
  const sort = filters.getByRole('combobox', { name: 'Sort by' })
  await expect(sort).toHaveValue('recent')
  await sort.selectOption('added')
  await expect(grid.getByRole('link')).toHaveText([/Glass Tide/, /The Last Signal/])
  await sort.selectOption('year')
  await expect(grid.getByRole('link')).toHaveText([/The Last Signal/, /Glass Tide/]) // 2025 before 2023
  await filters.getByRole('button', { name: 'Done' }).click()
  const filterButton = page.getByRole('button', { name: 'Filter, 1 active' })
  await expect(filterButton).toBeFocused()
  await filterButton.click()
  await filters.getByRole('button', { name: 'Reset' }).click()
  await expect(sort).toHaveValue('recent')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Filter', exact: true })).toBeFocused()
  const search = page.getByRole('searchbox', { name: 'Search library' })
  await search.fill('No matching title')
  await expect(page.getByRole('heading', { name: 'No matching titles' })).toBeVisible()
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(search).toBeFocused()
  await grid.getByRole('link', { name: /Glass Tide/ }).click()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(grid.getByRole('link', { name: /Glass Tide/ })).toBeFocused()

  await page.getByRole('link', { name: 'Library', exact: true }).first().click()
  await sections.filter({ hasText: /^Stats/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Stats' })).toBeFocused()
  const figure = (label: string) => page.locator('.figures div').filter({ hasText: label }).locator('dd')
  await expect(figure('Titles finished')).toHaveText('2')
  await expect(figure('Hours watched and played')).toHaveText('13') // 118 min twice (rewatch) + 104 min + 7.5 hr played
  await expect(figure('Title rewatched')).toHaveText('1')
  await expect(figure('Average rating, out of 5')).toHaveText('4')
  await expect(figure('Busiest month, 2 finished')).toHaveText('November 2026')
  await expect(figure('Hours on your watchlist')).toHaveText('4.3') // Northbound: 5 episodes × 52 min
  await expect(page.locator('.figures')).not.toContainText('Days with 2+')
  await expect(page.getByRole('list', { name: 'Hours per game' }).or(page.getByRole('region', { name: 'Hours per game' }))).toContainText('Starlight Courier7.5 hr')
  await expect(page.getByRole('region', { name: 'Countries' })).toContainText('United States')
  await expect(page.getByRole('region', { name: 'Your ratings' })).toContainText('4 stars1')
})
