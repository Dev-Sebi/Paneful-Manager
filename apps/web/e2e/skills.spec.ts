import type { Page, Request } from '@playwright/test'
import { expect, test } from '@playwright/test'

interface Scope {
  kind: 'global' | 'project' | 'worktree'
  path: string
  branch?: string
  projectPath?: string
}

interface StoredFile {
  scope: Scope
  kind: 'skill' | 'claude-md' | 'claude-local-md'
  relPath: string
  name: string
  content: string
  version: number
}

const GLOBAL: Scope = { kind: 'global', path: '~/.claude' }
const PROJECT: Scope = { kind: 'project', path: '~/git/project1' }
const WORKTREE: Scope = { kind: 'worktree', path: '~/git/project1/.claude/worktrees/feat-x', branch: 'feat/x', projectPath: '~/git/project1' }

const DEMO_SKILL = '---\nname: demo\ndescription: Demo skill\n---\n\nHello\n'

function hashOf (file: StoredFile): string {
  return String(file.version).padStart(64, '0')
}

function pathOf (file: StoredFile): string {
  return `${file.scope.path}/${file.kind === 'skill' ? `skills/${file.name}/${file.relPath.split('/').at(-1)}` : file.relPath}`
}

function entryOf (file: StoredFile) {
  const { content: _content, version: _version, ...rest } = file
  return { ...rest, path: pathOf(file), size: file.content.length, mtimeMs: 1, hash: hashOf(file) }
}

interface Backend {
  files: StoredFile[]
  writes: Array<{ path: string, content: string, expectedHash?: string }>
  deletes: string[]
}

async function mockApi (page: Page): Promise<Backend> {
  const backend: Backend = {
    files: [
      { scope: GLOBAL, kind: 'skill', relPath: '.claude/skills/demo/SKILL.md', name: 'demo', content: DEMO_SKILL, version: 1 },
      { scope: WORKTREE, kind: 'skill', relPath: '.claude/skills/wt-skill/SKILL.md', name: 'wt-skill', content: '---\nname: wt-skill\ndescription: x\n---\n', version: 1 },
      { scope: GLOBAL, kind: 'claude-md', relPath: 'CLAUDE.md', name: 'CLAUDE.md', content: '# Global\n', version: 1 },
    ],
    writes: [],
    deletes: [],
  }
  const find = (path: string) => backend.files.find(file => pathOf(file) === path)

  await page.route('**/api/session-token', route => route.fulfill({ json: { token: 'test-token' } }))
  await page.route('**/api/scopes', route => route.fulfill({ json: { scopes: [GLOBAL, PROJECT, WORKTREE] } }))
  await page.route(/\/api\/files(\/content)?(\?.*)?$/, async route => {
    const request: Request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const path = url.searchParams.get('path') ?? ''
    if (url.pathname.endsWith('/content')) {
      const file = find(method === 'PUT' ? (request.postDataJSON() as { path: string }).path : path)
      if (method === 'GET') {
        return file ? route.fulfill({ json: { file: { ...entryOf(file), content: file.content } } }) : route.fulfill({ status: 404, json: { code: 'not_found', message: 'File not found' } })
      }
      if (method === 'PUT' && file) {
        const body = request.postDataJSON() as { path: string, content: string, expectedHash?: string }
        backend.writes.push(body)
        if (body.expectedHash !== hashOf(file)) {
          return route.fulfill({ status: 409, json: { code: 'conflict', message: 'changed', details: { currentHash: hashOf(file) } } })
        }
        file.content = body.content
        file.version += 1
        return route.fulfill({ json: { file: entryOf(file) } })
      }
      if (method === 'DELETE') {
        backend.deletes.push(path)
        backend.files = backend.files.filter(item => !pathOf(item).startsWith(path))
        return route.fulfill({ json: { path, deleted: true } })
      }
    }
    if (method === 'POST') {
      const body = request.postDataJSON() as { scopePath: string, kind: StoredFile['kind'], name?: string }
      const scope = [GLOBAL, PROJECT, WORKTREE].find(item => item.path === body.scopePath) ?? GLOBAL
      const created: StoredFile = body.kind === 'skill'
        ? { scope, kind: 'skill', relPath: `.claude/skills/${body.name}/SKILL.md`, name: body.name ?? '', content: `---\nname: ${body.name}\ndescription: Describe it.\n---\n`, version: 1 }
        : { scope, kind: body.kind, relPath: body.kind === 'claude-md' ? 'CLAUDE.md' : 'CLAUDE.local.md', name: 'CLAUDE.md', content: '', version: 1 }
      backend.files.push(created)
      return route.fulfill({ status: 201, json: { file: { ...entryOf(created), content: created.content } } })
    }
    return route.fulfill({ json: { files: backend.files.map(file => entryOf(file)) } })
  })
  return backend
}

