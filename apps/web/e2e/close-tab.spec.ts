import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const CONFIG = { port: 7337, experimental: { agentTeams: false }, confirmCloseTab: true, projects: [], logLevel: 'info', theme: 'dark' }
const TABS_KEY = 'paneful-manager.tabs.v1'
const NOW = '2026-01-01T00:00:00.000Z'

function session (id: string) {
  return {
    id, hostId: 'local', title: `Session ${id}`, cwd: '/work', command: 'claude', args: [], tmuxSession: `pm-${id}`,
    createdAt: NOW, state: 'idle', lifecycle: 'running', lastEventAt: NOW, cols: 80, rows: 24,
  }
}

function tab (id: string) {
  return { id, title: `Tab ${id}`, layout: { kind: 'single' }, panes: [{ sessionId: `s-${id}` }] }
}

async function mockApi (page: Page) {
  const deletes: string[] = []
  const patches: unknown[] = []
  await page.route('**/api/config', async route => {
    if (route.request().method() === 'PATCH') {
      const patch = route.request().postDataJSON() as object
      patches.push(patch)
      return route.fulfill({ json: { config: { ...CONFIG, ...patch }, restartRequired: false } })
    }
    return route.fulfill({ json: { config: CONFIG } })
  })
  await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [session('s-a'), session('s-b')] } }))
  await page.route('**/api/sessions/*', route => {
    deletes.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.fulfill({ json: { id: 'x', killed: true } })
  })
  await page.route('**/api/session-token', route => route.fulfill({ json: { token: 'test-token' } }))
  await page.addInitScript(([key, value]) => {
    if (!localStorage.getItem(key as string)) {
      localStorage.setItem(key as string, value as string)
    }
  }, [TABS_KEY, JSON.stringify({ tabs: [tab('a'), tab('b')], activeId: 'a' })])
  return { deletes, patches }
}

async function closeTab (page: Page, title: string) {
  await page.getByRole('tab', { name: new RegExp(`^${title}`) }).press('Delete')
}

test('closing asks first and cancel keeps the tab', async ({ page }) => {
  const { deletes } = await mockApi(page)
  await page.goto('/workspaces')
  await closeTab(page, 'Tab a')
  const dialog = page.getByRole('alertdialog', { name: 'Close tab?' })
  await expect(dialog).toContainText('Session s-a')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('tab', { name: /Tab a/ })).toBeVisible()
  expect(deletes).toEqual([])
})

test('confirming kills the sessions and removes the tab', async ({ page }) => {
  const { deletes, patches } = await mockApi(page)
  await page.goto('/workspaces')
  await closeTab(page, 'Tab a')
  await page.getByRole('button', { name: 'Close and kill sessions' }).click()
  await expect(page.getByRole('tab', { name: /Tab a/ })).toHaveCount(0)
  expect(deletes).toEqual(['DELETE /api/sessions/s-a'])
  expect(patches).toEqual([])
})

test('dont-ask-again sends a PATCH and the next close is silent', async ({ page }) => {
  const { deletes, patches } = await mockApi(page)
  await page.goto('/workspaces')
  await closeTab(page, 'Tab a')
  await page.getByLabel('Don\'t ask again').check()
  await page.getByRole('button', { name: 'Close and kill sessions' }).click()
  await expect(page.getByRole('tab', { name: /Tab a/ })).toHaveCount(0)
  expect(patches).toEqual([{ confirmCloseTab: false }])
  await closeTab(page, 'Tab b')
  await expect(page.getByRole('tab', { name: /Tab b/ })).toHaveCount(0)
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(deletes).toEqual(['DELETE /api/sessions/s-a', 'DELETE /api/sessions/s-b'])
})

test('reloading shows no dialog and kills nothing', async ({ page }) => {
  const { deletes } = await mockApi(page)
  await page.goto('/workspaces')
  await expect(page.getByRole('tab', { name: /Tab a/ })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('tab', { name: /Tab a/ })).toBeVisible()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(deletes).toEqual([])
})
