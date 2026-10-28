import { expect, type Page, test } from '@playwright/test'

function config (agentTeams: boolean) {
  return {
    config: { port: 7337, experimental: { agentTeams }, confirmCloseTab: true, projects: [], logLevel: 'info', theme: 'dark' },
  }
}

const NOW = new Date().toISOString()

const board = {
  enabled: true,
  warnings: ['session-1a2b3c4d/7.json: invalid JSON, skipped'],
  teams: [
    {
      name: 'session-1a2b3c4d',
      members: [{ name: 'lead', agentType: 'team-lead' }, { name: 'tester' }],
      lastUpdated: NOW,
      tasks: [
        { id: '1', subject: 'Set up fixtures', status: 'completed', blocks: ['2'], blockedBy: [], blocked: false },
        { id: '2', subject: 'Write parser tests', status: 'in_progress', owner: 'tester', activeForm: 'Writing parser tests', description: 'Cover malformed files', blocks: ['3'], blockedBy: [], blocked: false },
        { id: '3', subject: 'Review results', status: 'pending', blocks: [], blockedBy: ['2'], blocked: true },
      ],
    },
  ],
}

async function mockApi (page: Page, agentTeams: boolean, teams: unknown) {
  await page.route('**/api/config', route => route.fulfill({ json: config(agentTeams) }))
  await page.route('**/api/team-templates', route => route.fulfill({ json: { templates: [], launches: [] } }))
  await page.route('**/api/teams', route => route.fulfill({ json: teams }))
}

test('shows the empty state with a settings link when the server reports the flag off', async ({ page }) => {
  await mockApi(page, true, { enabled: false, teams: [], warnings: [] })
  await page.goto('/teams')
  await expect(page.getByText('experimental.agentTeams')).toBeVisible()
  await page.getByRole('button', { name: 'Open settings' }).click()
  await expect(page).toHaveURL(/\/settings$/)
})

test('shows the board with a blocked task and the warnings strip', async ({ page }) => {
  await mockApi(page, true, board)
  await page.goto('/teams')
  await expect(page.getByRole('heading', { name: 'session-1a2b3c4d' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /^In progress/ })).toBeVisible()
  const blocked = page.getByTestId('task-3')
  await expect(blocked).toContainText('Blocked by #2')
  await expect(page.getByTestId('task-2')).toContainText('Writing parser tests')
  await expect(page.getByRole('alert')).toContainText('invalid JSON, skipped')
  await page.getByTestId('task-2').getByRole('button', { name: 'Show description' }).click()
  await expect(page.getByText('Cover malformed files')).toBeVisible()
})
