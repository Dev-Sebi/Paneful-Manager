import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCss, collectTokens, findStale, generate, OUT_DIR, readTokens, TOKENS_PATH, VUETIFY_EXTENSION } from './generate-tokens'
import { findRawColors, lintTokens } from './lint-tokens'

const fixture = {
  $extensions: { [VUETIFY_EXTENSION]: { colors: { primary: 'color.accent.default' }, variables: { 'disabled-opacity': 'opacity.disabled' } } },
  color: {
    $type: 'color',
    base: { $value: '#111111' },
    alias: { $value: '{color.base}' },
    accent: { default: { dark: { $value: '{color.alias}' }, light: { $value: '#eeeeee' } } },
  },
  opacity: { $type: 'number', disabled: { $value: 0.4 } },
}

describe('generator', () => {
  it('resolves aliases recursively', () => {
    const tokens = collectTokens(fixture)
    expect(tokens.find(t => t.path === 'color.alias')?.dark).toBe('#111111')
    expect(tokens.find(t => t.path === 'color.accent.default')?.dark).toBe('#111111')
  })

  it('fails on unresolvable and circular aliases', () => {
    expect(() => collectTokens({ a: { $value: '{b}' } })).toThrow(/Unresolvable/)
    expect(() => collectTokens({ a: { $value: '{b}' }, b: { $value: '{a}' } })).toThrow(/Circular/)
  })

  it('places themed tokens per theme and plain tokens once on :root', () => {
    const css = buildCss(collectTokens(fixture))
    const [plain, dark, light] = css.split('\n\n').slice(1)
    expect(plain).toMatch(/^:root \{/)
    expect(plain).toContain('--ah-color-base: #111111;')
    expect(plain).not.toContain('--ah-color-accent-default')
    expect(dark).toContain('.v-theme--dark')
    expect(dark).toContain('--ah-color-accent-default: #111111;')
    expect(light).toContain('.v-theme--light')
    expect(light).toContain('--ah-color-accent-default: #eeeeee;')
    expect(css.match(/--ah-color-base:/g)).toHaveLength(1)
  })

  it('emits every Vuetify key of the real mapping for both themes', () => {
    const root = readTokens()
    const mapping = (root.$extensions as Record<string, { colors: object, variables: object }>)[VUETIFY_EXTENSION]!
    const theme = generate(root)['theme.ts']!.split('export const xtermDarkTheme', 1)[0]!
    for (const key of [...Object.keys(mapping.colors), ...Object.keys(mapping.variables)]) {
      expect(theme.match(new RegExp(`"${key}":`, 'g'))).toHaveLength(2)
    }
    expect(theme).toContain('"dark": true')
    expect(theme).toContain('"dark": false')
  })

  it('formats easings, shadows and font stacks as CSS values', () => {
    const css = generate(readTokens())['tokens.css']!
    expect(css).toMatch(/--ah-motion-easing-standard: cubic-bezier\(0\.2, 0, 0, 1\);/)
    expect(css).toMatch(/--ah-shadow-2: 0px 4px 12px 0px #/)
    expect(css).toMatch(/--ah-font-family-ui: Inter, system-ui, -apple-system, "Segoe UI"/)
  })

  it('emits xterm themes and numeric ts constants', () => {
    const out = generate(readTokens())
    expect(out['theme.ts']).toContain('export const xtermDarkTheme')
    expect(out['theme.ts']).toContain('"selectionBackground"')
    expect(out['theme.ts']).toContain('"brightBlack"')
    expect(out['tokens.ts']).toMatch(/"fast": 100/)
    expect(out['tokens.ts']).toMatch(/"overlay": 2000/)
  })

  it('reports committed output as current and detects a change', () => {
    expect(findStale()).toEqual([])
    const tmp = mkdtempSync(join(tmpdir(), 'ah-stale-'))
    try {
      const changed = join(tmp, 'tokens.json')
      const root = readTokens()
      writeFileSync(changed, JSON.stringify(root).replace('"60px"', '"61px"').replace('"4px"', '"5px"'))
      expect(findStale(changed, OUT_DIR).length).toBeGreaterThan(0)
      const copy = join(tmp, 'out')
      cpSync(OUT_DIR, copy, { recursive: true })
      writeFileSync(join(copy, 'tokens.css'), `${readFileSync(join(copy, 'tokens.css'), 'utf8')}/* x */`)
      expect(findStale(TOKENS_PATH, copy)).toEqual(['tokens.css'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('lint-tokens', () => {
  it('flags raw hex and functional colors but not ids or words', () => {
    expect(findRawColors('a { color: #fff; b: #12AB34; c: #3f7cf066 }')).toHaveLength(3)
    expect(findRawColors('a { color: rgb(0 0 0); b: hsla(0, 0%, 0%, 1) }')).toHaveLength(2)
    expect(findRawColors('#app { } const x = "#hello"')).toHaveLength(0)
    expect(findRawColors('#bad,\n#bed {')).toHaveLength(0)
    expect(findRawColors('background: linear-gradient(#fff, #000)')).toHaveLength(2)
  })

  it('finds no raw colors in the web app sources', () => {
    expect(lintTokens()).toEqual([])
  })

  it('rejects themed groups with extra children', () => {
    expect(() => collectTokens({ a: { dark: { $value: '#000000' }, light: { $value: '#ffffff' }, extra: { $value: '#111111' } } })).toThrow(/only dark and light/)
    expect(() => collectTokens({ a: { dark: { $value: '#000000' } } })).toThrow(/only dark and light/)
  })
})
