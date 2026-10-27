<template>
  <section
    :aria-label="`Terminal: ${title}`"
    class="ah-terminal-pane"
    :class="{
      'ah-terminal-pane--focused': focused,
      'ah-terminal-pane--maximized': maximized,
      'ah-terminal-pane--readonly': readonly,
    }"
    role="group"
    @keydown="onKeydown"
    @mousedown="onPointerDown"
  >
    <header v-if="!hideHeader" ref="headerRef" class="ah-terminal-pane__header">
      <AhStatusBadge v-if="status" announce :state="status" variant="dot" />
      <span class="ah-terminal-pane__title">{{ title }}</span>
      <span v-if="cwd" class="ah-terminal-pane__cwd" :title="cwd"><bdi>{{ cwd }}</bdi></span>
      <span v-else class="ah-terminal-pane__spacer" />
      <span v-if="readonly" class="ah-terminal-pane__readonly">Read-only</span>

      <slot name="header-actions" />

      <AhButton
        ariaLabel="Split vertical"
        icon="mdi-arrow-split-vertical"
        :shortcut="shortcutLabel('split-vertical')"
        size="sm"
        variant="ghost"
        @click="emit('split', 'vertical')"
      />

      <AhButton
        ariaLabel="Split horizontal"
        icon="mdi-arrow-split-horizontal"
        :shortcut="shortcutLabel('split-horizontal')"
        size="sm"
        variant="ghost"
        @click="emit('split', 'horizontal')"
      />

      <AhButton
        :ariaLabel="maximized ? 'Restore' : 'Maximize'"
        :icon="maximized ? 'mdi-arrow-collapse' : 'mdi-arrow-expand'"
        :pressed="maximized"
        :shortcut="shortcutLabel('toggle-maximize')"
        size="sm"
        variant="ghost"
        @click="emit('toggle-maximize')"
      />

      <AhButton
        ariaLabel="Close pane"
        icon="mdi-close"
        :shortcut="shortcutLabel('close')"
        size="sm"
        variant="ghost"
        @click="emit('close')"
      />
    </header>

    <div class="ah-terminal-pane__viewport">
      <div ref="termRef" class="ah-terminal-pane__term" />

      <div
        v-if="shownConnection !== 'connected'"
        class="ah-terminal-pane__overlay"
        :class="`ah-terminal-pane__overlay--${shownConnection}`"
      >
        <slot :connection="shownConnection" :exit-code="shownExitCode" name="overlay">
          <div class="ah-terminal-pane__card" :role="shownConnection === 'failed' ? 'alert' : 'status'">
            <template v-if="shownConnection === 'connecting'">
              <span aria-hidden="true" class="ah-spinner ah-terminal-pane__spinner" />
              <span>Connecting…</span>
            </template>

            <template v-else-if="shownConnection === 'exited'">
              <span>Process exited{{ shownExitCode === undefined ? '' : ` (code ${shownExitCode})` }}</span>
              <AhButton size="sm" variant="secondary" @click="emit('restart')">Restart</AhButton>
            </template>

            <template v-else>
              <span class="ah-terminal-pane__failed">Session unavailable</span>
              <AhButton size="sm" variant="secondary" @click="retry">Retry</AhButton>
            </template>
          </div>
        </slot>
      </div>
    </div>
  </section>
</template>

