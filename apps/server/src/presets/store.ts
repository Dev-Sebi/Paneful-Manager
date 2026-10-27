import { lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { PresetNameSchema, WorkspacePresetSchema, type WorkspacePreset } from '@agent-hub/shared'
import { Document, isMap, isScalar, parseDocument } from 'yaml'
import type { BaseLogger } from 'pino'
import { AppError } from '../errors.js'
import type { BackupStore } from '../files/backups.js'
import { atomicWrite } from '../files/service.js'

export const PRESET_EXTENSION = '.yaml'

const PRESET_FILE_MODE = 0o600
const COMPACT_LAYOUTS = new Set(['single', 'row', 'column', 'grid-2x2'])

export interface PresetStore {
  list: () => Promise<WorkspacePreset[]>
  get: (name: string) => Promise<WorkspacePreset>
  create: (preset: WorkspacePreset) => Promise<WorkspacePreset>
  update: (name: string, preset: WorkspacePreset) => Promise<WorkspacePreset>
  remove: (name: string) => Promise<void>
}

export interface PresetStoreOptions {
  /** The `workspaces` directory; created on the first write. */
  dir: string
  logger?: Pick<BaseLogger, 'warn'>
  /** When given, the previous file content is saved before an overwrite or a delete. */
  backups?: BackupStore
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code
}

function notFound(name: string): AppError {
  return new AppError(`Preset ${name} not found`, 404, 'not_found')
}

/** Drops values the schema fills in anyway, so saved files stay as short as hand-written ones. */
function toFileShape(preset: WorkspacePreset): Record<string, unknown> {
  return {
    ...preset,
    tabs: preset.tabs.map(tab => {
      const { kind, ...rest } = tab.layout
      const compact = COMPACT_LAYOUTS.has(kind) && Object.keys(rest).length === 0
      return {
        ...tab,
        layout: compact ? kind : tab.layout,
        panes: tab.panes.map(({ args, ...pane }) => (args.length === 0 ? pane : { ...pane, args })),
      }
    }),
  }
}

/** Replaces the document's top-level keys in place, so comments above or between them survive. */
function mergeIntoDocument(existing: string | undefined, value: Record<string, unknown>): string {
  const parsed = existing === undefined ? undefined : parseDocument(existing)
  const doc = parsed !== undefined && parsed.errors.length === 0 && isMap(parsed.contents) ? parsed : new Document({})
  const items = isMap(doc.contents) ? [...doc.contents.items] : []
  for (const { key } of items) {
    if (isScalar(key) && typeof key.value === 'string' && !(key.value in value)) {
      doc.delete(key.value)
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    doc.set(key, entry)
  }
  return doc.toString()
}

/** CRUD over `<dir>/<name>.yaml`: file name = preset name, atomic writes, writes serialized. */
export function createPresetStore({ dir, logger, backups }: PresetStoreOptions): PresetStore {
  let queue: Promise<unknown> = Promise.resolve()

  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run
  }

  /** Path of `<name>.yaml`; a symlinked file must resolve to a path inside the real workspaces dir. */
  async function locate(name: string): Promise<{ link: string, real: string }> {
    const file = join(dir, `${PresetNameSchema.parse(name)}${PRESET_EXTENSION}`)
    let info
    try {
      info = await lstat(file)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return { link: file, real: file }
      }
      throw error
    }
    if (!info.isSymbolicLink()) {
      return { link: file, real: file }
    }
    const [root, target] = await Promise.all([realpath(dir), realpath(file).catch(() => undefined)])
    if (target === undefined || !target.startsWith(`${root}${sep}`)) {
      throw new AppError(`Preset ${name} resolves outside the workspaces directory`, 400, 'bad_request')
    }
    return { link: file, real: target }
  }

  async function resolveFile(name: string): Promise<string> {
    return (await locate(name)).real
  }

  /** Write target of a preset; a link to another preset's file is refused so two names never share one file. */
  async function resolveWritable(name: string): Promise<string> {
    const { real } = await locate(name)
    if (basename(real) !== `${name}${PRESET_EXTENSION}`) {
      throw new AppError(`Preset ${name} is a link to another preset file`, 409, 'conflict')
    }
    return real
  }

  async function readText(file: string): Promise<string | undefined> {
    try {
      return await readFile(file, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return undefined
      }
      throw error
    }
  }

  function parseText(name: string, text: string): WorkspacePreset {
    const doc = parseDocument(text)
    const result = doc.errors.length === 0 ? WorkspacePresetSchema.safeParse(doc.toJS()) : undefined
    if (result === undefined) {
      throw new AppError(`Preset file ${name}${PRESET_EXTENSION} is not valid YAML`, 409, 'conflict')
    }
    if (!result.success) {
      const issues = result.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
      throw new AppError(`Preset file ${name}${PRESET_EXTENSION} is invalid: ${issues}`, 409, 'conflict')
    }
    if (result.data.name !== name) {
      throw new AppError(`Preset file ${name}${PRESET_EXTENSION} declares the name ${result.data.name}`, 409, 'conflict')
    }
    return result.data
  }

  async function write(file: string, preset: WorkspacePreset, existing: string | undefined): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await atomicWrite(file, mergeIntoDocument(existing, toFileShape(preset)), PRESET_FILE_MODE, async () => {})
  }

  async function backup(file: string, text: string): Promise<void> {
    await backups?.save(file, Buffer.from(text, 'utf8'))
  }

  async function get(name: string): Promise<WorkspacePreset> {
    const text = await readText(await resolveFile(name))
    if (text === undefined) {
      throw notFound(name)
    }
    return parseText(name, text)
  }

  return {
    async list() {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch (error) {
        if (isErrno(error, 'ENOENT')) {
          return []
        }
        throw error
      }
      const presets: WorkspacePreset[] = []
      for (const file of names.toSorted()) {
        const name = file.slice(0, -PRESET_EXTENSION.length)
        if (!file.endsWith(PRESET_EXTENSION) || !PresetNameSchema.safeParse(name).success) {
          continue
        }
        try {
          presets.push(await get(name))
        } catch (error) {
          logger?.warn({ file, err: error }, 'Ignoring invalid preset file')
        }
      }
      return presets
    },
    get,
    create: preset =>
      serialized(async () => {
        const file = await resolveWritable(preset.name)
        if ((await readText(file)) !== undefined) {
          throw new AppError(`Preset ${preset.name} already exists`, 409, 'conflict')
        }
        await write(file, preset, undefined)
        return preset
      }),
    update: (name, preset) =>
      serialized(async () => {
        if (preset.name !== name) {
          throw new AppError('The preset name cannot be changed', 400, 'bad_request')
        }
        const file = await resolveWritable(name)
        const text = await readText(file)
        if (text === undefined) {
          throw notFound(name)
        }
        await backup(file, text)
        await write(file, preset, text)
        return preset
      }),
    remove: name =>
      serialized(async () => {
        const { link, real } = await locate(name)
        const text = await readText(real)
        if (text === undefined) {
          throw notFound(name)
        }
        await backup(real, text)
        await rm(link)
      }),
  }
}
