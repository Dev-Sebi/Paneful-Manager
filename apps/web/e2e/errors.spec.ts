import { expect, test } from '@playwright/test'
import { ServerApi } from './support'

test('shows a disconnected badge while the server is unreachable and recovers', async ({ page }) => {
  await page.route('**/api/session-token', route => route.abort())
  await page.goto('/workspaces')
  await expect(page.getByText('Disconnected')).toBeVisible()

  await page.unroute('**/api/session-token')
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 20_000 })
})

test('recovers from a rejected session token by fetching a fresh one', async ({ page }) => {
  const api = await ServerApi.create()
  const name = `e2e-token-${Date.now()}`
  let served = 0
  await page.route('**/api/session-token', route => {
    served += 1
    return served === 1 ? route.fulfill({ json: { token: 'x'.repeat(48) } }) : route.continue()
  })
  try {
    await page.goto('/workspaces')
    await page.getByRole('button', { name: 'New preset' }).click()
    const dialog = page.getByRole('dialog', { name: 'New preset' })
    await dialog.getByLabel('Name').fill(name)
    await dialog.getByLabel('Working directory').fill('~/')
    await dialog.getByLabel('Command').fill('sh')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('listitem').filter({ hasText: name })).toBeVisible()
    expect(served).toBeGreaterThan(1)
  } finally {
    await api.deletePreset(name)
    await api.dispose()
  }
})
