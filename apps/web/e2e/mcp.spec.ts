import type { Page, Route } from '@playwright/test'
import { expect, test } from '@playwright/test'

type Json = Record<string, unknown>

const PROJECT = '/work/app'

function initialServers (): Json[] {
  return [
    {
      name: 'files',
      scope: { kind: 'user' },
      source: 'cli',
      config: { transport: 'stdio', command: 'npx', args: ['-y', 'files-server'], env: { API_KEY: { masked: true, set: true } } },
    },
    {
      name: 'docs',
      scope: { kind: 'project', projectPath: PROJECT },
      source: 'file',
      config: { transport: 'http', url: 'https://docs.example.com/mcp', headers: { Authorization: { masked: true, set: true } } },
    },
  ]
}

/** Stateful mock of /api/mcp; records every mutating request body. */
async function mockMcp (page: Page, failUpsert?: { status: number, message: string }) {
  const servers = initialServers()
  const requests: Json[] = []
  await page.route('**/api/scopes', route => route.fulfill({
    json: { scopes: [{ kind: 'global', path: '~/.claude' }, { kind: 'project', path: PROJECT }] },
  }))
  await page.route('**/api/mcp', async (route: Route) => {
    const method = route.request().method()
    if (method === 'GET') {
      return route.fulfill({ json: { servers, mode: 'cli', cliVersion: '2.1.0' } })
    }
    const body = route.request().postDataJSON() as Json
    requests.push(body)
    if (method === 'PUT') {
      if (failUpsert) {
        return route.fulfill({ status: failUpsert.status, json: { code: failUpsert.status === 409 ? 'conflict' : 'bad_request', message: failUpsert.message } })
      }
      const config = body.config as Json
      const keys = Object.entries((config.env ?? config.headers ?? {}) as Json)
      const masked = Object.fromEntries(keys.map(([key]) => [key, { masked: true, set: true }]))
      const stored = { ...body, source: 'cli', config: { ...config, ...(config.transport === 'stdio' ? { env: masked, args: config.args ?? [] } : { headers: masked }) } }
      const index = servers.findIndex(item => item.name === body.name && JSON.stringify(item.scope) === JSON.stringify(body.scope))
      if (index === -1) {
        servers.push(stored)
      } else {
        servers[index] = stored
      }
      return route.fulfill({ json: { server: stored, created: index === -1 } })
    }
    const index = servers.findIndex(item => item.name === body.name && JSON.stringify(item.scope) === JSON.stringify(body.scope))
    servers.splice(index, 1)
    return route.fulfill({ json: { name: body.name, scope: body.scope, removed: true } })
  })
  return requests
}

test('lists servers per scope with transport and source', async ({ page }) => {
  await mockMcp(page)
  await page.goto('/mcp')
  const tree = page.getByRole('navigation', { name: 'MCP servers' })
  await expect(tree.getByRole('button', { name: /files/ })).toContainText('stdio')
  await expect(tree.getByRole('button', { name: /docs/ })).toContainText('http')
  await tree.getByRole('button', { name: /files/ }).click()
  const detail = page.getByRole('article', { name: 'Server files' })
  await expect(detail.getByRole('row', { name: /API_KEY/ })).toContainText('••••')
  await expect(detail.getByRole('row', { name: /API_KEY/ })).toContainText('set')
})

