<template>
  <section
    :aria-label="`Terminal: ${title}`"
    class="pm-terminal-pane"
    :class="{
      'pm-terminal-pane--focused': focused,
      'pm-terminal-pane--maximized': maximized,
      'pm-terminal-pane--readonly': readonly,
    }"
    role="group"
    @keydown="onKeydown"
    @mousedown="onPointerDown"
  >
    <header v-if="!hideHeader" ref="headerRef" class="pm-terminal-pane__header">
      <PmStatusBadge v-if="status" announce :state="status" variant="dot" />
      <span class="pm-terminal-pane__title">{{ title }}</span>
      <span v-if="stateLabel" class="pm-terminal-pane__since" data-testid="pane-state-since">{{ stateLabel }}</span>

      <span v-if="member" class="pm-terminal-pane__member" :title="memberTooltip">
        <span class="pm-terminal-pane__member-name">{{ member.name }}</span>
        <PmStatusBadge :label="member.role" size="sm" state="idle" />
        <span v-if="member.others?.length" class="pm-terminal-pane__member-more">+{{ member.others.length }}</span>
      </span>

      <span v-if="cwd" class="pm-terminal-pane__cwd" :title="cwd"><bdi>{{ cwd }}</bdi></span>
      <span v-else class="pm-terminal-pane__spacer" />
      <span v-if="readonly" class="pm-terminal-pane__readonly">Read-only</span>

      <slot name="header-actions" />

      <PmButton
        ariaLabel="Split vertical"
        icon="mdi-arrow-split-vertical"
        :shortcut="shortcutLabel('split-vertical')"
        size="sm"
        variant="ghost"
        @click="emit('split', 'vertical')"
      />

      <PmButton
        ariaLabel="Split horizontal"
        icon="mdi-arrow-split-horizontal"
        :shortcut="shortcutLabel('split-horizontal')"
        size="sm"
        variant="ghost"
        @click="emit('split', 'horizontal')"
      />

      <PmButton
        :ariaLabel="maximized ? 'Restore' : 'Maximize'"
        :icon="maximized ? 'mdi-arrow-collapse' : 'mdi-arrow-expand'"
        :pressed="maximized"
        :shortcut="shortcutLabel('toggle-maximize')"
        size="sm"
        variant="ghost"
        @click="emit('toggle-maximize')"
      />

      <PmButton
        ariaLabel="Close pane"
        icon="mdi-close"
        :shortcut="shortcutLabel('close')"
        size="sm"
        variant="ghost"
        @click="emit('close')"
      />
    </header>

    <div class="pm-terminal-pane__viewport">
      <div ref="termRef" class="pm-terminal-pane__term" />

      <div
        v-if="shownConnection !== 'connected'"
        class="pm-terminal-pane__overlay"
        :class="`pm-terminal-pane__overlay--${shownConnection}`"
      >
        <slot :connection="shownConnection" :exit-code="shownExitCode" name="overlay">
          <div class="pm-terminal-pane__card" :role="shownConnection === 'failed' ? 'alert' : 'status'">
            <template v-if="shownConnection === 'connecting'">
              <span aria-hidden="true" class="pm-spinner pm-terminal-pane__spinner" />
              <span>Connecting…</span>
            </template>

            <template v-else-if="shownConnection === 'exited'">
              <span>Process exited{{ shownExitCode === undefined ? '' : ` (code ${shownExitCode})` }}</span>
              <PmButton size="sm" variant="secondary" @click="emit('restart')">Restart</PmButton>
            </template>

            <template v-else>
              <span class="pm-terminal-pane__failed">Session unavailable</span>
              <PmButton size="sm" variant="secondary" @click="retry">Retry</PmButton>
            </template>
          </div>
        </slot>
      </div>
    </div>
  </section>
</template>