<script lang="ts" setup>
  import type { AhTerminalConnection, AhTerminalPaneEmits, AhTerminalPaneExpose, AhTerminalPaneProps, AhTerminalPaneSlots } from './types'
  import type { SessionAttach } from '@/terminal/attach'
  import type { PaneShortcutAction } from '@/terminal/shortcuts'
  import { FitAddon } from '@xterm/addon-fit'
  import { Unicode11Addon } from '@xterm/addon-unicode11'
  import { WebLinksAddon } from '@xterm/addon-web-links'
  import { Terminal } from '@xterm/xterm'
  import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
  import { useTheme } from 'vuetify'
  import { wsClient } from '@/api/ws'
  import { useUiStore } from '@/stores/ui'
  import { xtermDarkTheme, xtermLightTheme } from '@/styles/generated/theme'
  import { fontFamily, fontSize as fontSizes, lineHeight } from '@/styles/generated/tokens'
  import { useSessionAttach } from '@/terminal/attach'
  import { matchShortcut, shortcutLabel } from '@/terminal/shortcuts'
  import AhButton from './AhButton.vue'
  import AhStatusBadge from './AhStatusBadge.vue'
  import '@xterm/xterm/css/xterm.css'

  const props = withDefaults(defineProps<AhTerminalPaneProps>(), {
    cwd: undefined,
    status: undefined,
    connection: 'connecting',
    exitCode: undefined,
    focused: false,
    maximized: false,
    fontSize: fontSizes.md,
    cursorStyle: 'block',
    cursorBlink: true,
    scrollback: 10_000,
    readonly: false,
    hideHeader: false,
  })

  const emit = defineEmits<AhTerminalPaneEmits>()
  defineSlots<AhTerminalPaneSlots>()

  const theme = useTheme()
  const ui = useUiStore()

  const termRef = ref<HTMLElement>()
  const headerRef = ref<HTMLElement>()
  const term = shallowRef<Terminal>()
  const binding = shallowRef<SessionAttach>()
  const liveExitCode = ref<number>()
  let fitAddon: FitAddon | undefined
  let observer: ResizeObserver | undefined
  let hidden = true
  let fitFrame: number | undefined
  const disposers: Array<() => void> = []

  const shownConnection = computed<AhTerminalConnection>(() => {
    if (props.connection === 'exited' || props.connection === 'failed') {
      return props.connection
    }
    return binding.value?.connection.value ?? 'connecting'
  })
  const shownExitCode = computed(() => props.exitCode ?? liveExitCode.value)

  const motionQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined
  const reducedMotion = ref(motionQuery?.matches ?? false)
  function onMotionChange (event: MediaQueryListEvent) {
    reducedMotion.value = event.matches
  }
  motionQuery?.addEventListener('change', onMotionChange)
  disposers.push(() => motionQuery?.removeEventListener('change', onMotionChange))

  function xtermTheme () {
    return theme.current.value.dark ? xtermDarkTheme : xtermLightTheme
  }

  /** Fits to the container. A hidden pane (inactive tab) detaches; shown again it re-attaches at its new size. */
  function fit (): void {
    const el = termRef.value
    const instance = term.value
    if (!el || !instance || !fitAddon) {
      return
    }
    if (el.offsetWidth === 0 || el.offsetHeight === 0) {
      hidden = true
      binding.value?.pause()
      return
    }
    const dims = fitAddon.proposeDimensions()
    if (!dims || !(dims.cols >= 1) || !(dims.rows >= 1)) {
      return
    }
    const wasHidden = hidden
    hidden = false
    if (dims.cols !== instance.cols || dims.rows !== instance.rows) {
      instance.resize(dims.cols, dims.rows)
      emit('resize', { cols: instance.cols, rows: instance.rows })
    }
    if (binding.value && wasHidden) {
      binding.value.resume()
    } else if (binding.value) {
      binding.value.resize(instance.cols, instance.rows)
    } else {
      bind(instance)
    }
  }

  /** Coalesces observer callbacks into one fit per frame; fitting inside the callback would loop. */
  function scheduleFit (): void {
    if (fitFrame === undefined) {
      fitFrame = requestAnimationFrame(() => {
        fitFrame = undefined
        fit()
      })
    }
  }

  /** Attaches once the pane has a real size, so a hidden pane never shrinks the shared tmux session. */
  function bind (instance: Terminal): void {
    binding.value = useSessionAttach(props.sessionId, instance, {
      client: wsClient,
      isReadonly: () => props.readonly,
      onInput: data => emit('input', data),
      onState: message => {
        liveExitCode.value = message.exitCode
        emit('state', { state: message.state, lifecycle: message.lifecycle, exitCode: message.exitCode })
      },
      onExited: () => emit('exited'),
      onInputDropped: () => ui.notify('Input discarded: connection unavailable'),
    })
  }

  function retry (): void {
    binding.value?.retry()
  }

  function focus (): void {
    term.value?.focus()
  }

  async function copySelection (): Promise<void> {
    const text = term.value?.getSelection() ?? ''
    if (text) {
      await navigator.clipboard?.writeText(text).catch(() => ui.notify('Could not copy to the clipboard', 'error'))
    }
  }

  function cycleFocus (): void {
    const header = headerRef.value
    if (header?.contains(document.activeElement)) {
      focus()
    } else {
      header?.querySelector<HTMLElement>('button')?.focus()
    }
  }

  const ACTIONS: Record<PaneShortcutAction, () => void> = {
    'copy': () => void copySelection(),
    'split-vertical': () => emit('split', 'vertical'),
    'split-horizontal': () => emit('split', 'horizontal'),
    'toggle-maximize': () => emit('toggle-maximize'),
    'close': () => emit('close'),
    'cycle-focus': cycleFocus,
  }

  function onKeydown (event: KeyboardEvent): void {
    const shortcut = matchShortcut(event)
    if (shortcut) {
      event.preventDefault()
      event.stopPropagation()
      ACTIONS[shortcut.action]()
    }
  }

  function onPointerDown (event: MouseEvent): void {
    const target = event.target
    if (target instanceof Element && !target.closest('button, .ah-terminal-pane__overlay')) {
      requestAnimationFrame(focus)
    }
  }

  watch(() => theme.current.value.dark, () => {
    if (term.value) {
      term.value.options.theme = xtermTheme()
    }
  })

  watch(() => [props.focused, props.cursorBlink, props.cursorStyle, props.fontSize, props.readonly, reducedMotion.value] as const, () => {
    const instance = term.value
    if (!instance) {
      return
    }
    instance.options.cursorBlink = props.focused && props.cursorBlink && !reducedMotion.value
    instance.options.cursorStyle = props.cursorStyle
    instance.options.disableStdin = props.readonly
    if (instance.options.fontSize !== props.fontSize) {
      instance.options.fontSize = props.fontSize
      fit()
    }
  })

  watch(() => props.focused, focused => {
    if (focused) {
      focus()
    }
  })

  watch(() => props.maximized, scheduleFit)

  onMounted(() => {
    const el = termRef.value
    if (!el) {
      return
    }
    const instance = new Terminal({
      // Unicode11Addon sets `term.unicode.activeVersion`, which xterm still marks as proposed API.
      allowProposedApi: true,
      cursorBlink: props.focused && props.cursorBlink && !reducedMotion.value,
      cursorInactiveStyle: props.readonly ? 'none' : 'outline',
      cursorStyle: props.cursorStyle,
      disableStdin: props.readonly,
      fontFamily: fontFamily.mono,
      fontSize: props.fontSize,
      lineHeight: lineHeight.normal,
      scrollback: props.scrollback,
      theme: xtermTheme(),
    })
    fitAddon = new FitAddon()
    instance.loadAddon(fitAddon)
    // Correct cell widths for emoji and CJK, which Claude Code output uses.
    const unicode = new Unicode11Addon()
    instance.loadAddon(unicode)
    instance.unicode.activeVersion = '11'
    // Clickable URLs in agent output.
    instance.loadAddon(new WebLinksAddon())
    instance.attachCustomKeyEventHandler(event => matchShortcut(event) === undefined)
    instance.open(el)
    term.value = instance

    const titleSubscription = instance.onTitleChange(title => emit('title-change', title))
    disposers.push(() => titleSubscription.dispose())
    const textarea = instance.textarea
    if (textarea) {
      const onFocus = () => emit('focus')
      textarea.addEventListener('focus', onFocus)
      disposers.push(() => textarea.removeEventListener('focus', onFocus))
    }

    observer = new ResizeObserver(scheduleFit)
    observer.observe(el)
    fit()
    if (props.focused) {
      focus()
    }
  })

  onBeforeUnmount(() => {
    observer?.disconnect()
    if (fitFrame !== undefined) {
      cancelAnimationFrame(fitFrame)
    }
    binding.value?.dispose()
    for (const dispose of disposers) {
      dispose()
    }
    term.value?.dispose()
  })

  defineExpose<AhTerminalPaneExpose>({
    write: data => term.value?.write(data),
    clear: () => term.value?.clear(),
    focus,
    fit,
    getSelection: () => term.value?.getSelection() ?? '',
  })