test('adds a stdio server', async ({ page }) => {
  const requests = await mockMcp(page)
  await page.goto('/mcp')
  await page.getByRole('button', { name: 'Add server', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('local-tool')
  await dialog.getByLabel('Command').fill('node')
  await dialog.getByLabel('Arguments').fill('server.js\n--verbose')
  await dialog.getByRole('button', { name: 'Add row' }).click()
  await dialog.getByPlaceholder('Key').fill('TOKEN')
  await dialog.getByPlaceholder('Value').fill('s3cret')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('navigation', { name: 'MCP servers' }).getByRole('button', { name: /local-tool/ })).toBeVisible()
  expect(requests[0]).toEqual({
    name: 'local-tool',
    scope: { kind: 'user' },
    config: { transport: 'stdio', command: 'node', args: ['server.js', '--verbose'], env: { TOKEN: 's3cret' } },
  })
  await expect(page.getByText('s3cret')).toHaveCount(0)
})

test('adds an http server with a header', async ({ page }) => {
  const requests = await mockMcp(page)
  await page.goto('/mcp')
  await page.getByRole('button', { name: 'Add server', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('remote')
  await dialog.getByRole('radio', { name: 'http' }).check()
  await dialog.getByLabel('URL').fill('https://api.example.com/mcp')
  await dialog.getByRole('button', { name: 'Add row' }).click()
  await dialog.getByPlaceholder('Key').fill('Authorization')
  await dialog.getByPlaceholder('Value').fill('Bearer abc')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  expect(requests[0]).toEqual({
    name: 'remote',
    scope: { kind: 'user' },
    config: { transport: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer abc' } },
  })
})

test('editing keeps a masked header', async ({ page }) => {
  const requests = await mockMcp(page)
  await page.goto('/mcp')
  await page.getByRole('navigation', { name: 'MCP servers' }).getByRole('button', { name: /docs/ }).click()
  await page.getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByPlaceholder('unchanged, leave empty to keep')).toHaveValue('')
  await dialog.getByLabel('URL').fill('https://docs.example.com/v2')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  expect(requests[0]).toEqual({
    name: 'docs',
    scope: { kind: 'project', projectPath: PROJECT },
    config: { transport: 'http', url: 'https://docs.example.com/v2', headers: { Authorization: { keep: true } } },
  })
})

test('edit dialog focuses the first editable field and closes on Escape', async ({ page }) => {
  await mockMcp(page)
  await page.goto('/mcp')
  await page.getByRole('navigation', { name: 'MCP servers' }).getByRole('button', { name: /docs/ }).click()
  await page.getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('URL')).toBeFocused()
  await expect(dialog.getByLabel('Name')).toHaveAttribute('readonly', '')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('adds a server from a project section with the scope preselected and selects it', async ({ page }) => {
  const requests = await mockMcp(page)
  await page.goto('/mcp')
  await page.getByRole('button', { name: 'Add server to app Local (private)' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Project')).toBeVisible()
  await dialog.getByLabel('Name').fill('scoped')
  await dialog.getByLabel('Command').fill('node')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  expect(requests[0]).toMatchObject({ name: 'scoped', scope: { kind: 'local', projectPath: PROJECT } })
  await expect(page.getByRole('article', { name: 'Server scoped' })).toBeVisible()
})

test('removes a server after confirmation', async ({ page }) => {
  const requests = await mockMcp(page)
  await page.goto('/mcp')
  const tree = page.getByRole('navigation', { name: 'MCP servers' })
  await tree.getByRole('button', { name: /docs/ }).click()
  await page.getByRole('button', { name: 'Remove' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Remove docs from the project scope (.mcp.json) of /work/app?')
  await expect(dialog).toContainText('OAuth tokens')
  await dialog.getByRole('button', { name: 'Remove' }).click()
  await expect(dialog).toBeHidden()
  await expect(tree.getByRole('button', { name: /docs/ })).toHaveCount(0)
  await expect(tree.getByRole('button', { name: /files/ })).toBeFocused()
  expect(requests[0]).toEqual({ name: 'docs', scope: { kind: 'project', projectPath: PROJECT } })
})

test('rejects a reserved name inline', async ({ page }) => {
  const requests = await mockMcp(page)
  await page.goto('/mcp')
  await page.getByRole('button', { name: 'Add server', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('computer-use')
  await dialog.getByLabel('Command').fill('node')
  await expect(dialog).toContainText('"computer-use" is reserved by Claude Code')
  await dialog.getByRole('button', { name: 'Save' }).click()
  expect(requests).toHaveLength(0)
})

test('shows a server conflict inline', async ({ page }) => {
  await mockMcp(page, { status: 409, message: 'Config file changed on disk' })
  await page.goto('/mcp')
  await page.getByRole('button', { name: 'Add server', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('x')
  await dialog.getByLabel('Command').fill('node')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog.getByRole('alert').filter({ hasText: 'Config file changed on disk' })).toBeVisible()
})
