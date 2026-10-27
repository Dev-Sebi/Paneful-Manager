import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function makeClaudeDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-teams-')))
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}

export const task = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  subject: `Task ${id}`,
  status: 'pending',
  blocks: [],
  blockedBy: [],
  ...extra,
})
