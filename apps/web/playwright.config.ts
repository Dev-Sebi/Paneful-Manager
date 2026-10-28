import { defineConfig, devices } from '@playwright/test'
import { ACCESS_KEY_STORAGE_KEY, E2E_ACCESS_KEY } from './e2e/access'

const isCI = Boolean(process.env.CI)
/** Real server for e2e; kept off the default port so a running Agent Hub is never touched. */
const SERVER_PORT = '7340'
/** Own Vite instance; a dev server on 3000 proxies to the default port instead. */
const WEB_PORT = 3001
const baseURL = `http://localhost:${WEB_PORT}`

export default defineConfig({
  testDir: './e2e',
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    // Every page starts logged in, as after opening the login URL once.
    storageState: { cookies: [], origins: [{ origin: baseURL, localStorage: [{ name: ACCESS_KEY_STORAGE_KEY, value: E2E_ACCESS_KEY }] }] },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @agent-hub/shared build && pnpm --filter @agent-hub/server build && node e2e/start-server.mjs',
      url: `http://127.0.0.1:${SERVER_PORT}/api/health`,
      env: { AGENT_HUB_PORT: SERVER_PORT, AGENT_HUB_DEV_ORIGINS: baseURL, AGENT_HUB_E2E_ACCESS_KEY: E2E_ACCESS_KEY },
      reuseExistingServer: !isCI,
      timeout: 120_000,
      // The script kills its private tmux server on SIGTERM; the default SIGKILL would leak it.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    },
    {
      command: `pnpm exec vite --port ${WEB_PORT} --strictPort`,
      url: baseURL,
      env: { AGENT_HUB_PORT: SERVER_PORT },
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
  ],
})
