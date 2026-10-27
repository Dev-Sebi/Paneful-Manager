import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Backups kept per file; older ones are pruned. */
export const MAX_BACKUPS_PER_FILE = 20
/** Total size of all backups; the oldest are pruned first. */
export const MAX_BACKUP_TOTAL_BYTES = 50 * 1024 * 1024

/** Keeps encoded directory names below common file name limits. */
const MAX_ENCODED_LENGTH = 200

export interface BackupStoreOptions {
  dir: string
  perFile?: number
  totalBytes?: number
}

export interface BackupStore {
  /** Copies `content` of `path` to `<dir>/<encoded-path>/<timestamp>` (mode 0600) and prunes; returns the backup path. */
  save: (path: string, content: Buffer) => Promise<string>
}

export function encodeBackupPath(path: string): string {
  const encoded = encodeURIComponent(path)
  if (encoded.length <= MAX_ENCODED_LENGTH) {
    return encoded
  }
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 16)
  return `${digest}-${encoded.slice(-(MAX_ENCODED_LENGTH - digest.length - 1))}`
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(':', '-')
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

async function writeUnique(dir: string, content: Buffer): Promise<string> {
  const base = timestamp()
  for (let attempt = 0; ; attempt++) {
    const target = join(dir, attempt === 0 ? base : `${base}-${attempt}`)
    try {
      await writeFile(target, content, { mode: 0o600, flag: 'wx' })
      return target
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') {
        throw error
      }
    }
  }
}

interface BackupFile {
  path: string
  name: string
  size: number
}

async function listDir(dir: string): Promise<BackupFile[]> {
  const names = (await readdir(dir)).toSorted()
  const files: BackupFile[] = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (info.isFile()) {
        files.push({ path, name, size: info.size })
      }
    } catch {
      // Removed concurrently.
    }
  }
  return files
}

export function createBackupStore({ dir, perFile = MAX_BACKUPS_PER_FILE, totalBytes = MAX_BACKUP_TOTAL_BYTES }: BackupStoreOptions): BackupStore {
  async function pruneTotal(keep: string): Promise<void> {
    const all: BackupFile[] = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        all.push(...(await listDir(join(dir, entry.name))))
      }
    }
    let total = all.reduce((sum, file) => sum + file.size, 0)
    for (const file of all.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (total <= totalBytes) {
        break
      }
      if (file.path !== keep) {
        await rm(file.path, { force: true })
        total -= file.size
      }
    }
  }

  return {
    async save(path, content) {
      const fileDir = join(dir, encodeBackupPath(path))
      await mkdir(fileDir, { recursive: true, mode: 0o700 })
      const backup = await writeUnique(fileDir, content)
      const files = await listDir(fileDir)
      for (const file of files.slice(0, Math.max(0, files.length - perFile))) {
        await rm(file.path, { force: true })
      }
      await pruneTotal(backup)
      return backup
    },
  }
}
