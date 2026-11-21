import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const day = Date.UTC(2026, 10, 18)
const row = (id: string, format: string, anime: boolean, status: string, extra = {}) => ({
  media: { id, format, anime }, status, createdAt: day, updatedAt: day, completions: [], episodes: [], ...extra,
})

async function restore(page: Page, entries: unknown[]) {
  await page.goto('/settings')
  await page.getByLabel('Epilog backup file').setInputFiles({
    name: 'library.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'epilog-library', version: 2, entries })),
  })
  await page.getByRole('button', { name: 'Restore backup', exact: true }).click()
  await expect(page.getByText('Backup restored.').first()).toBeAttached()
}

test('shares a library by link, compares taste, logs a pick, and sends a link back', async ({ page, browser }) => {
  await restore(page, [
    row('the-last-signal', 'MOVIE', false, 'Completed', { rating: 5, completions: [{ id: 'c1', date: '2026-11-12' }] }),
    row('paper-moons', 'MOVIE', true, 'Completed', { rating: 4 }),
    row('starlight-courier', 'GAME', false, 'In progress'),
  ])
  await page.getByRole('link', { name: 'Library', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Library sections' })).toContainText('2 watched')
  await page.getByRole('button', { name: 'Share and compare' }).click()
  const sheet = page.getByRole('dialog', { name: 'Share your library' })
  await sheet.getByLabel('Your name').fill('Sam')
  await expect(sheet.getByLabel('Share link')).toHaveValue(/\/compare#p=[\w-]+$/)
  await expect(sheet).toContainText('The link holds the 3 titles')
  const link = new URL(await sheet.getByLabel('Share link').inputValue())

  const friend = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', reducedMotion: 'reduce' })
  const other = await friend.newPage()
  try {
    await restore(other, [row('the-last-signal', 'MOVIE', false, 'Completed', { rating: 5 })])
    await other.goto(link.pathname + link.hash)
    await expect(other.getByRole('heading', { level: 1, name: 'Sam’s library' })).toBeVisible() // a fresh page load: focus stays at the document start
    await expect(other.locator('.compare-figure strong')).toHaveText('100%')
    const picks = other.getByRole('list', { name: 'Picks you haven’t seen' })
    await expect(picks.getByRole('link')).toHaveText([/Paper Moons/, /Starlight Courier/]) // rated picks first
    await expect(other.getByRole('list', { name: 'Both seen' }).getByRole('link')).toHaveText([/The Last Signal/])
    expect((await new AxeBuilder({ page: other }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])

    await picks.getByRole('button', { name: 'Log Paper Moons' }).click()
    await other.getByRole('dialog').getByRole('button', { name: 'Save to library' }).click()
    await expect(picks.getByRole('button', { name: 'Open saved entry for Paper Moons' })).toBeVisible()

    await other.getByRole('button', { name: 'Send yours back' }).click()
    await expect(other.getByRole('dialog', { name: 'Share your library' }).getByLabel('Share link')).toHaveValue(/\/compare#p=/)
  } finally {
    await friend.close()
  }

  await page.goto('/compare#p=AAAA')
  await expect(page.getByRole('heading', { level: 1, name: 'Link not valid' })).toBeVisible()
})
