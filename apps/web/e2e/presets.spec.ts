import { spawnSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { ServerApi } from './support'

const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0

test.skip(!hasTmux, 'tmux is not installed')

let api: ServerApi
const sessionIds: string[] = []
const presetNames: string[] = []

test.beforeAll(async () => {
  api = await ServerApi.create()
})

test.afterEach(async () => {
  for (const id of sessionIds.splice(0)) {
    await api.killSession(id)
  }
  for (const name of presetNames.splice(0)) {
    await api.deletePreset(name)
  }
})

test.afterAll(async () => {
  await api.dispose()
})

test('creates, launches, edits and deletes a preset', async ({ page }) => {
  const name = `e2e-preset-${Date.now()}`
  presetNames.push(name)
  await page.goto('/workspaces')
  await page.getByRole('button', { name: 'New preset' }).click()
  const dialog = page.getByRole('dialog', { name: 'New preset' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('Description').fill('Two shells')
  await dialog.getByLabel('Tab title').fill('Shells')
  await dialog.getByLabel('Working directory').fill('~/')
  await dialog.getByLabel('Command').fill('sh')
  await dialog.getByRole('button', { name: 'Add pane' }).click()
  await dialog.getByLabel('Working directory').nth(1).fill('~/')
  await dialog.getByLabel('Command').nth(1).fill('sh')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()

  const item = page.getByRole('listitem').filter({ hasText: name })
  await expect(item).toContainText('Two shells')

  const launched = page.waitForResponse(response => response.url().endsWith(`/api/presets/${name}/launch`))
  await item.getByRole('button', { name: `Launch ${name}` }).click()
  const body = await (await launched).json() as { tabs: Array<{ panes: Array<{ sessionId: string }> }> }
  sessionIds.push(...body.tabs.flatMap(tab => tab.panes.map(pane => pane.sessionId)))
  await expect(page).toHaveURL(/\/workspaces\/tab-/)
  await expect(page.getByRole('tab', { name: /^Shells/ })).toBeVisible()
  await expect(page.getByRole('group', { name: /^Terminal: / })).toHaveCount(2)
  await expect(page.getByLabel('Resize panes 1 and 2')).toHaveCount(1)

  await page.getByRole('button', { name: 'Presets' }).click()
  const row = page.getByRole('dialog', { name: 'Presets' }).getByRole('listitem').filter({ hasText: name })
  await row.getByRole('button', { name: `Edit ${name}` }).click()
  const edit = page.getByRole('dialog', { name: `Edit preset ${name}` })
  await expect(edit.getByLabel('Name')).toBeDisabled()
  await edit.getByLabel('Description').fill('Updated shells')
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(edit).toBeHidden()
  await expect(row).toContainText('Updated shells')
  await expect.poll(async () => (await api.listPresets()).some(preset => preset.name === name)).toBe(true)

  await row.getByRole('button', { name: `Delete ${name}` }).click()
  const confirm = page.getByRole('alertdialog', { name: `Delete preset ${name}?` })
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(row).toHaveCount(0)
  await expect.poll(async () => (await api.listPresets()).some(preset => preset.name === name)).toBe(false)
})