<script lang="ts" setup>
  import type { PmTerminalConnection, PmTerminalPaneEmits, PmTerminalPaneExpose, PmTerminalPaneProps, PmTerminalPaneSlots } from './types'
  import type { SessionAttach } from '@/terminal/attach'
  import type { PaneShortcutAction } from '@/terminal/shortcuts'
  import { FitAddon } from '@xterm/addon-fit'
  import { Unicode11Addon } from '@xterm/addon-unicode11'
  import { WebLinksAddon } from '@xterm/addon-web-links'
  import { Terminal } from '@xterm/xterm'
  import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
  import { useTheme } from 'vuetify'
  import { wsClient } from '@/api/ws'
  import { formatElapsed, useNow } from '@/composables/useNow'
  import { useUiStore } from '@/stores/ui'
  import { xtermDarkTheme, xtermLightTheme } from '@/styles/generated/theme'
  import { fontFamily, fontSize as fontSizes, lineHeight } from '@/styles/generated/tokens'
  import { useSessionAttach } from '@/terminal/attach'
  import { matchShortcut, shortcutLabel } from '@/terminal/shortcuts'
  import PmButton from './PmButton.vue'
  import PmStatusBadge from './PmStatusBadge.vue'
  import '@xterm/xterm/css/xterm.css'

  const props = withDefaults(defineProps<PmTerminalPaneProps>(), {
    cwd: undefined,
    status: undefined,
    stateSince: undefined,
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
    member: undefined,
  })

  const emit = defineEmits<PmTerminalPaneEmits>()

  const now = useNow()
  const stateLabel = computed(() => {
    const since = props.stateSince ? Date.parse(props.stateSince) : Number.NaN
    if (!props.status || Number.isNaN(since) || shownConnection.value === 'exited') {
      return ''
    }
    return `${props.status} ${formatElapsed(now.value - since)}`
  })
  defineSlots<PmTerminalPaneSlots>()

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

  const shownConnection = computed<PmTerminalConnection>(() => {
    if (props.connection === 'exited' || props.connection === 'failed') {
      return props.connection
    }
    return binding.value?.connection.value ?? 'connecting'
  })
  const shownExitCode = computed(() => props.exitCode ?? liveExitCode.value)
  const memberTooltip = computed(() => {
    const others = props.member?.others ?? []
    return others.length > 0 ? `Same tmux window: ${others.join(', ')}` : undefined
  })

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
    if (target instanceof Element && !target.closest('button, .pm-terminal-pane__overlay')) {
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

  defineExpose<PmTerminalPaneExpose>({
    write: data => term.value?.write(data),
    clear: () => term.value?.clear(),
    focus,
    fit,
    getSelection: () => term.value?.getSelection() ?? '',
  })
</script>

<style scoped>
.pm-terminal-pane {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  border: 1px solid var(--pm-color-border-default);
  border-radius: var(--pm-radius-sm);
  background: var(--pm-color-terminal-bg);
  transition: border-color var(--pm-motion-duration-fast) var(--pm-motion-easing-standard);
}

.pm-terminal-pane--focused { border-color: var(--pm-color-border-focus); }

.pm-terminal-pane--maximized {
  position: absolute;
  inset: 0;
  z-index: var(--pm-z-overlay);
}

.pm-terminal-pane__header {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--pm-space-2);
  height: 28px;
  padding: 0 var(--pm-space-2);
  background: var(--pm-color-bg-surface);
  color: var(--pm-color-fg-muted);
  font-family: var(--pm-font-family-ui);
  font-size: var(--pm-font-size-sm);
  font-weight: var(--pm-font-weight-medium);
}

.pm-terminal-pane--focused .pm-terminal-pane__title { color: var(--pm-color-fg-primary); }

.pm-terminal-pane__since {
  flex: none;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.pm-terminal-pane__title {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.pm-terminal-pane__member {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--pm-space-1);
  max-width: 30%;
  min-width: 0;
}

.pm-terminal-pane__member-name {
  overflow: hidden;
  color: var(--pm-color-fg-primary);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.pm-terminal-pane__member-more { color: var(--pm-color-fg-muted); }

/* rtl + bdi truncates from the start while the path itself keeps its order. */
.pm-terminal-pane__cwd {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  direction: rtl;
  text-align: left;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--pm-color-fg-muted);
  font-family: var(--pm-font-family-mono);
  font-size: var(--pm-font-size-xs);
  font-weight: var(--pm-font-weight-regular);
}

.pm-terminal-pane__spacer { flex: 1; }

.pm-terminal-pane__readonly {
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-xs);
}

.pm-terminal-pane__viewport {
  position: relative;
  flex: 1;
  min-height: 0;
  padding: var(--pm-space-2);
}

.pm-terminal-pane__term {
  width: 100%;
  height: 100%;
}

.pm-terminal-pane--readonly :deep(.xterm-cursor) { visibility: hidden; }

/* Non-blocking: the terminal stays readable and scrollable under the overlay. */
.pm-terminal-pane__overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
}

.pm-terminal-pane__card {
  display: flex;
  align-items: center;
  gap: var(--pm-space-2);
  padding: var(--pm-space-2) var(--pm-space-4);
  border-radius: var(--pm-radius-md);
  background: var(--pm-color-bg-elevated);
  box-shadow: var(--pm-shadow-2);
  color: var(--pm-color-fg-primary);
  font-family: var(--pm-font-family-ui);
  font-size: var(--pm-font-size-md);
  pointer-events: auto;
}

.pm-terminal-pane__failed { color: var(--pm-color-status-error); }

.pm-terminal-pane__spinner {
  flex: none;
  box-sizing: border-box;
  width: 14px;
  height: 14px;
  border: 2px solid currentcolor;
  border-top-color: transparent;
  border-radius: var(--pm-radius-full);
}
</style>
