import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { applyConfigPatch, type AppConfig, type ConfigPatch } from '@agent-hub/shared'
import { parseDocument } from 'yaml'
import { AppError } from '../errors.js'
import { atomicWrite } from '../files/service.js'

export interface PatchResult {
  config: AppConfig
  restartRequired: boolean
}

export interface ConfigStore {
  get: () => AppConfig
  patch: (patch: ConfigPatch) => Promise<PatchResult>
  /** Called after every applied patch; returns an unsubscribe function. */
  onChange: (listener: (config: AppConfig) => void) => () => void
}

const CONFIG_FILE_MODE = 0o600

async function readExisting(file: string): Promise<{ text: string; mode: number | undefined }> {
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    return { text, mode: info.mode & 0o7777 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { text: '', mode: undefined }
    }
    throw error
  }
}

/** Writes the patched keys into the YAML document so comments and unknown keys survive. */
function mergeIntoYaml(text: string, patch: ConfigPatch): string {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) {
    throw new AppError('Config file is not valid YAML', 409, 'conflict')
  }
  const { experimental, ...rest } = patch
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) {
      doc.setIn([key], value)
    }
  }
  for (const [key, value] of Object.entries(experimental ?? {})) {
    if (value !== undefined) {
      doc.setIn(['experimental', key], value)
    }
  }
  return doc.toString()
}

/** Holds the live config; with a `file`, patches are merged into it atomically before being applied. */
export function createConfigStore(initial: AppConfig, file?: string): ConfigStore {
  let current = initial
  let queue: Promise<unknown> = Promise.resolve()
  const listeners = new Set<(config: AppConfig) => void>()

  async function apply(patch: ConfigPatch): Promise<PatchResult> {
    const next = applyConfigPatch(current, patch)
    if (file !== undefined) {
      const existing = await readExisting(file)
      await mkdir(dirname(file), { recursive: true })
      await atomicWrite(file, mergeIntoYaml(existing.text, patch), existing.mode ?? CONFIG_FILE_MODE, async () => {})
    }
    const restartRequired = patch.port !== undefined && patch.port !== current.port
    current = next
    listeners.forEach(listener => listener(next))
    return { config: next, restartRequired }
  }

  return {
    get: () => current,
    patch: patch => {
      const run = queue.then(() => apply(patch))
      queue = run.catch(() => undefined)
      return run
    },
    onChange: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
