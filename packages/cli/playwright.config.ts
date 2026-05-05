import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 180_000,
  use: {
    baseURL: 'http://localhost:25173',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
  // No webServer — global setup boots `runDev` so we exercise the real
  // orchestrator. Playwright's webServer would re-run npm/build steps.
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
