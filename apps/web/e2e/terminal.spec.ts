import type { Locator, Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { E2E_ACCESS_KEY } from './access'

const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0

test.skip(!hasTmux, 'tmux is not installed')

async function lines (rows: Locator): Promise<string[]> {
  const texts = await rows.locator(':scope > div').allInnerTexts()
  return texts.map(text => text.replaceAll(' ', ' ').trimEnd())
}

async function sessionSize (page: Page, id: string) {
  const response = await page.request.get('/api/sessions', { headers: { 'x-agent-hub-key': E2E_ACCESS_KEY } })
  const { sessions } = await response.json() as { sessions: Array<{ id: string, cols: number, rows: number }> }
  return sessions.find(session => session.id === id)
}

test('creates a session, round-trips input and restores it after reload without duplicates', async ({ page }) => {
  await page.goto('/workspaces')
  await page.getByRole('button', { name: 'New session' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Working directory')).toHaveValue('~/')
  await dialog.getByLabel('Command').fill('')
  await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled()
  await dialog.getByLabel('Command').fill('sh')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(/\/workspaces\/tab-/)
  const sessionId = page.url().split('/tab-', 2)[1] ?? ''

  const pane = page.getByRole('group', { name: /^Terminal: / })
  const rows = pane.locator('.xterm-rows')
  await expect(pane.locator('.ah-terminal-pane__overlay')).toHaveCount(0)

  await pane.locator('.xterm').click()
  await page.keyboard.type('echo hello-e2e')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await lines(rows)).filter(line => line === 'hello-e2e').length).toBe(1)

  await page.reload()
  await expect(pane.locator('.ah-terminal-pane__overlay')).toHaveCount(0)
  await expect.poll(async () => (await lines(rows)).filter(line => line === 'hello-e2e').length).toBe(1)
  expect((await lines(rows)).filter(line => line.endsWith('echo hello-e2e'))).toHaveLength(1)

  const before = await sessionSize(page, sessionId)
  await page.setViewportSize({ width: 900, height: 560 })
  await expect.poll(async () => (await sessionSize(page, sessionId))?.cols).not.toBe(before?.cols)

  await pane.locator('.xterm').click()
  await page.keyboard.type('echo again-e2e')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await lines(rows)).filter(line => line === 'again-e2e').length).toBe(1)
})
