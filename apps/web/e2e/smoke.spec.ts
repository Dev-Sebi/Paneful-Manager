import { expect, test } from '@playwright/test'

const SECTIONS = [
  { name: 'Skills', path: '/skills' },
  { name: 'CLAUDE.md', path: '/claude-md' },
  { name: 'MCP', path: '/mcp' },
  { name: 'Settings', path: '/settings' },
  { name: 'Workspaces', path: '/workspaces' },
]

test('app loads and redirects to workspaces with its empty state', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/workspaces$/)
  await expect(page).toHaveTitle('Workspaces - Paneful Manager')
  await expect(page.getByText('No sessions yet')).toBeVisible()
  await expect(page.getByRole('button', { name: 'New preset' })).toBeVisible()
})

test('navigates through every section via the sidebar', async ({ page }) => {
  await page.goto('/')
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  for (const section of SECTIONS) {
    await nav.getByRole('link', { name: section.name }).click()
    await expect(page).toHaveURL(new RegExp(`${section.path}$`))
  }
})

test('Ctrl+2 switches to skills', async ({ page }) => {
  await page.goto('/workspaces')
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await page.keyboard.press('Control+2')
  await expect(page).toHaveURL(/\/skills$/)
})

test('rail toggle persists after reload', async ({ page }) => {
  await page.goto('/workspaces')
  const drawer = page.locator('.v-navigation-drawer')
  await expect(drawer).not.toHaveClass(/v-navigation-drawer--rail/)
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await expect(drawer).toHaveClass(/v-navigation-drawer--rail/)
  await page.reload()
  await expect(drawer).toHaveClass(/v-navigation-drawer--rail/)
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible()
})

test('theme choice persists after reload', async ({ page }) => {
  await page.goto('/workspaces')
  await page.getByRole('button', { name: 'Light theme' }).click()
  await expect(page.locator('.v-application')).toHaveClass(/v-theme--light/)
  await page.reload()
  await expect(page.locator('.v-application')).toHaveClass(/v-theme--light/)
})

test('unknown paths show the 404 view', async ({ page }) => {
  await page.goto('/no/such/page')
  await expect(page.getByText('Page not found')).toBeVisible()
  await page.getByRole('button', { name: 'Go to Workspaces' }).click()
  await expect(page).toHaveURL(/\/workspaces$/)
})

test('teams route redirects with a snackbar when the flag is off', async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({
    json: { config: { port: 7337, experimental: { agentTeams: false }, confirmCloseTab: true, projects: [], logLevel: 'info', theme: 'dark' } },
  }))
  await page.goto('/teams')
  await expect(page).toHaveURL(/\/workspaces$/)
  await expect(page.getByText('Agent teams are disabled')).toBeVisible()
})
