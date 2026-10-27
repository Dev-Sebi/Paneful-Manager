import { expect, test } from '@playwright/test'

test('app loads with the expected title', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('Agent Hub')
})
