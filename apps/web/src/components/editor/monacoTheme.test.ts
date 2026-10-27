import { describe, expect, it } from 'vitest'
import { monacoDarkTheme, monacoLightTheme, themeName } from './monacoTheme'

const RULE_COLOR = /^[\da-f]{6}(?:[\da-f]{2})?$/i
const UI_COLOR = /^#[\da-f]{6}(?:[\da-f]{2})?$/i

describe.each([
  ['dark', monacoDarkTheme, 'vs-dark'],
  ['light', monacoLightTheme, 'vs'],
])('%s theme', (_name, theme, base) => {
  it('uses the right base', () => {
    expect(theme.base).toBe(base)
  })

  it('has hex rule colors without a hash', () => {
    expect(theme.rules.length).toBeGreaterThan(0)
    for (const rule of theme.rules) {
      expect(rule.foreground, rule.token).toMatch(RULE_COLOR)
    }
  })

  it('has hex ui colors (Monaco requires the hash there)', () => {
    for (const [key, value] of Object.entries(theme.colors)) {
      expect(value, key).toMatch(UI_COLOR)
    }
  })
})

it('maps vuetify mode to theme names', () => {
  expect(themeName(true)).not.toBe(themeName(false))
})
