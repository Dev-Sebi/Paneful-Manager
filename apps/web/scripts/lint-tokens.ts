import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const RAW_HEX = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})(?![\w-])/gi
const EXTENSIONS = /\.(?:vue|ts|css)$/
const here = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = resolve(here, '../src')
const GENERATED_DIR = join(SRC_DIR, 'styles', 'generated')

export interface HexViolation {
  file: string
  line: number
  match: string
}

export function findHexColors (source: string): Array<{ line: number, match: string }> {
  return source.split('\n').flatMap((text, index) => [...text.matchAll(RAW_HEX)].map(m => ({ line: index + 1, match: m[0] })))
}

function listFiles (dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (full === GENERATED_DIR) {
      return []
    }
    if (entry.isDirectory()) {
      return listFiles(full)
    }
    return EXTENSIONS.test(entry.name) ? [full] : []
  })
}

export function lintTokens (dir = SRC_DIR): HexViolation[] {
  return listFiles(dir).flatMap(file => findHexColors(readFileSync(file, 'utf8')).map(hit => ({ file: relative(dir, file), ...hit })))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = lintTokens()
  for (const v of violations) {
    console.error(`${v.file}:${v.line} raw hex color ${v.match}, use a token`)
  }
  process.exitCode = violations.length > 0 ? 1 : 0
}