</script>

<style scoped>
.ah-terminal-pane {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  border: 1px solid var(--ah-color-border-default);
  border-radius: var(--ah-radius-sm);
  background: var(--ah-color-terminal-bg);
  transition: border-color var(--ah-motion-duration-fast) var(--ah-motion-easing-standard);
}

.ah-terminal-pane--focused { border-color: var(--ah-color-border-focus); }

.ah-terminal-pane--maximized {
  position: absolute;
  inset: 0;
  z-index: var(--ah-z-overlay);
}

.ah-terminal-pane__header {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--ah-space-2);
  height: 28px;
  padding: 0 var(--ah-space-2);
  background: var(--ah-color-bg-surface);
  color: var(--ah-color-fg-muted);
  font-family: var(--ah-font-family-ui);
  font-size: var(--ah-font-size-sm);
  font-weight: var(--ah-font-weight-medium);
}

.ah-terminal-pane--focused .ah-terminal-pane__title { color: var(--ah-color-fg-primary); }

.ah-terminal-pane__title {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* rtl + bdi truncates from the start while the path itself keeps its order. */
.ah-terminal-pane__cwd {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  direction: rtl;
  text-align: left;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ah-color-fg-muted);
  font-family: var(--ah-font-family-mono);
  font-size: var(--ah-font-size-xs);
  font-weight: var(--ah-font-weight-regular);
}

.ah-terminal-pane__spacer { flex: 1; }

.ah-terminal-pane__readonly {
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-xs);
}

.ah-terminal-pane__viewport {
  position: relative;
  flex: 1;
  min-height: 0;
  padding: var(--ah-space-2);
}

.ah-terminal-pane__term {
  width: 100%;
  height: 100%;
}

.ah-terminal-pane--readonly :deep(.xterm-cursor) { visibility: hidden; }

/* Non-blocking: the terminal stays readable and scrollable under the overlay. */
.ah-terminal-pane__overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
}

.ah-terminal-pane__card {
  display: flex;
  align-items: center;
  gap: var(--ah-space-2);
  padding: var(--ah-space-2) var(--ah-space-4);
  border-radius: var(--ah-radius-md);
  background: var(--ah-color-bg-elevated);
  box-shadow: var(--ah-shadow-2);
  color: var(--ah-color-fg-primary);
  font-family: var(--ah-font-family-ui);
  font-size: var(--ah-font-size-md);
  pointer-events: auto;
}

.ah-terminal-pane__failed { color: var(--ah-color-status-error); }

.ah-terminal-pane__spinner {
  flex: none;
  box-sizing: border-box;
  width: 14px;
  height: 14px;
  border: 2px solid currentcolor;
  border-top-color: transparent;
  border-radius: var(--ah-radius-full);
}
</style>
