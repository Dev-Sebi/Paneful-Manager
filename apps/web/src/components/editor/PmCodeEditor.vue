<template>
  <div class="pm-editor">
    <span :id="hintId" class="pm-editor__hint">
      Press Ctrl+M (Ctrl+Shift+M on macOS) to toggle whether Tab moves focus out of the editor.
    </span>

    <div v-if="loading" class="pm-editor__loading" role="status">
      <v-progress-circular indeterminate size="20" width="2" />
      <span>Loading editor</span>
    </div>

    <div ref="host" class="pm-editor__host" />
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
  const hintId = `pm-editor-hint-${useId()}`
  const theme = useTheme()

  let instance: MonacoEditor.IStandaloneCodeEditor | undefined
  let monacoApi: typeof MonacoApi | undefined
  let frontmatterLanguage = 'markdown'
  let ownsModel = false
  let disposed = false
  let motionQuery: MediaQueryList | undefined

  const wrapMode = () => (props.wordWrap ?? props.language === 'markdown') ? 'on' : 'off'
  const languageId = () => props.language === 'markdown' ? frontmatterLanguage : props.language

  function motionOptions (reduced: boolean): MonacoEditor.IEditorOptions {
    return {
      cursorSmoothCaretAnimation: reduced ? 'off' : 'on',
      cursorBlinking: reduced ? 'solid' : 'blink',
      smoothScrolling: !reduced,
    }
  }

  /** Replaces the whole text as undoable edits so undo history and cursor survive. */
  function applyExternalValue (model: MonacoEditor.ITextModel, value: string): void {
    model.pushStackElement()
    model.pushEditOperations(instance?.getSelections() ?? null, [{ range: model.getFullModelRange(), text: value }], () => null)
    model.pushStackElement()
  }

  /** Reuses a model registered for `path`; otherwise creates (and later disposes) its own. */
  function acquireModel (monaco: typeof MonacoApi): { model: MonacoEditor.ITextModel, owned: boolean } {
    const uri = props.path ? monaco.Uri.file(props.path) : undefined
    const existing = uri ? monaco.editor.getModel(uri) : null
    if (existing) {
      monaco.editor.setModelLanguage(existing, languageId())
      return { model: existing, owned: false }
    }
    return { model: monaco.editor.createModel(props.modelValue, languageId(), uri), owned: true }
  }

  function swapModel (): void {
    if (!instance || !monacoApi) {
      return
    }
    const previous = instance.getModel()
    const wasOwned = ownsModel
    const { model, owned } = acquireModel(monacoApi)
    ownsModel = owned
    instance.setModel(model)
    if (wasOwned) {
      previous?.dispose()
    }
    if (model.getValue() !== props.modelValue) {
      applyExternalValue(model, props.modelValue)
    }
  }

  onMounted(async () => {
    const loader = await import('./monacoLoader')
    if (disposed || !host.value) {
      return
    }
    const monaco = loader.loadMonaco()
    monacoApi = monaco
    frontmatterLanguage = loader.FRONTMATTER_LANGUAGE
    const { model, owned } = acquireModel(monaco)
    ownsModel = owned
    motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined
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
      ...motionOptions(motionQuery?.matches ?? false),
    })
    if (model.getValue() !== props.modelValue) {
      applyExternalValue(model, props.modelValue)
    }
    host.value.querySelector('textarea, .native-edit-context')?.setAttribute('aria-describedby', hintId)
    motionQuery?.addEventListener('change', onMotionChange)
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

  function onMotionChange (event: MediaQueryListEvent): void {
    instance?.updateOptions(motionOptions(event.matches))
  }

  watch(() => props.modelValue, value => {
    const model = instance?.getModel()
    if (model && model.getValue() !== value) {
      applyExternalValue(model, value)
    }
  })
  watch(() => props.path, swapModel)
  watch(() => props.language, () => {
    const model = instance?.getModel()
    if (model) {
      monacoApi?.editor.setModelLanguage(model, languageId())
    }
    instance?.updateOptions({ wordWrap: wrapMode() })
  })
  watch(() => props.wordWrap, () => instance?.updateOptions({ wordWrap: wrapMode() }))
  watch(() => props.readonly, readOnly => instance?.updateOptions({ readOnly }))
  watch(() => props.ariaLabel, label => instance?.updateOptions({ ariaLabel: label }))
  watch(() => theme.global.current.value.dark, dark => monacoApi?.editor.setTheme(themeName(dark)))

  onBeforeUnmount(() => {
    disposed = true
    motionQuery?.removeEventListener('change', onMotionChange)
    const model = instance?.getModel()
    instance?.dispose()
    if (ownsModel) {
      model?.dispose()
    }
  })

  defineExpose({
    focus: () => instance?.focus(),
    getSelection: (): ISelection | null => instance?.getSelection() ?? null,
  })
</script>

<style scoped>
.pm-editor {
  position: relative;
  min-height: 160px;
  overflow: hidden;
  border: 1px solid var(--pm-color-border-default);
  border-radius: var(--pm-radius-md);
  background: var(--pm-color-bg-canvas);
}

.pm-editor__host {
  position: absolute;
  inset: 0;
}

.pm-editor__loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--pm-space-2);
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-sm);
}

.pm-editor__hint {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
