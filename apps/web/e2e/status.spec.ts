import { spawnSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { postHook, seedTabs, ServerApi } from './support'

const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0

test.skip(!hasTmux, 'tmux is not installed')

let api: ServerApi
const sessionIds: string[] = []

test.beforeAll(async () => {
  api = await ServerApi.create()
})

test.afterEach(async () => {
  for (const id of sessionIds.splice(0)) {
    await api.killSession(id)
  }
})

test.afterAll(async () => {
  await api.dispose()
})

test('hook events move the pane status badge', async ({ page }) => {
  const id = await api.createSession()
  sessionIds.push(id)
  await seedTabs(page, [{ id: 'tab-status', title: 'Status', layout: { kind: 'single' }, panes: [{ sessionId: id }] }])
  await page.goto('/workspaces/tab-status')
  const pane = page.getByRole('group', { name: /^Terminal: / })

  for (const [event, label] of [
    ['PermissionRequest', 'Waiting for input'],
    ['UserPromptSubmit', 'Working'],
    ['Stop', 'Idle'],
  ] as const) {
    expect(await postHook(id, event)).toBe(204)
    await expect(pane.getByRole('img', { name: label })).toBeVisible()
  }
})
