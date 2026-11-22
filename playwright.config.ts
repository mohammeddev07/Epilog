import { defineConfig, devices } from '@playwright/test'

const url = 'http://127.0.0.1:4176'

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  use: { baseURL: url, trace: 'retain-on-failure' },
  webServer: [{
    command: 'npm run dev:ui -- --host 127.0.0.1 --port 4176 --strictPort',
    url,
  }, {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4178 --strictPort',
    url: 'http://127.0.0.1:4178',
  }],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
