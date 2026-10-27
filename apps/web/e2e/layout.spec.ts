import { spawnSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { seedTabs, ServerApi } from './support'

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

test('resizes a split, keeps the size after reload and resets it', async ({ page }) => {
  const first = await api.createSession()
  const second = await api.createSession()
  sessionIds.push(first, second)
  await seedTabs(page, [{ id: 'tab-split', title: 'Split', layout: { kind: 'row' }, panes: [{ sessionId: first }, { sessionId: second }] }])
  await page.goto('/workspaces/tab-split')

  const splitter = page.getByLabel('Resize panes 1 and 2')
  await expect(splitter).toHaveAttribute('aria-valuenow', '50')

  const box = await splitter.boundingBox()
  if (!box) {
    throw new Error('splitter has no box')
  }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 150, y, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => Number(await splitter.getAttribute('aria-valuenow'))).toBeLessThan(45)
  const resized = await splitter.getAttribute('aria-valuenow')

  await page.reload()
  await expect(splitter).toHaveAttribute('aria-valuenow', resized ?? '')

  await page.getByRole('button', { name: 'Reset layout' }).click()
  await expect(splitter).toHaveAttribute('aria-valuenow', '50')
})
