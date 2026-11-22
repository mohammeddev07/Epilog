/* global document, window, requestAnimationFrame, PerformanceObserver, Navigator */
import process from 'node:process'
import { URL } from 'node:url'
// Capture the same four interactions in isolated desktop and touch profiles.
// Usage: node scripts/record-motion.mjs <demo build directory> <output directory>
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { expect } from '@playwright/test'

const [buildDir, outputDir] = process.argv.slice(2)
if (!buildDir || !outputDir) throw new Error('Pass a demo build directory and an output directory.')
await mkdir(outputDir, { recursive: true })
const browser = await chromium.launch()
const samples = []

try {
  for (const phone of [false, true]) {
    const viewport = phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }
    for (const action of ['watch', 'watchlist', 'appearance', 'detail']) {
      const name = (phone ? 'phone-' : 'desktop-') + action
      const context = await browser.newContext({
        viewport, isMobile: phone, hasTouch: phone, colorScheme: 'light',
        serviceWorkers: 'block', recordVideo: { dir: outputDir, size: viewport },
      })
      // Serve the compiled demo from disk. No catalog or personal library is involved.
      await context.route('http://localhost/**', (route) => {
        const pathname = new URL(route.request().url()).pathname
        return route.fulfill({ path: path.join(buildDir, path.extname(pathname) ? pathname : 'index.html') })
      })
      await context.addInitScript(() => { delete Navigator.prototype.serviceWorker })
      const page = await context.newPage()
      const activate = (control) => phone ? control.tap() : control.click()
      const button = (name) => page.getByRole('button', { name, exact: true })
      await page.goto('http://localhost/' + (action === 'appearance' ? 'settings' : 'popular'))
      await page.getByRole('heading', { level: 1 }).waitFor()
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(550)
      // Sample frame intervals and all layout shifts, including those following input.
      await page.evaluate(() => {
        const sample = { frames: [], shifts: [] }
        window.motionSample = sample
        let previous
        function frame(now) {
          if (previous !== undefined) sample.frames.push(now - previous)
          previous = now
          requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
        new PerformanceObserver((list) => {
          sample.shifts.push(...list.getEntries().map(({ value, hadRecentInput }) => ({ value, hadRecentInput })))
        }).observe({ type: 'layout-shift' })
      })
      if (action === 'watch') {
        const watch = button('Watch')
        await watch.scrollIntoViewIfNeeded()
        const bounds = await watch.boundingBox()
        const x = bounds.x + bounds.width / 2
        const y = bounds.y + bounds.height / 2
        if (phone) {
          const touch = await context.newCDPSession(page)
          await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
          await expect(page.getByRole('dialog')).toBeVisible()
          await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          await touch.detach()
        } else {
          await page.mouse.move(x, y)
          await page.mouse.down()
          await expect(page.getByRole('dialog')).toBeVisible()
          await page.mouse.up()
        }
        await activate(button('Cancel'))
        await expect(watch).toBeFocused()
        await page.waitForTimeout(450)
        await activate(watch)
        await expect(button('Watched')).toBeVisible()
      } else if (action === 'watchlist') {
        const bookmark = button('Watchlist')
        await activate(bookmark)
        await expect(bookmark).toHaveAttribute('aria-pressed', 'true')
        await page.waitForTimeout(650)
        await activate(bookmark)
        await expect(bookmark).toHaveAttribute('aria-pressed', 'false')
      } else if (action === 'appearance') {
        for (const name of ['dark', 'light', 'system']) {
          const radio = page.getByRole('radio', { name, exact: true })
          await activate(radio)
          await expect(radio).toBeChecked()
          await page.waitForTimeout(450)
        }
      } else {
        const title = page.getByRole('link', { name: 'The Last Signal', exact: true })
        await activate(title)
        await expect(page.getByRole('heading', { level: 1, name: 'The Last Signal' })).toBeVisible()
        await page.waitForTimeout(750)
        await activate(button('Back'))
        await expect(title).toBeFocused()
      }
      await page.waitForTimeout(650)
      const { frames, shifts } = await page.evaluate(() => window.motionSample)
      const timings = frames.toSorted((a, b) => a - b)
      samples.push({ name, frames: frames.length, p95FrameMs: timings[Math.floor(timings.length * 0.95)],
        intervalsOver33ms: frames.filter((ms) => ms > 33.4).length, shifts })
      const video = page.video()
      await context.close()
      await video.saveAs(path.join(outputDir, name + '.webm'))
      await video.delete()
    }
  }
  await writeFile(path.join(outputDir, 'frames.json'), JSON.stringify(samples, null, 2))
} finally {
  await browser.close()
}
