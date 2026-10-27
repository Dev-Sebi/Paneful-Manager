import * as monaco from 'monaco-editor/editor/editor.api'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { conf as mdConf, language as mdLanguage } from 'monaco-editor/languages/definitions/markdown/markdown'
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker'
import { MONACO_DARK_THEME, MONACO_LIGHT_THEME, monacoDarkTheme, monacoLightTheme } from './monacoTheme'
import 'monaco-editor/languages/definitions/markdown/register'
import 'monaco-editor/languages/definitions/yaml/register'
import 'monaco-editor/languages/features/json/register'
// Curated editor features instead of the full editor.main bundle.
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import 'monaco-editor/editor/contrib/comment/browser/comment'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu'
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo'
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/folding/browser/folding'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution'
import 'monaco-editor/editor/contrib/indentation/browser/indentation'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations'
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor'
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect'
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController'
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode'
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations'
import 'monaco-editor/editor/browser/coreCommands'

export const FRONTMATTER_LANGUAGE = 'markdown-frontmatter'

/**
 * Markdown whose `---` block on line 1 is tokenized as YAML. The `start` state is only
 * the initial state, so it must leave on line 1 whether that line is empty or not.
 */
function registerFrontmatterLanguage (): void {
  monaco.languages.register({ id: FRONTMATTER_LANGUAGE })
  monaco.languages.setLanguageConfiguration(FRONTMATTER_LANGUAGE, mdConf)
  monaco.languages.setMonarchTokensProvider(FRONTMATTER_LANGUAGE, {
    ...mdLanguage,
    tokenizer: {
      start: [
        [/^---\s*$/, { token: 'meta.tag', next: '@frontmatter', nextEmbedded: 'yaml' }],
        [/^$/, { token: '', switchTo: '@root' }],
        [/(?=.)/, { token: '', switchTo: '@root' }],
      ],
      frontmatter: [
        [/^---\s*$/, { token: '@rematch', switchTo: '@frontmatterEnd', nextEmbedded: '@pop' }],
        [/.+/, ''],
      ],
      frontmatterEnd: [
        [/^---\s*$/, { token: 'meta.tag', switchTo: '@root' }],
      ],
      ...mdLanguage.tokenizer,
    },
  })
}

let setup = false

function setupMonaco (): void {
  if (setup) {
    return
  }
  setup = true
  self.MonacoEnvironment = {
    getWorker: (_id: string, label: string) => label === 'json' ? new JsonWorker() : new EditorWorker(),
  }
  registerFrontmatterLanguage()
  monaco.editor.defineTheme(MONACO_DARK_THEME, monacoDarkTheme)
  monaco.editor.defineTheme(MONACO_LIGHT_THEME, monacoLightTheme)
}

export function loadMonaco (): typeof monaco {
  setupMonaco()
  return monaco
}
