import type { editor } from 'monaco-editor/editor/editor.api'
import { darkTheme, lightTheme, xtermDarkTheme, xtermLightTheme } from '@/styles/generated/theme'
import { fontFamily, fontSize } from '@/styles/generated/tokens'

export const MONACO_DARK_THEME = 'paneful-manager-dark'
export const MONACO_LIGHT_THEME = 'paneful-manager-light'

export const editorFontFamily = fontFamily.mono
export const editorFontSize = fontSize.md

const hex = (value: unknown): string => (typeof value === 'string' ? value : '').replace(/^#/, '')

/**
 * Markdown tokens. Dark keeps the base palette; light takes the darker `bright*` steps and styles
 * more token kinds, so every one keeps a comfortable WCAG AA margin on the light editor background,
 * its line highlight and the selection.
 */
function markdownRules (c: (name: string) => string, dark: boolean): editor.ITokenThemeRule[] {
  if (dark) {
    return [
      { token: 'keyword.md', foreground: c('blue'), fontStyle: 'bold' },
      { token: 'string.link.md', foreground: c('cyan'), fontStyle: 'underline' },
      { token: 'variable.source.md', foreground: c('yellow') },
    ]
  }
  return [
    { token: 'keyword.md', foreground: c('brightBlue'), fontStyle: 'bold' },
    { token: 'string.link.md', foreground: c('brightCyan'), fontStyle: 'underline' },
    { token: 'string.target.md', foreground: c('brightGreen') },
    { token: 'variable.md', foreground: c('brightYellow') },
    { token: 'variable.source.md', foreground: c('brightYellow') },
    { token: 'string.md', foreground: c('brightGreen') },
    { token: 'comment.md', foreground: c('brightMagenta'), fontStyle: 'italic' },
    { token: 'meta.separator.md', foreground: c('brightMagenta') },
    { token: 'tag.md', foreground: c('brightRed') },
    { token: 'attribute.name.html.md', foreground: c('brightBlue') },
  ]
}

function build (
  dark: boolean,
  ui: Record<string, unknown>,
  palette: Record<string, string>,
): editor.IStandaloneThemeData {
  const c = (name: string) => hex(palette[name])
  const u = (name: string) => `#${hex(ui[name])}`
  const rule = (token: string, color: string, fontStyle?: string): editor.ITokenThemeRule =>
    fontStyle ? { token, foreground: color, fontStyle } : { token, foreground: color }

  return {
    base: dark ? 'vs-dark' : 'vs',
    inherit: false,
    rules: [
      rule('', c('foreground')),
      rule('comment', c('brightBlack'), 'italic'),
      rule('keyword', c('magenta')),
      rule('string', c('green')),
      rule('number', c('yellow')),
      rule('type', c('cyan')),
      rule('tag', c('red')),
      rule('meta.tag', c('brightBlack')),
      rule('attribute.name', c('blue')),
      rule('string.key.json', c('blue')),
      rule('string.value.json', c('green')),
      rule('keyword.json', c('magenta')),
      rule('strong', c('foreground'), 'bold'),
      rule('emphasis', c('foreground'), 'italic'),
      ...markdownRules(c, dark),
      rule('delimiter', c('brightBlack')),
    ],
    colors: {
      'editor.background': u('background'),
      'editor.foreground': `#${c('foreground')}`,
      'editorCursor.foreground': `#${c('cursor')}`,
      'editor.selectionBackground': `#${c('selectionBackground')}`,
      'editor.lineHighlightBackground': u('surface'),
      'editorLineNumber.foreground': `#${c('brightBlack')}`,
      'editorLineNumber.activeForeground': u('on-surface'),
      'editorWidget.background': u('surface-bright'),
      'editorWidget.border': u('secondary'),
      'editorSuggestWidget.selectedBackground': u('surface-light'),
      'editorIndentGuide.background1': u('secondary'),
      'input.background': u('surface'),
      'focusBorder': u('primary'),
      'editorBracketHighlight.foreground1': u('primary'),
      'editorBracketHighlight.foreground2': u('warning'),
      'editorBracketHighlight.foreground3': u('success'),
      'editorBracketHighlight.foreground4': u('info'),
      'editorBracketHighlight.foreground5': u('secondary-darken-1'),
      'editorBracketHighlight.foreground6': u('error'),
      'editorBracketHighlight.unexpectedBracket.foreground': u('error'),
    },
  }
}

export const monacoDarkTheme = build(true, darkTheme.colors ?? {}, xtermDarkTheme)
export const monacoLightTheme = build(false, lightTheme.colors ?? {}, xtermLightTheme)

export function themeName (dark: boolean): string {
  return dark ? MONACO_DARK_THEME : MONACO_LIGHT_THEME
}
