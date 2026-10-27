<template>
  <div
    :aria-describedby="hintId"
    :aria-label="ariaLabel"
    class="ah-editor"
    role="group"
  >
    <span :id="hintId" class="ah-editor__hint">
      Press Ctrl+M to toggle whether Tab moves focus out of the editor.
    </span>

    <div v-if="loading" class="ah-editor__loading" role="status">
      <v-progress-circular indeterminate size="20" width="2" />
      <span>Loading editor</span>
    </div>

    <div ref="host" class="ah-editor__host" />
  </div>
</template>

<script lang="ts" setup>
  import type * as MonacoApi from 'monaco-editor/editor/editor.api'
  import type { ISelection, editor as MonacoEditor } from 'monaco-editor/editor/editor.api'
  import { onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
  import { useTheme } from 'vuetify'
  import { editorFontFamily, editorFontSize, themeName } from './monacoTheme'

  export type EditorLanguage = 'markdown' | 'yaml' | 'json' | 'plaintext'

  const props = withDefaults(defineProps<{
    modelValue: string
    language?: EditorLanguage
    readonly?: boolean
    ariaLabel: string
    path?: string
    wordWrap?: boolean
  }>(), {
    language: 'markdown',
    readonly: false,
    path: undefined,
    wordWrap: undefined,
  })

  const emit = defineEmits<{
    'update:modelValue': [value: string]
    'save': []
    'ready': []
  }>()

  const host = ref<HTMLElement>()
  const loading = ref(true)
  const hintId = `ah-editor-hint-${useId()}`
  const theme = useTheme()

  let instance: MonacoEditor.IStandaloneCodeEditor | undefined
  let monacoApi: typeof MonacoApi | undefined
  let disposed = false

  const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const wrapMode = () => (props.wordWrap ?? props.language === 'markdown') ? 'on' : 'off'
  const languageId = (language: EditorLanguage, frontmatter: string) => language === 'markdown' ? frontmatter : language

  onMounted(async () => {
    const loader = await import('./monacoLoader')
    if (disposed || !host.value) {
      return
    }
    const monaco = loader.loadMonaco()
    monacoApi = monaco
    const language = languageId(props.language, loader.FRONTMATTER_LANGUAGE)
    const uri = props.path ? monaco.Uri.file(props.path) : undefined
    const model = (uri && monaco.editor.getModel(uri)) || monaco.editor.createModel(props.modelValue, language, uri)
    if (model.getValue() !== props.modelValue) {
      model.setValue(props.modelValue)
    }
    const motion = reducedMotion()
    instance = monaco.editor.create(host.value, {
      model,
      theme: themeName(theme.global.current.value.dark),
      ariaLabel: props.ariaLabel,
      readOnly: props.readonly,
      wordWrap: wrapMode(),
      fontFamily: editorFontFamily,
      fontSize: editorFontSize,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      cursorSmoothCaretAnimation: motion ? 'off' : 'on',
      smoothScrolling: !motion,
    })
    instance.onDidChangeModelContent(() => {
      const value = instance?.getValue() ?? ''
      if (value !== props.modelValue) {
        // eslint-disable-next-line vue/custom-event-name-casing
        emit('update:modelValue', value)
      }
    })
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => emit('save'))
    loading.value = false
    emit('ready')
  })

  watch(() => props.modelValue, value => {
    if (instance && instance.getValue() !== value) {
      instance.setValue(value)
    }
  })
  watch(() => props.readonly, readOnly => instance?.updateOptions({ readOnly }))
  watch(() => props.ariaLabel, label => instance?.updateOptions({ ariaLabel: label }))
  watch(() => [props.wordWrap, props.language], () => instance?.updateOptions({ wordWrap: wrapMode() }))
  watch(() => theme.global.current.value.dark, dark => monacoApi?.editor.setTheme(themeName(dark)))

  onBeforeUnmount(() => {
    disposed = true
    const model = instance?.getModel()
    instance?.dispose()
    model?.dispose()
  })

  defineExpose({
    focus: () => instance?.focus(),
    getSelection: (): ISelection | null => instance?.getSelection() ?? null,
  })
</script>

<style scoped>
.ah-editor {
  position: relative;
  min-height: 160px;
  overflow: hidden;
  border: 1px solid var(--ah-color-border-default);
  border-radius: var(--ah-radius-md);
  background: var(--ah-color-bg-canvas);
}

.ah-editor__host {
  position: absolute;
  inset: 0;
}

.ah-editor__loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--ah-space-2);
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-sm);
}

.ah-editor__hint {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