async function typeInEditor (page: Page, text: string) {
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(text)
}

test('lists scopes with the branch badge and their skills', async ({ page }) => {
  await mockApi(page)
  await page.goto('/skills')
  const tree = page.getByRole('navigation', { name: 'Scopes' })
  await expect(tree.getByText('Global', { exact: true })).toBeVisible()
  await expect(tree.getByText('project1', { exact: true })).toBeVisible()
  await expect(tree.getByText('feat/x')).toBeVisible()
  await expect(tree.getByText('demo', { exact: true })).toBeVisible()
  await expect(tree.getByText('wt-skill', { exact: true })).toBeVisible()
  await expect(page.getByText('Select a skill file or create a new skill')).toBeVisible()
})

test('opens a skill, edits it and saves with the expected hash', async ({ page }) => {
  const backend = await mockApi(page)
  await page.goto('/skills')
  await page.getByRole('navigation', { name: 'Scopes' }).getByRole('button', { name: 'SKILL.md' }).first().click()
  await expect(page.getByRole('region', { name: 'Frontmatter preview' })).toContainText('Demo skill')
  const save = page.getByRole('button', { name: 'Save' })
  await expect(save).toBeDisabled()

  await typeInEditor(page, 'extra line')
  await expect(page.getByRole('img', { name: 'Unsaved changes' })).toBeVisible()
  await expect(save).toBeEnabled()
  await page.keyboard.press('Control+s')

  await expect(page.getByRole('img', { name: 'Unsaved changes' })).toBeHidden()
  expect(backend.writes).toHaveLength(1)
  expect(backend.writes[0]?.expectedHash).toBe('0'.repeat(63) + '1')
  expect(backend.writes[0]?.content).toContain('extra line')
})

test('creates a skill from the dialog and validates the name', async ({ page }) => {
  const backend = await mockApi(page)
  await page.goto('/skills')
  await page.getByRole('button', { name: 'New skill' }).click()
  const dialog = page.getByRole('dialog', { name: 'New skill' })
  await dialog.getByLabel('Name').fill('../bad')
  await dialog.getByRole('button', { name: 'Create skill' }).click()
  await expect(dialog.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true')

  await dialog.getByLabel('Name').fill('fresh-skill')
  await dialog.getByLabel('Scope').selectOption({ label: 'project1 (project)' })
  await dialog.getByRole('button', { name: 'Create skill' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('navigation', { name: 'Scopes' }).getByText('fresh-skill', { exact: true })).toBeVisible()
  await expect(page.locator('.file-pane__path')).toHaveText('.claude/skills/fresh-skill/SKILL.md')
  expect(backend.files.some(file => file.name === 'fresh-skill' && file.scope.path === PROJECT.path)).toBe(true)
})

test('deletes a skill after confirming', async ({ page }) => {
  const backend = await mockApi(page)
  await page.goto('/skills')
  await page.getByRole('navigation', { name: 'Scopes' }).getByRole('button', { name: 'SKILL.md' }).first().click()
  const paneDelete = page.locator('.file-pane__actions').getByRole('button', { name: 'Delete' })
  await paneDelete.click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete skill "demo"?' })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect(backend.deletes).toHaveLength(0)

  await paneDelete.click()
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByText('Select a skill file or create a new skill')).toBeVisible()
  expect(backend.deletes).toEqual(['~/.claude/skills/demo'])
})

test('asks before leaving with unsaved changes', async ({ page }) => {
  await mockApi(page)
  await page.goto('/skills')
  await page.getByRole('navigation', { name: 'Scopes' }).getByRole('button', { name: 'SKILL.md' }).first().click()
  await typeInEditor(page, 'x')
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'CLAUDE.md' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Unsaved changes' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Keep editing' }).click()
  await expect(page).toHaveURL(/\/skills$/)
})

test('creates a missing CLAUDE.local.md', async ({ page }) => {
  const backend = await mockApi(page)
  await page.goto('/claude-md')
  await page.getByRole('button', { name: 'Create CLAUDE.local.md in Global' }).click()
  await expect(page.locator('.file-pane__path')).toHaveText('CLAUDE.local.md')
  await expect.poll(() => backend.writes.length).toBe(1)
})
