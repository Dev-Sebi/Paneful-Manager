import { expect, test } from '@playwright/test'
import { LEGACY_ACCESS_KEY_STORAGE_KEY } from './access'
import { createLoginCode, resetDevices } from './support'

const HINT = 'Open a login URL in this browser'
const USED = 'This login URL was already used or has expired'

// These pages log in like a real browser: no access key header, only the device login.
test.use({ extraHTTPHeaders: {} })
// Each test writes the single pending login code of the shared server.
test.describe.configure({ mode: 'serial' })

test('without a login the app shows only the login hint', async ({ page }) => {
  await page.goto('/workspaces')
  await expect(page.getByText(HINT)).toBeVisible()
  await expect(page.getByText('No sessions yet')).toHaveCount(0)
})

test('the login URL registers this browser, keeps no secret in localStorage and survives a reload', async ({ page }) => {
  await page.goto(`/#login=${createLoginCode()}`)
  await expect(page).toHaveURL(/\/workspaces$/)
  await expect(page.getByText('No sessions yet')).toBeVisible()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.includes('access-key')))).toEqual([])
  // A string, because the e2e tsconfig has no DOM types.
  const extractable = await page.evaluate<boolean | undefined>(`new Promise(resolve => {
    const open = indexedDB.open('paneful-manager')
    open.onsuccess = () => {
      const get = open.result.transaction('device').objectStore('device').get('current')
      get.onsuccess = () => resolve(get.result?.privateKey?.extractable)
    }
  })`)
  expect(extractable).toBe(false)
  await page.reload()
  await expect(page.getByText('No sessions yet')).toBeVisible()
  await expect(page.getByText(HINT)).toHaveCount(0)
})

test('a login URL works once', async ({ browser }) => {
  const code = createLoginCode()
  const options = { baseURL: test.info().project.use.baseURL }
  const first = await browser.newPage(options)
  await first.goto(`/#login=${code}`)
  await expect(first.getByText('No sessions yet')).toBeVisible()
  const second = await browser.newPage(options)
  await second.goto(`/#login=${code}`)
  await expect(second.getByText(USED)).toBeVisible()
  await first.close()
  await second.close()
})

test('a wrong code brings the login hint back', async ({ page }) => {
  await page.goto(`/#login=${'x'.repeat(43)}`)
  await expect(page.getByText(USED)).toBeVisible()
})

test('logging every browser out brings the hint back on the next load', async ({ page }) => {
  await page.goto(`/#login=${createLoginCode()}`)
  await expect(page.getByText('No sessions yet')).toBeVisible()
  resetDevices()
  await page.reload()
  await expect(page.getByText(HINT)).toBeVisible()
})

test('the access key an older build stored is deleted', async ({ page }) => {
  await page.addInitScript(key => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem(key, 'old-access-key')
    }
  }, LEGACY_ACCESS_KEY_STORAGE_KEY)
  await page.goto('/workspaces')
  await expect(page.getByText(HINT)).toBeVisible()
  expect(await page.evaluate(key => localStorage.getItem(key), LEGACY_ACCESS_KEY_STORAGE_KEY)).toBeNull()
})
