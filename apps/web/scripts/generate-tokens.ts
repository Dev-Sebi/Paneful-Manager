import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type TokenValue = string | number | readonly TokenValue[] | { readonly [key: string]: TokenValue }

interface TokenNode {
  readonly [key: string]: unknown
}

export interface ResolvedToken {
  path: string
  type: string
  themed: boolean
  dark: TokenValue
  light: TokenValue
}

export const VUETIFY_EXTENSION = 'dev.agenthub.vuetify'
const GENERATED_HEADER = '/* Generated from docs/design-system/tokens.json by scripts/generate-tokens.ts. Do not edit. */\n/* eslint-disable */\n'
const THEMES = ['dark', 'light'] as const
type Theme = typeof THEMES[number]

function isRecord (value: unknown): value is TokenNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToken (node: unknown): node is TokenNode {
  return isRecord(node) && '$value' in node
}

function isThemedGroup (node: TokenNode, path: string): boolean {
  const keys = Object.keys(node).filter(key => !key.startsWith('$'))
  const hasTheme = THEMES.some(theme => isToken(node[theme]))
  if (!hasTheme) {
    return false
  }
  if (keys.length !== THEMES.length || !THEMES.every(theme => isToken(node[theme]))) {
    throw new Error(`Themed group "${path}" must contain only dark and light tokens`)
  }
  return true
}

function lookup (root: TokenNode, path: string): TokenNode {
  let node: unknown = root
  for (const part of path.split('.')) {
    if (!isRecord(node) || !(part in node)) {
      throw new Error(`Unresolvable alias: {${path}}`)
    }
    node = node[part]
  }
  if (!isToken(node)) {
    throw new Error(`Alias does not point at a token: {${path}}`)
  }
  return node
}

function resolveValue (root: TokenNode, value: unknown, chain: readonly string[]): TokenValue {
  if (typeof value === 'string') {
    const match = /^\{([^{}]+)\}$/.exec(value)
    if (!match) {
      return value
    }
    const target = match[1]!
    if (chain.includes(target)) {
      throw new Error(`Circular alias: ${[...chain, target].join(' -> ')}`)
    }
    return resolveValue(root, lookup(root, target).$value, [...chain, target])
  }
  if (typeof value === 'number') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(item => resolveValue(root, item, chain))
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(root, item, chain)]))
  }
  throw new Error(`Unsupported token value: ${JSON.stringify(value)}`)
}

/** Walks the token tree, resolves aliases and returns flat tokens in document order. */
export function collectTokens (root: TokenNode): ResolvedToken[] {
  const out: ResolvedToken[] = []

  function walk (node: TokenNode, path: string[], inheritedType: string): void {
    const type = typeof node.$type === 'string' ? node.$type : inheritedType
    if (isToken(node)) {
      const value = resolveValue(root, node.$value, [])
      out.push({ path: path.join('.'), type, themed: false, dark: value, light: value })
      return
    }
    if (isThemedGroup(node, path.join('.'))) {
      const [dark, light] = THEMES.map(theme => resolveValue(root, (node[theme] as TokenNode).$value, []))
      out.push({ path: path.join('.'), type, themed: true, dark: dark!, light: light! })
      return
    }
    for (const [key, child] of Object.entries(node)) {
      if (!key.startsWith('$') && isRecord(child)) {
        walk(child, [...path, key], type)
      }
    }
  }

  walk(root, [], '')
  return out
}

function fontName (name: string): string {
  return /^[A-Z-]+$/i.test(name) ? name : `"${name}"`
}

/** Formats a resolved token value as a CSS value for its DTCG type. */
export function toCss (type: string, value: TokenValue): string {
  if (type === 'cubicBezier' && Array.isArray(value)) {
    return `cubic-bezier(${value.join(', ')})`
  }
  if (type === 'fontFamily' && Array.isArray(value)) {
    return value.map(name => fontName(String(name))).join(', ')
  }
  if (type === 'shadow' && isRecord(value)) {
    const v = value as Record<string, string>
    return `${v.offsetX} ${v.offsetY} ${v.blur} ${v.spread} ${v.color}`
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value)
  }
  throw new Error(`Cannot format ${type} value as CSS: ${JSON.stringify(value)}`)
}

export function cssVarName (path: string): string {
  return `--ah-${path.replaceAll('.', '-')}`
}

export function buildCss (tokens: readonly ResolvedToken[]): string {
  const block = (selector: string, items: string[]) => `${selector} {\n${items.map(line => `  ${line}`).join('\n')}\n}\n`
  const plain = tokens.filter(token => !token.themed)
  const themed = tokens.filter(token => token.themed)
  const decl = (token: ResolvedToken, theme: Theme) => `${cssVarName(token.path)}: ${toCss(token.type, token[theme])};`
  return [
    GENERATED_HEADER,
    block(':root', plain.map(token => decl(token, 'dark'))),
    block(':root,\n.v-theme--dark', themed.map(token => decl(token, 'dark'))),
    block('.v-theme--light', themed.map(token => decl(token, 'light'))),
  ].join('\n')
}

function findByPath (tokens: readonly ResolvedToken[], path: string): ResolvedToken {
  const token = tokens.find(item => item.path === path)
  if (!token) {
    throw new Error(`Mapping references unknown token: ${path}`)
  }
  return token
}

