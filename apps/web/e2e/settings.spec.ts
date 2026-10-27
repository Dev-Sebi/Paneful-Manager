import { expect, test } from '@playwright/test'
import { ServerApi } from './support'

test('persists the close-tab confirmation and the theme across reloads', async ({ page }) => {
  const api = await ServerApi.create()
  const toggle = page.getByRole('checkbox', { name: 'Confirm before closing a tab' })
  try {
    await page.goto('/settings')
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await page.getByRole('button', { name: 'Light theme' }).click()
    await expect(page.getByRole('button', { name: 'Light theme' })).toHaveAttribute('aria-pressed', 'true')

    await page.reload()
    await expect(toggle).not.toBeChecked()
    await expect(page.getByRole('button', { name: 'Light theme' })).toHaveAttribute('aria-pressed', 'true')
  } finally {
    await api.patchConfig({ confirmCloseTab: true })
    await api.dispose()
  }
})
