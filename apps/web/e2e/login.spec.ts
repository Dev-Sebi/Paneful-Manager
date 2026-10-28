import { expect, test } from '@playwright/test'
import { ACCESS_KEY_STORAGE_KEY, E2E_ACCESS_KEY } from './access'

const HINT = 'Open the login URL once in this browser'

test.use({ storageState: { cookies: [], origins: [] } })

test('without the access key the app shows only the login hint', async ({ page }) => {
  await page.goto('/workspaces')
  await expect(page.getByText(HINT)).toBeVisible()
  await expect(page.getByText('No sessions yet')).toHaveCount(0)
})

test('the login URL stores the key, strips it from the address bar and survives a reload', async ({ page }) => {
  await page.goto(`/#key=${E2E_ACCESS_KEY}`)
  await expect(page).toHaveURL(/\/workspaces$/)
  await expect(page.getByText('No sessions yet')).toBeVisible()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  expect(await page.evaluate(key => localStorage.getItem(key), ACCESS_KEY_STORAGE_KEY)).toBe(E2E_ACCESS_KEY)
  await page.reload()
  await expect(page.getByText('No sessions yet')).toBeVisible()
  await expect(page.getByText(HINT)).toHaveCount(0)
})

test('a wrong key brings the login hint back', async ({ page }) => {
  await page.goto('/#key=not-the-right-key')
  await expect(page.getByText(HINT)).toBeVisible()
})
