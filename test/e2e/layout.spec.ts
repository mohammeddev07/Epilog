import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const widths = [320, 375, 768, 1024, 1440]
const pages = [
  { path: '/', heading: 'Dashboard' },
  { path: '/library', heading: 'Library' },
  { path: '/search', heading: 'Search' },
  { path: '/settings', heading: 'Settings' },
  { path: '/popular', heading: 'Popular This Week' },
  { path: '/title/northbound', heading: 'Northbound' },
  { path: '/title/driftwood-archive', heading: 'Driftwood Archive' }, // no poster art
]

async function expectNoHorizontalScroll(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of colorScheme === 'light' ? widths : [375, 1440]) {
    test(`key pages are accessible and fit at ${width}px (${colorScheme})`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, reducedMotion: 'reduce' })
      const page = await context.newPage()
      for (const { path, heading } of pages) {
        await page.goto(path)
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
        await expectNoHorizontalScroll(page, width)
        const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
        expect(violations, `${path} at ${width}px`).toEqual([])
      }
      await context.close()
    })
  }
}

test('long unbroken titles wrap instead of overflowing at 320px', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const stretch = () => page.evaluate(() => {
    const long = 'Supercalifragilisticexpialidocious'.repeat(3)
    for (const element of document.querySelectorAll('h1, h2, .poster-title, .poster-meta, .popular-film-heading a, .genres li, .status-label')) {
      element.textContent = long
    }
  })
  for (const path of ['/', '/popular', '/title/northbound']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await stretch()
    await expectNoHorizontalScroll(page, 320)
  }
  await context.close()
})

test('fits three to six poster slots without wrapping the Dashboard shelf', async ({ page }) => {
  await page.goto('/')
  const posters = page.getByRole('list', { name: 'Popular This Week' })
  for (const [width, columns] of [[320, 3], [390, 4], [768, 5], [1440, 6]]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => posters.evaluate((grid) => {
      const style = getComputedStyle(grid)
      const gap = Number.parseFloat(style.columnGap)
      const contentWidth = grid.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
      const cardWidth = grid.querySelector('li')!.getBoundingClientRect().width
      return Math.floor((contentWidth + gap + 0.1) / (cardWidth + gap))
    })).toBe(columns)
    expect(await posters.evaluate((grid) => getComputedStyle(grid).gridTemplateRows.split(' ').length)).toBe(1)
  }
})
