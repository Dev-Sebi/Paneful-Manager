import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { open } from 'node:fs/promises'
import { MAX_MANAGED_FILE_BYTES } from '@agent-hub/shared'
import { AppError } from '../errors.js'

export interface CurrentFile {
  content: Buffer
  stats: Stats
  hash: string
}

export function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Reads a regular file without following a final symlink; `null` when it does not exist.
 * `O_NONBLOCK` keeps a FIFO or device from blocking the open; anything but a regular file is 403.
 */
export async function readCurrent(path: string): Promise<CurrentFile | null> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'ENOENT') {
      return null
    }
    if (code === 'ELOOP') {
      throw new AppError('Path changed to a symbolic link', 403, 'forbidden')
    }
    throw error
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new AppError('Not a regular file', 403, 'forbidden')
    }
    if (stats.size > MAX_MANAGED_FILE_BYTES) {
      throw new AppError('File is larger than 1 MiB', 413, 'bad_request')
    }
    const content = await handle.readFile()
    return { content, stats, hash: sha256(content) }
  } finally {
    await handle.close()
  }
}
