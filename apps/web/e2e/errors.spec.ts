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
  let posted = false
  const statuses: number[] = []
  await page.route('**/api/presets', async route => {
    if (route.request().method() !== 'POST') {
      return route.continue()
    }
    posted = true
    const response = await route.fetch()
    statuses.push(response.status())
    return route.fulfill({ response })
  })
  await page.route('**/api/session-token', route => posted ? route.continue() : route.fulfill({ json: { token: 'x'.repeat(48) } }))
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
    expect(statuses).toHaveLength(2)
    expect([401, 403]).toContain(statuses[0])
    expect(statuses[1]).toBe(201)
  } finally {
    await api.deletePreset(name)
    await api.dispose()
  }
})