function camelCase (name: string): string {
  return name.replaceAll(/-(\w)/g, (_, char: string) => char.toUpperCase())
}

const XTERM_KEYS: Record<string, string> = {
  fg: 'foreground',
  bg: 'background',
  selection: 'selectionBackground',
}

export function buildTheme (root: TokenNode, tokens: readonly ResolvedToken[]): string {
  const extensions = root.$extensions
  const mapping = isRecord(extensions) ? extensions[VUETIFY_EXTENSION] : undefined
  if (!isRecord(mapping) || !isRecord(mapping.colors) || !isRecord(mapping.variables)) {
    throw new Error(`Missing $extensions["${VUETIFY_EXTENSION}"] with colors and variables`)
  }
  const colors = mapping.colors
  const variables = mapping.variables
  const terminal = tokens.filter(token => token.path.startsWith('color.terminal.'))

  const pick = (map: TokenNode, theme: Theme) => Object.fromEntries(
    Object.entries(map).map(([key, path]) => [key, findByPath(tokens, String(path))[theme]]),
  )
  const xterm = (theme: Theme) => Object.fromEntries(terminal.map(token => {
    const name = token.path.slice('color.terminal.'.length)
    return [XTERM_KEYS[name] ?? camelCase(name), token[theme]]
  }))
  const json = (value: unknown) => JSON.stringify(value, null, 2)

  const lines = [GENERATED_HEADER, `import type { ThemeDefinition } from 'vuetify'\n`, `/** Structural subset of xterm.js ITheme. */\nexport interface XtermTheme {\n  [key: string]: string\n}\n`]
  for (const theme of THEMES) {
    lines.push(`export const ${theme}Theme: ThemeDefinition = ${json({ dark: theme === 'dark', colors: pick(colors, theme), variables: pick(variables, theme) })}\n`)
  }
  for (const theme of THEMES) {
    const name = `xterm${theme === 'dark' ? 'Dark' : 'Light'}Theme`
    lines.push(`export const ${name}: XtermTheme = ${json(xterm(theme))}\n`)
  }
  return lines.join('\n')
}

function pxToNumber (value: TokenValue): number {
  const match = /^(-?\d+(?:\.\d+)?)(?:px|ms)$/.exec(String(value))
  if (!match) {
    throw new Error(`Expected px or ms value, got ${JSON.stringify(value)}`)
  }
  return Number(match[1])
}

export function buildTs (tokens: readonly ResolvedToken[]): string {
  const group = (prefix: string, convert: (token: ResolvedToken) => TokenValue) => Object.fromEntries(
    tokens.filter(token => token.path.startsWith(`${prefix}.`) && token.path.split('.').length === prefix.split('.').length + 1)
      .map(token => [token.path.slice(prefix.length + 1), convert(token)]),
  )
  const num = (token: ResolvedToken) => pxToNumber(token.dark)
  const raw = (token: ResolvedToken) => token.dark
  const css = (token: ResolvedToken) => toCss(token.type, token.dark)
  const groups: Record<string, Record<string, TokenValue>> = {
    space: group('space', num),
    radius: group('radius', num),
    fontSize: group('font.size', num),
    fontWeight: group('font.weight', raw),
    lineHeight: group('font.line-height', raw),
    fontFamily: group('font.family', css),
    opacity: group('opacity', raw),
    duration: group('motion.duration', num),
    easing: group('motion.easing', css),
    z: group('z', raw),
  }
  const body = Object.entries(groups).map(([name, value]) => `export const ${name} = ${JSON.stringify(value, null, 2)} as const\n`)
  return [GENERATED_HEADER, ...body].join('\n')
}

export function generate (root: TokenNode): Record<string, string> {
  const tokens = collectTokens(root)
  return {
    'tokens.css': buildCss(tokens),
    'theme.ts': buildTheme(root, tokens),
    'tokens.ts': buildTs(tokens),
  }
}

const here = dirname(fileURLToPath(import.meta.url))
export const TOKENS_PATH = resolve(here, '../../../docs/design-system/tokens.json')
export const OUT_DIR = resolve(here, '../src/styles/generated')

export function readTokens (path = TOKENS_PATH): TokenNode {
  return JSON.parse(readFileSync(path, 'utf8')) as TokenNode
}

export function writeOutputs (files: Record<string, string>, dir: string): void {
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
}

/** Regenerates into a temp dir and returns the names of committed files that differ. */
export function findStale (tokensPath = TOKENS_PATH, committedDir = OUT_DIR): string[] {
  const tmp = mkdtempSync(join(tmpdir(), 'ah-tokens-'))
  try {
    const files = generate(readTokens(tokensPath))
    writeOutputs(files, tmp)
    return Object.keys(files).filter(name => {
      try {
        return readFileSync(join(committedDir, name), 'utf8') !== readFileSync(join(tmp, name), 'utf8')
      } catch {
        return true
      }
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) {
    const stale = findStale()
    if (stale.length > 0) {
      console.error(`Generated tokens are stale: ${stale.join(', ')}. Run "pnpm tokens".`)
      process.exitCode = 1
    } else {
      console.log('Generated tokens are up to date.')
    }
  } else {
    writeOutputs(generate(readTokens()), OUT_DIR)
    console.log(`Tokens written to ${OUT_DIR}`)
  }
}
