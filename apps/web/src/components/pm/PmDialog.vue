<template>
  <v-dialog
    :aria-describedby="isPlainBody() ? bodyId : undefined"
    :aria-labelledby="titleId"
    class="pm-dialog"
    content-class="pm-dialog__content"
    :model-value="modelValue"
    no-click-animation
    persistent
    :role="tone === 'danger' ? 'alertdialog' : 'dialog'"
    :transition="transition"
    @after-leave="emit('after-leave')"
    @click:outside="requestClose('scrim')"
  >
    <div
      ref="panelRef"
      class="pm-dialog__panel"
      :class="[`pm-dialog__panel--${size}`, { 'animate__animated animate__headShake pm-dialog__panel--shake': shaking }]"
      @animationend="shaking = false"
      @keydown="onKeydown"
    >
      <header class="pm-dialog__header">
        <v-icon v-if="tone === 'danger'" aria-hidden="true" class="pm-dialog__tone" icon="mdi-alert-circle-outline" />
        <h2 :id="titleId" class="pm-dialog__title"><slot name="title">{{ title }}</slot></h2>
      </header>

      <p class="pm-dialog__blocked" role="status">{{ blocked ? blockedMessage : '' }}</p>

      <div
        :id="bodyId"
        ref="bodyRef"
        :aria-busy="loading ? 'true' : undefined"
        class="pm-dialog__body"
        :class="{ 'pm-dialog__body--overflow': overflowing }"
        @scroll="measure"
      >
        <slot />
      </div>

      <footer v-if="confirmText || $slots.actions" class="pm-dialog__actions" :class="{ 'pm-dialog__actions--overflow': overflowing }">
        <slot :cancel="() => requestClose('cancel')" :confirm="confirm" name="actions">
          <PmButton data-pm-cancel @click="requestClose('cancel')">{{ cancelText }}</PmButton>

          <PmButton
            data-pm-confirm
            :loading="loading"
            :variant="tone === 'danger' ? 'danger' : 'primary'"
            @click="confirm"
          >
            {{ confirmText }}
          </PmButton>
        </slot>
      </footer>

      <PmButton
        v-if="closable && !persistent"
        ariaLabel="Close"
        class="pm-dialog__close"
        icon="mdi-close"
        size="sm"
        variant="ghost"
        @click="requestClose('close-button')"
      />
    </div>
  </v-dialog>
</template>

