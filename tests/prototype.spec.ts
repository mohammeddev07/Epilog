import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function assertAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations).toEqual([])
}

test('logs a film by keyboard, announces the save, and restores focus to the saved action', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Continue watching & playing' })).toHaveCount(0)
  const add = page.getByRole('button', { name: 'Log The Last Signal' })
  await add.focus()
  await page.keyboard.press('Enter')
  const editor = page.getByRole('dialog', { name: 'Log a title' })
  const planned = editor.getByRole('radio', { name: 'Planned' })
  await expect(planned).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(editor.getByRole('radio', { name: 'Completed' })).toBeChecked()
  await editor.getByLabel('Watch date').fill('2026-11-15')
  await editor.getByRole('button', { name: 'Save to library' }).click()
  await expect(editor).toBeHidden()
  const saved = page.getByRole('button', { name: 'Open saved entry for The Last Signal' })
  await expect(saved).toBeFocused()
  await expect(page.getByRole('status')).toHaveText('The Last Signal saved to Library.')
  await expect(page.getByRole('list', { name: 'Recently logged' })).toContainText('The Last Signal')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'The Last Signal' })).toBeFocused()
  await expect(page.locator('time')).toHaveAttribute('datetime', '2026-11-15')
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(saved).toBeFocused()
})

test('search keeps the same focused card after saving and supports editing game hours', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Log a title' }).click()
  const query = page.getByRole('searchbox', { name: 'Search catalog' })
  await expect(query).toBeFocused()
  await query.fill('Starlight')
  await page.getByRole('button', { name: 'Log Starlight Courier' }).click()
  const editor = page.getByRole('dialog')
  await editor.getByRole('radio', { name: 'In progress' }).check()
  await editor.getByLabel('Total hours').fill('-2')
  await editor.getByRole('button', { name: 'Save to library' }).click()
  await expect(editor.getByRole('alert')).toHaveText('Enter a valid total number of hours.')
  await expect(editor.getByLabel('Total hours')).toHaveValue('-2')
  await editor.getByLabel('Total hours').fill('12.5')
  await editor.getByRole('button', { name: 'Save to library' }).click()
  const saved = page.getByRole('button', { name: 'Open saved entry for Starlight Courier' })
  await expect(saved).toBeFocused()
  await saved.click()
  await expect(page.getByText('12.5 hr played')).toBeVisible()
  await page.getByRole('button', { name: 'Edit entry' }).click()
  await editor.getByLabel('Total hours').fill('16')
  await editor.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('16 hr played')).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(query).toHaveValue('Starlight')
  await expect(saved).toBeFocused()
})

test('tracks both series formats and keeps one anime film entry across library filters', async ({ page }) => {
  for (const [id, first, second] of [
    ['northbound', 'Whiteout', 'The Beacon'],
    ['lantern-season', 'First Light', 'The Old Bridge'],
  ]) {
    await page.goto(`/title/${id}`)
    await page.getByRole('button', { name: 'Log this title' }).click()
    await page.getByRole('button', { name: 'Save to library' }).click()
    const watched = page.getByRole('checkbox', { name: `Watched ${first}` })
    await watched.click()
    await expect(page.getByText(`Next up · Season 1, episode 2 · ${second}`)).toBeVisible()
    await watched.click()
    await expect(page.getByText(`Next up · Season 1, episode 1 · ${first}`)).toBeVisible()
    await expect(page.getByRole('status')).toHaveText(`${first} marked unwatched.`)
  }
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
  await page.getByRole('button', { name: 'Log Paper Moons' }).click()
  await page.getByRole('button', { name: 'Save to library' }).click()
  await page.getByRole('link', { name: 'Library', exact: true }).click()
  const grid = page.getByRole('list', { name: 'Library titles' })
  await expect(grid.getByRole('link', { name: /Paper Moons/ })).toHaveCount(1)
  await page.getByRole('button', { name: 'Movies', exact: true }).click()
  await expect(grid.getByRole('link', { name: /Paper Moons/ })).toHaveCount(1)
  await page.getByRole('button', { name: 'Anime', exact: true }).click()
  await expect(grid.getByRole('link', { name: /Paper Moons/ })).toHaveCount(1)
})

test('provides a two-column phone gallery, a touch editor, and reflows with larger text', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  await page.goto('/')
  const grid = page.getByRole('list', { name: 'Popular now', exact: true })
  expect(await grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(2)
  await page.getByRole('button', { name: 'Log Paper Moons' }).tap()
  const editor = page.getByRole('dialog')
  const bounds = await editor.boundingBox()
  expect(Math.round((bounds?.y ?? 0) + (bounds?.height ?? 0))).toBe(844)
  await assertAccessible(page)
  await page.getByRole('button', { name: 'Cancel' }).tap()
  await page.addStyleTag({ content: 'html { font-size: 200%; }' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  expect(await grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1)
  await context.close()
})

test('passes accessibility checks in light and dark and disables transitions on request', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('data-motion', 'reduced')
  await assertAccessible(page)
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('radio', { name: 'dark' }).check()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
  await assertAccessible(page)
  await page.getByRole('button', { name: 'Log Northbound' }).click()
  const dialog = page.getByRole('dialog')
  expect(await dialog.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe('0s')
  await assertAccessible(page)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Log Northbound' })).toBeFocused()
})

test('fits the tablet layout and exposes the editor in the accessibility tree', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 })
  await page.goto('/')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(820)
  await page.getByRole('button', { name: 'Log Paper Moons' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toMatchAriaSnapshot(`
    - dialog "Log a title":
      - heading "Log a title" [level=2]
      - button "Close log editor"
      - strong: Paper Moons
      - text: Anime film · 2024
      - group "Status":
        - radio "Planned" [checked]
        - text: Planned
        - radio "In progress"
        - text: In progress
        - radio "Completed"
        - text: Completed
        - radio "Dropped"
        - text: Dropped
      - button "Cancel"
      - button "Save to library"
  `)
})
