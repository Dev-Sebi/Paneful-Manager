import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Scope } from '@paneful-manager/shared'
import { pino } from 'pino'
import { AppError } from '../errors.js'
import { createFileService, type FileService, type FileServiceOptions } from './service.js'

export interface Sandbox {
  base: string
  claudeDir: string
  project: string
  outside: string
  state: string
  scopes: Scope[]
  service: FileService
  cleanup: () => Promise<void>
}

export const silentLogger = pino({ level: 'silent' })

/** Temp `$CLAUDE_DIR`, one project, an outside dir and a state dir, plus a service over them. */
export function createSandbox(overrides: Partial<FileServiceOptions> = {}): Sandbox {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'paneful-manager-files-')))
  const claudeDir = join(base, 'claude')
  const project = join(base, 'project')
  const outside = join(base, 'outside')
  const state = join(base, 'state')
  for (const dir of [claudeDir, project, outside, state]) {
    mkdirSync(dir, { recursive: true })
  }
  const scopes: Scope[] = [
    { kind: 'global', path: claudeDir },
    { kind: 'project', path: project },
  ]
  const service = createFileService({
    getScopes: async () => scopes,
    backupDir: join(state, 'backups'),
    logger: silentLogger,
    ...overrides,
  })
  return {
    base, claudeDir, project, outside, state, scopes, service,
    cleanup: async () => {
      await service.close()
      rmSync(base, { recursive: true, force: true })
    },
  }
}

/** Awaits `promise` and returns the `AppError` it rejected with. */
export async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AppError) {
      return error
    }
    throw error
  }
  throw new Error('expected an AppError')
}
