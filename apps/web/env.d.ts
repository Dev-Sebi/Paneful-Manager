/// <reference types="vite/client" />
/// <reference types="vite-plugin-vue-layouts-next/client" />

declare module 'monaco-editor/editor/editor.worker?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}

declare module 'monaco-editor/languages/features/json/json.worker?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}

declare module 'monaco-editor/languages/definitions/markdown/markdown' {
  import type { languages } from 'monaco-editor/editor/editor.api'
  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage
}

declare module 'monaco-editor/editor/contrib/*' {}
