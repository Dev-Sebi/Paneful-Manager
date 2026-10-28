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

function linear (value: number): number {
  const v = value / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function luminance (hexColor: string): number {
  const [r = 0, g = 0, b = 0] = [0, 2, 4].map(i => linear(Number.parseInt(hexColor.slice(i, i + 2), 16)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast (a: string, b: string): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** Blends a #rrggbbaa overlay onto an opaque #rrggbb background. */
function blend (overlay: string, base: string): string {
  const alpha = Number.parseInt(overlay.slice(6, 8), 16) / 255
  return [0, 2, 4].map(i => {
    const mixed = Math.round(Number.parseInt(overlay.slice(i, i + 2), 16) * alpha + Number.parseInt(base.slice(i, i + 2), 16) * (1 - alpha))
    return mixed.toString(16).padStart(2, '0')
  }).join('')
}

const AA = 4.5
const MARKDOWN_TOKENS = new Set([
  'keyword.md', 'string.link.md', 'string.target.md', 'variable.md', 'variable.source.md', 'string.md',
  'comment.md', 'meta.separator.md', 'tag.md', 'attribute.name.html.md',
])

describe('light theme contrast', () => {
  const background = (monacoLightTheme.colors['editor.background'] ?? '').slice(1)
  const lineHighlight = (monacoLightTheme.colors['editor.lineHighlightBackground'] ?? '').slice(1)
  const selection = blend((monacoLightTheme.colors['editor.selectionBackground'] ?? '').slice(1), background)

  it('keeps every token rule at WCAG AA on the editor background and line highlight', () => {
    for (const rule of monacoLightTheme.rules) {
      for (const surface of [background, lineHighlight]) {
        expect(contrast(rule.foreground ?? '', surface), `${rule.token} on #${surface}`).toBeGreaterThanOrEqual(AA)
      }
    }
  })

  it('keeps markdown tokens at WCAG AA on selected text too', () => {
    for (const rule of monacoLightTheme.rules.filter(item => MARKDOWN_TOKENS.has(item.token))) {
      expect(contrast(rule.foreground ?? '', selection), `${rule.token} on #${selection}`).toBeGreaterThanOrEqual(AA)
    }
  })
})

describe('light markdown tokens', () => {
  it('styles every markdown token kind with its own rule', () => {
    const tokens = monacoLightTheme.rules.map(rule => rule.token)
    for (const token of MARKDOWN_TOKENS) {
      expect(tokens, token).toContain(token)
    }
  })

  it('uses the stronger palette steps, at least 5.5:1 on the editor background', () => {
    const background = (monacoLightTheme.colors['editor.background'] ?? '').slice(1)
    for (const rule of monacoLightTheme.rules.filter(item => MARKDOWN_TOKENS.has(item.token))) {
      expect(contrast(rule.foreground ?? '', background), rule.token).toBeGreaterThanOrEqual(5.5)
    }
  })
})

it('leaves the dark markdown rules as they were', () => {
  const dark = monacoDarkTheme.rules.filter(rule => rule.token.endsWith('.md'))
  expect(dark.map(rule => rule.token)).toEqual(['keyword.md', 'string.link.md', 'variable.source.md'])
})