<script lang="ts" setup>
  /* eslint-disable vue/custom-event-name-casing -- v-model event name is fixed by Vue */
  import type { PmDialogCloseReason, PmDialogEmits, PmDialogProps, PmDialogSlots } from './types'
  import { Comment, nextTick, onUpdated, ref, Text, useId, useSlots, watch } from 'vue'
  import PmButton from './PmButton.vue'

  const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

  const props = withDefaults(defineProps<PmDialogProps>(), {
    tone: 'default',
    size: 'md',
    persistent: false,
    blockedMessage: 'Finish or cancel the running action first',
    confirmText: undefined,
    cancelText: 'Cancel',
    loading: false,
    initialFocus: undefined,
    closable: true,
  })

  const emit = defineEmits<PmDialogEmits>()
  defineSlots<PmDialogSlots>()
  const slots = useSlots()

  const id = useId()
  const titleId = `${id}-title`
  const bodyId = `${id}-body`

  const panelRef = ref<HTMLElement>()
  const bodyRef = ref<HTMLElement>()
  const blocked = ref(false)
  const shaking = ref(false)
  const overflowing = ref(false)
  let opener: HTMLElement | null = null
  let wasOpen = false

  const transition = {
    enterActiveClass: 'animate__animated animate__fadeInDown pm-dialog--enter',
    leaveActiveClass: 'animate__animated animate__fadeOut pm-dialog--leave',
  }

  function isPlainBody () {
    return (slots.default?.() ?? []).every(node => node.type === Text || node.type === Comment)
  }

  function measure () {
    const body = bodyRef.value
    overflowing.value = Boolean(body && body.scrollHeight > body.clientHeight)
  }

  onUpdated(measure)

  function focusables () {
    return Array.from(panelRef.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
  }

  function focusInitial () {
    const panel = panelRef.value
    if (!panel) {
      return
    }
    const target = (props.initialFocus ? panel.querySelector<HTMLElement>(props.initialFocus) : null)
      ?? bodyRef.value?.querySelector<HTMLElement>(FOCUSABLE)
      ?? panel.querySelector<HTMLElement>(props.tone === 'danger' ? '[data-pm-cancel]' : '[data-pm-confirm]')
    if (target) {
      target.focus()
    } else {
      panel.tabIndex = -1
      panel.focus()
    }
  }

  function restoreFocus () {
    const target = opener?.isConnected ? opener : document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    target?.focus()
    opener = null
  }

  async function onToggle (open: boolean) {
    if (open) {
      await nextTick()
      await nextTick()
      measure()
      focusInitial()
    } else {
      blocked.value = false
      if (wasOpen) {
        await nextTick()
        restoreFocus()
      }
    }
    wasOpen = open
  }

  watch(() => props.modelValue, open => {
    if (open && document.activeElement instanceof HTMLElement) {
      opener = document.activeElement
    }
    void onToggle(open)
  }, { flush: 'sync', immediate: true })

  function requestClose (reason: Exclude<PmDialogCloseReason, 'confirm'>) {
    if (props.persistent || props.loading) {
      blocked.value = true
      shaking.value = false
      void nextTick(() => {
        shaking.value = true
      })
      emit('close-blocked')
      return
    }
    emit('cancel', reason)
    emit('update:modelValue', false)
  }

  function confirm () {
    if (!props.loading) {
      emit('confirm')
    }
  }

  const TEXT_INPUT = /^(?:text|email|search|url|tel|number|password)$/

  function onKeydown (event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      requestClose('escape')
      return
    }
    if (event.key === 'Tab') {
      const items = focusables()
      const first = items[0]
      const last = items.at(-1)
      if (!first || !last) {
        event.preventDefault()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
      return
    }
    if (props.tone === 'danger' || !props.confirmText || event.key !== 'Enter') {
      return
    }
    const target = event.target
    const inTextInput = target instanceof HTMLInputElement && TEXT_INPUT.test(target.type)
    if (event.ctrlKey || inTextInput) {
      event.preventDefault()
      confirm()
    }
  }
</script>

<style>
.pm-dialog__content {
  align-items: center;
  max-height: 80vh;
  overflow: visible;
}

.pm-dialog .v-overlay__scrim {
  background: var(--pm-color-bg-scrim);
  opacity: var(--pm-opacity-scrim);
}

.pm-dialog--enter { --animate-duration: var(--pm-motion-duration-slow); animation-timing-function: var(--pm-motion-easing-decelerate); }
.pm-dialog--leave { --animate-duration: var(--pm-motion-duration-fast); animation-timing-function: var(--pm-motion-easing-accelerate); }
</style>

<style scoped>
.pm-dialog__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 560px;
  max-height: 80vh;
  border: 1px solid var(--pm-color-border-default);
  border-radius: var(--pm-radius-lg);
  background: var(--pm-color-bg-elevated);
  box-shadow: var(--pm-shadow-3);
  color: var(--pm-color-fg-primary);
  font-family: var(--pm-font-family-ui);
  font-size: var(--pm-font-size-md);
  line-height: var(--pm-font-line-height-normal);
  outline: none;
}

.pm-dialog__panel--sm { max-width: 400px; }
.pm-dialog__panel--lg { max-width: 800px; }

.pm-dialog__panel--shake { --animate-duration: var(--pm-motion-duration-slow); }

.pm-dialog__header {
  display: flex;
  align-items: center;
  gap: var(--pm-space-2);
  padding: var(--pm-space-4) var(--pm-space-6) var(--pm-space-2) var(--pm-space-4);
}

.pm-dialog__tone { color: var(--pm-color-danger-default); }

.pm-dialog__title {
  margin: 0;
  font-size: var(--pm-font-size-lg);
  font-weight: var(--pm-font-weight-semibold);
}

.pm-dialog__blocked {
  margin: 0;
  padding: 0 var(--pm-space-4);
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-sm);
}

.pm-dialog__blocked:empty { display: none; }

.pm-dialog__body {
  flex: 1 1 auto;
  padding: var(--pm-space-2) var(--pm-space-4);
  overflow-y: auto;
  border-top: 1px solid transparent;
  border-bottom: 1px solid transparent;
}

.pm-dialog__body--overflow { border-color: var(--pm-color-border-default); }

.pm-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--pm-space-2);
  padding: var(--pm-space-4);
}

.pm-dialog__close {
  position: absolute;
  top: var(--pm-space-2);
  right: var(--pm-space-2);
}
</style>
