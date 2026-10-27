import { expect, test } from '@playwright/test'

test('button variants and sizes are styled', async ({ page }) => {
  await page.goto('/')
  const primary = page.getByRole('button', { name: 'primary md' })
  await expect(primary).toBeVisible()
  await expect(primary).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

  const heights: number[] = []
  for (const size of ['sm', 'md', 'lg']) {
    const box = await page.getByRole('button', { name: `secondary ${size}` }).boundingBox()
    heights.push(Math.round(box?.height ?? 0))
  }
  expect(new Set(heights).size).toBe(3)
})
