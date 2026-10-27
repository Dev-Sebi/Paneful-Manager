import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DIST = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'dist')
// Chunk file names contain "monaco", so match code that only Monaco setup uses.
const MARKERS = ['MonacoEnvironment', 'setMonarchTokensProvider', 'defineTheme']

/** Returns entry scripts referenced by dist/index.html that contain Monaco code. */
export function findMonacoInEntry (distDir = DIST): string[] {
  const indexHtml = join(distDir, 'index.html')
  if (!existsSync(indexHtml)) {
    throw new Error(`${indexHtml} not found, run "pnpm build" first`)
  }
  const html = readFileSync(indexHtml, 'utf8')
  const entries = [...html.matchAll(/<script[^>]*\ssrc="([^"]+\.js)"/g)].map(m => (m[1] ?? '').replace(/^\//, ''))
  return entries.filter(entry => {
    const source = readFileSync(join(distDir, entry), 'utf8')
    return MARKERS.some(marker => source.includes(marker))
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const offenders = findMonacoInEntry()
  for (const name of offenders) {
    console.error(`${name} contains Monaco, keep it behind a dynamic import`)
  }
  process.exitCode = offenders.length > 0 ? 1 : 0
}
