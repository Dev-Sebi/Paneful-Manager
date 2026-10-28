import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Temp files younger than this may still belong to a write in progress (another process or request). */
export const TEMP_MAX_AGE_MS = 60_000

/**
 * Removes the files in `dir` whose name matches `pattern` and that are older than `maxAgeMs`: leftovers of writes
 * interrupted between the temp write and the rename. Links and other non-regular files are left alone. Returns the
 * removed names; a missing `dir` removes nothing.
 */
export async function removeStaleTempFiles(dir: string, pattern: RegExp, { maxAgeMs = TEMP_MAX_AGE_MS, now = Date.now } = {}): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const removed: string[] = []
  for (const name of names.filter(candidate => pattern.test(candidate))) {
    const file = join(dir, name)
    try {
      const info = await lstat(file)
      if (info.isFile() && now() - info.mtimeMs > maxAgeMs) {
        await rm(file, { force: true })
        removed.push(name)
      }
    } catch {
      // Renamed or removed by its writer meanwhile.
    }
  }
  return removed
}
