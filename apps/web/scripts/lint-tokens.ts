import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const RAW_COLOR = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/gi
const EXTENSIONS = /\.(?:vue|ts|css|scss|html)$/
const here = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = resolve(here, '..')
const GENERATED_DIR = join(WEB_DIR, 'src', 'styles', 'generated')
const SCAN_ROOTS = ['src', 'public', 'index.html']

export interface ColorViolation {
  file: string
  line: number
  match: string
}

/**
 * Hex-like matches followed by `{`, or by `,` on a line without `:`, are treated as id selectors.
 * Limitation: a hex color in a bare selector-like position is not flagged.
 */
export function findRawColors (source: string): Array<{ line: number, match: string }> {
  return source.split('\n').flatMap((text, index) => [...text.matchAll(RAW_COLOR)]
    .filter(m => {
      const rest = text.slice(m.index + m[0].length)
      const isSelector = m[0].startsWith('#') && (/^\s*\{/.test(rest) || (/^\s*,/.test(rest) && !text.includes(':')))
      return !isSelector
    })
    .map(m => ({ line: index + 1, match: m[0] })))
}

function listFiles (path: string): string[] {
  if (path === GENERATED_DIR || !existsSync(path)) {
    return []
  }
  if (statSync(path).isDirectory()) {
    return readdirSync(path).flatMap(name => listFiles(join(path, name)))
  }
  return EXTENSIONS.test(path) ? [path] : []
}

export function lintTokens (baseDir = WEB_DIR): ColorViolation[] {
  return SCAN_ROOTS.flatMap(root => listFiles(join(baseDir, root)))
    .flatMap(file => findRawColors(readFileSync(file, 'utf8')).map(hit => ({ file: relative(baseDir, file), ...hit })))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = lintTokens()
  for (const v of violations) {
    console.error(`${v.file}:${v.line} raw color ${v.match}, use a token`)
  }
  process.exitCode = violations.length > 0 ? 1 : 0
}
