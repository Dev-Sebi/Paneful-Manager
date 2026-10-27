import { lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import type { z } from '@agent-hub/shared'
import { Document, isMap, isScalar, parseDocument } from 'yaml'
import type { BaseLogger } from 'pino'
import { AppError } from '../errors.js'
import type { BackupStore } from './backups.js'
import { atomicWrite } from './service.js'

export const YAML_EXTENSION = '.yaml'

const YAML_FILE_MODE = 0o600

export interface NamedYamlStore<T extends { name: string }> {
  list: () => Promise<T[]>
  get: (name: string) => Promise<T>
  create: (value: T) => Promise<T>
  update: (name: string, value: T) => Promise<T>
  remove: (name: string) => Promise<void>
}

export interface NamedYamlStoreOptions<T extends { name: string }> {
  /** Directory holding `<name>.yaml`; created on the first write. */
  dir: string
  schema: z.ZodType<T>
  /** Validates names before they become file names. */
  nameSchema: z.ZodType<string>
  /** Capitalized noun used in messages, e.g. `Preset`. */
  label: string
  /** Directory name used in messages, e.g. `workspaces`. */
  dirLabel: string
  /** Shape written to disk; defaults to the value itself. */
  toFileShape?: (value: T) => Record<string, unknown>
  logger?: Pick<BaseLogger, 'warn'>
  /** When given, the previous file content is saved before an overwrite or a delete. */
  backups?: BackupStore
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code
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

/** CRUD over `<dir>/<name>.yaml`: file name = value name, atomic writes, writes serialized. */
export function createNamedYamlStore<T extends { name: string }>(options: NamedYamlStoreOptions<T>): NamedYamlStore<T> {
  const { dir, schema, nameSchema, label, dirLabel, logger, backups } = options
  const noun = label.toLowerCase()
  const toFileShape = options.toFileShape ?? ((value: T): Record<string, unknown> => ({ ...value }))
  const notFound = (name: string): AppError => new AppError(`${label} ${name} not found`, 404, 'not_found')
  let queue: Promise<unknown> = Promise.resolve()

  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run
  }

  /** Path of `<name>.yaml`; a symlinked file must resolve to a path inside the real directory. */
  async function locate(name: string): Promise<{ link: string, real: string }> {
    const file = join(dir, `${nameSchema.parse(name)}${YAML_EXTENSION}`)
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
      throw new AppError(`${label} ${name} resolves outside the ${dirLabel} directory`, 400, 'bad_request')
    }
    return { link: file, real: target }
  }

  async function resolveFile(name: string): Promise<string> {
    return (await locate(name)).real
  }

  /** Write target; a link to another file of this store is refused so two names never share one file. */
  async function resolveWritable(name: string): Promise<string> {
    const { real } = await locate(name)
    if (basename(real) !== `${name}${YAML_EXTENSION}`) {
      throw new AppError(`${label} ${name} is a link to another ${noun} file`, 409, 'conflict')
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

  function parseText(name: string, text: string): T {
    const doc = parseDocument(text)
    const result = doc.errors.length === 0 ? schema.safeParse(doc.toJS()) : undefined
    const fileName = `${name}${YAML_EXTENSION}`
    if (result === undefined) {
      throw new AppError(`${label} file ${fileName} is not valid YAML`, 409, 'conflict')
    }
    if (!result.success) {
      const issues = result.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
      throw new AppError(`${label} file ${fileName} is invalid: ${issues}`, 409, 'conflict')
    }
    if (result.data.name !== name) {
      throw new AppError(`${label} file ${fileName} declares the name ${result.data.name}`, 409, 'conflict')
    }
    return result.data
  }

  async function write(file: string, value: T, existing: string | undefined): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await atomicWrite(file, mergeIntoDocument(existing, toFileShape(value)), YAML_FILE_MODE, async () => {})
  }

  async function backup(file: string, text: string): Promise<void> {
    await backups?.save(file, Buffer.from(text, 'utf8'))
  }

  async function get(name: string): Promise<T> {
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
      const values: T[] = []
      for (const file of names.toSorted()) {
        const name = file.slice(0, -YAML_EXTENSION.length)
        if (!file.endsWith(YAML_EXTENSION) || !nameSchema.safeParse(name).success) {
          continue
        }
        try {
          values.push(await get(name))
        } catch (error) {
          logger?.warn({ file, err: error }, `Ignoring invalid ${noun} file`)
        }
      }
      return values
    },
    get,
    create: value =>
      serialized(async () => {
        const file = await resolveWritable(value.name)
        if ((await readText(file)) !== undefined) {
          throw new AppError(`${label} ${value.name} already exists`, 409, 'conflict')
        }
        await write(file, value, undefined)
        return value
      }),
    update: (name, value) =>
      serialized(async () => {
        if (value.name !== name) {
          throw new AppError(`The ${noun} name cannot be changed`, 400, 'bad_request')
        }
        const file = await resolveWritable(name)
        const text = await readText(file)
        if (text === undefined) {
          throw notFound(name)
        }
        await backup(file, text)
        await write(file, value, text)
        return value
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
