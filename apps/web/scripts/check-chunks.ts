import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DIST = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'dist')
// Chunk file names contain "monaco", so match code that only Monaco setup uses.
const MARKERS = ['MonacoEnvironment', 'setMonarchTokensProvider', 'defineTheme']

const STATIC_IMPORT = /(?:\bfrom|\bimport)\s*["']([^"']+\.js)["']/g
const ENTRY_REFS = [/<script[^>]*\ssrc="([^"]+\.js)"/g, /<link[^>]*rel="modulepreload"[^>]*\shref="([^"]+\.js)"/g]

/**
 * Returns chunks reachable from dist/index.html (entry scripts, modulepreload links and their
 * static imports) that contain Monaco code. Dynamic imports are not followed.
 * Vite's ">500 kB" warning is expected for the lazy Monaco chunks.
 */
export function findMonacoInEntry (distDir = DIST): string[] {
  const indexHtml = join(distDir, 'index.html')
  if (!existsSync(indexHtml)) {
    throw new Error(`${indexHtml} not found, run "pnpm build" first`)
  }
  const html = readFileSync(indexHtml, 'utf8')
  const queue = ENTRY_REFS.flatMap(ref => [...html.matchAll(ref)].map(m => (m[1] ?? '').replace(/^\//, '')))
  const seen = new Set<string>()
  const offenders: string[] = []
  while (queue.length > 0) {
    const chunk = queue.pop() as string
    if (seen.has(chunk) || !existsSync(join(distDir, chunk))) {
      continue
    }
    seen.add(chunk)
    const source = readFileSync(join(distDir, chunk), 'utf8')
    if (MARKERS.some(marker => source.includes(marker))) {
      offenders.push(chunk)
    }
    for (const m of source.matchAll(STATIC_IMPORT)) {
      queue.push(posix.join(posix.dirname(chunk), m[1] ?? ''))
    }
  }
  return offenders
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const offenders = findMonacoInEntry()
  for (const name of offenders) {
    console.error(`${name} contains Monaco, keep it behind a dynamic import`)
  }
  process.exitCode = offenders.length > 0 ? 1 : 0
}
