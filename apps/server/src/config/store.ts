import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { applyConfigPatch, type AppConfig, type ConfigPatch } from '@paneful-manager/shared'
import { isMap, parseDocument } from 'yaml'
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

export interface ConfigStoreOptions {
  /** `config.yaml` to merge patches into; without it patches only change the live config. */
  file?: string
  /** Port the server listens on; a different configured port needs a restart. Defaults to the initial port. */
  getListeningPort?: () => number
  /** Rejects (throws) when the patched config must not be applied; runs before anything is written. */
  validate?: (next: AppConfig) => Promise<void>
}

const STRUCTURE_ERROR = 'config.yaml has an unexpected structure'
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

/** Follows a symlinked config file so the atomic rename replaces the target, not the link. */
async function resolveTarget(file: string): Promise<string> {
  try {
    return await realpath(file)
  } catch {
    return file
  }
}

/** Writes the patched keys into the YAML document so comments and unknown keys survive. */
function mergeIntoYaml(text: string, patch: ConfigPatch): string {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) {
    throw new AppError('Config file is not valid YAML', 409, 'conflict')
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new AppError(STRUCTURE_ERROR, 409, 'conflict')
  }
  const { experimental, ...rest } = patch
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) {
      doc.setIn([key], value)
    }
  }
  const entries = Object.entries(experimental ?? {}).filter(([, value]) => value !== undefined)
  if (entries.length > 0 && !isMap(doc.get('experimental'))) {
    doc.set('experimental', doc.createNode({}))
  }
  for (const [key, value] of entries) {
    doc.setIn(['experimental', key], value)
  }
  return doc.toString()
}

/** Holds the live config; with a `file`, patches are merged into it atomically before being applied. */
export function createConfigStore(initial: AppConfig, { file, getListeningPort, validate }: ConfigStoreOptions = {}): ConfigStore {
  const listeningPort = getListeningPort ?? (() => initial.port)
  let current = initial
  let queue: Promise<unknown> = Promise.resolve()
  const listeners = new Set<(config: AppConfig) => void>()

  async function apply(patch: ConfigPatch): Promise<PatchResult> {
    const next = applyConfigPatch(current, patch)
    await validate?.(next)
    if (file !== undefined) {
      const target = await resolveTarget(file)
      const existing = await readExisting(target)
      const merged = mergeIntoYaml(existing.text, patch)
      await mkdir(dirname(target), { recursive: true })
      await atomicWrite(target, merged, existing.mode ?? CONFIG_FILE_MODE, async () => {})
    }
    const restartRequired = next.port !== listeningPort()
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
