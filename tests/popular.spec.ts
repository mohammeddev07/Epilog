import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('starts on the selected poster and persists the four quick actions', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('list', { name: 'Popular This Week' }).getByRole('link', { name: /The Last Signal/ }).click()
  await expect(page.getByRole('heading', { name: 'Popular This Week' })).toBeFocused()
  await expect(page.getByRole('heading', { name: 'The Last Signal' })).toBeVisible()
  await expect(page.getByText(/2025 · Movie/)).toBeVisible()
  const like = page.getByRole('button', { name: 'Like', exact: true })
  const watchlist = page.getByRole('button', { name: 'Watchlist', exact: true })
  const rate = page.getByRole('button', { name: /^Rate/ })
  await like.click()
  await expect(like).toHaveAttribute('aria-pressed', 'true')
  await watchlist.click()
  await expect(watchlist).toHaveAttribute('aria-pressed', 'true')
  await rate.click()
  const rating = page.getByRole('dialog', { name: 'Rate The Last Signal' })
  await expect(rating.getByRole('button', { name: '1 star', exact: true })).toBeFocused()
  await rating.getByRole('button', { name: '4 stars' }).click()
  await expect(rating).toBeHidden()
  await expect(rate).toHaveText('4/5')
  await expect(rate).toBeFocused()

  await page.getByRole('button', { name: 'Watch', exact: true }).click()
  const editor = page.getByRole('dialog')
  await expect(editor.getByRole('radio', { name: 'Completed' })).toBeChecked()
  await editor.getByLabel('Watch date').fill('2026-11-19')
  await editor.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('button', { name: 'Watched', exact: true })).toBeFocused()
  await expect(watchlist).toHaveAttribute('aria-pressed', 'true')

  await page.reload()
  await expect(page.getByRole('button', { name: 'Watched', exact: true })).toBeVisible()
  await expect(like).toHaveAttribute('aria-pressed', 'true')
  await expect(rate).toHaveText('4/5')
  await page.getByRole('link', { name: 'Library', exact: true }).click()
  await page.getByLabel('Status filter').selectOption('Watchlist')
  await expect(page.getByRole('list', { name: 'Library titles' })).toContainText('The Last Signal')
})

test('browses by a real touch swipe and by keyboard with reduced motion', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce', colorScheme: 'dark',
  })
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:4176/popular')
  const carousel = page.getByRole('region', { name: 'Popular titles' })
  const stage = carousel.getByRole('group', { name: /Poster/ })
  const initial = await carousel.getByRole('heading').textContent()
  const box = (await stage.boundingBox())!
  const x = Math.floor(box.x + box.width * 0.75)
  const y = Math.floor(box.y + box.height * 0.45)
  const cdp = await context.newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 130, y }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect(carousel.getByRole('heading')).not.toHaveText(initial!)
  await stage.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(carousel.getByRole('heading')).toHaveText(initial!)
  await expect(page.locator('.app-shell')).toHaveAttribute('data-motion', 'reduced')
  await expect(carousel.getByRole('group', { name: 'Title actions' })).toBeInViewport()
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.addStyleTag({ content: 'html { font-size: 200%; }' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await context.close()
})

test('moves the poster with the pointer and settles in both directions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/popular?category=Movies')
  const stage = page.getByRole('group', { name: /Poster/ })
  const track = stage.locator('.popular-track')
  const trackX = () => track.evaluate((element) => {
    const transform = getComputedStyle(element).transform
    return transform === 'none' ? 0 : new DOMMatrix(transform).m41
  })
  await expect(stage).toBeVisible()
  const box = (await stage.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width * 0.75, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.25, y, { steps: 5 })
  await expect.poll(trackX).toBeLessThan(-box.width * 0.35)
  expect(await trackX()).toBeGreaterThan(-box.width * 0.75)
  await page.mouse.up()
  await expect(page.getByRole('heading', { name: 'Paper Moons' })).toBeVisible()
  await expect.poll(trackX).toBeCloseTo(-box.width, 0)

  await page.mouse.move(box.x + box.width * 0.25, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 5 })
  await expect.poll(trackX).toBeGreaterThan(-box.width * 0.75)
  await page.mouse.up()
  await expect(page.getByRole('heading', { name: 'The Last Signal' })).toBeVisible()
  await expect.poll(trackX).toBeCloseTo(0, 0)
})
