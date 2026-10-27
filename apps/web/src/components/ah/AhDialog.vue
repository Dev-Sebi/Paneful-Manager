<template>
  <v-dialog
    :aria-describedby="isPlainBody() ? bodyId : undefined"
    :aria-labelledby="titleId"
    class="ah-dialog"
    content-class="ah-dialog__content"
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
      class="ah-dialog__panel"
      :class="[`ah-dialog__panel--${size}`, { 'animate__animated animate__headShake ah-dialog__panel--shake': shaking }]"
      @animationend="shaking = false"
      @keydown="onKeydown"
    >
      <header class="ah-dialog__header">
        <v-icon v-if="tone === 'danger'" aria-hidden="true" class="ah-dialog__tone" icon="mdi-alert-circle-outline" />
        <h2 :id="titleId" class="ah-dialog__title"><slot name="title">{{ title }}</slot></h2>
      </header>

      <p class="ah-dialog__blocked" role="status">{{ blocked ? blockedMessage : '' }}</p>

      <div
        :id="bodyId"
        ref="bodyRef"
        :aria-busy="loading ? 'true' : undefined"
        class="ah-dialog__body"
        :class="{ 'ah-dialog__body--overflow': overflowing }"
        @scroll="measure"
      >
        <slot />
      </div>

      <footer v-if="confirmText || $slots.actions" class="ah-dialog__actions" :class="{ 'ah-dialog__actions--overflow': overflowing }">
        <slot :cancel="() => requestClose('cancel')" :confirm="confirm" name="actions">
          <AhButton data-ah-cancel @click="requestClose('cancel')">{{ cancelText }}</AhButton>

          <AhButton
            data-ah-confirm
            :loading="loading"
            :variant="tone === 'danger' ? 'danger' : 'primary'"
            @click="confirm"
          >
            {{ confirmText }}
          </AhButton>
        </slot>
      </footer>

      <AhButton
        v-if="closable && !persistent"
        ariaLabel="Close"
        class="ah-dialog__close"
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
  import type { AhDialogCloseReason, AhDialogEmits, AhDialogProps, AhDialogSlots } from './types'
  import { Comment, nextTick, onUpdated, ref, Text, useId, useSlots, watch } from 'vue'
  import AhButton from './AhButton.vue'

  const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

  const props = withDefaults(defineProps<AhDialogProps>(), {
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

  const emit = defineEmits<AhDialogEmits>()
  defineSlots<AhDialogSlots>()
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
    enterActiveClass: 'animate__animated animate__fadeInDown ah-dialog--enter',
    leaveActiveClass: 'animate__animated animate__fadeOut ah-dialog--leave',
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
      ?? panel.querySelector<HTMLElement>(props.tone === 'danger' ? '[data-ah-cancel]' : '[data-ah-confirm]')
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

  function requestClose (reason: Exclude<AhDialogCloseReason, 'confirm'>) {
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
.ah-dialog__content {
  max-height: 80vh;
  overflow: visible;
}

.ah-dialog .v-overlay__scrim {
  background: var(--ah-color-bg-scrim);
  opacity: var(--ah-opacity-scrim);
}

.ah-dialog--enter { --animate-duration: var(--ah-motion-duration-slow); animation-timing-function: var(--ah-motion-easing-decelerate); }
.ah-dialog--leave { --animate-duration: var(--ah-motion-duration-fast); animation-timing-function: var(--ah-motion-easing-accelerate); }
</style>

<style scoped>
.ah-dialog__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: calc(100vw - var(--ah-space-8));
  max-width: 560px;
  max-height: 80vh;
  border: 1px solid var(--ah-color-border-default);
  border-radius: var(--ah-radius-lg);
  background: var(--ah-color-bg-elevated);
  box-shadow: var(--ah-shadow-3);
  color: var(--ah-color-fg-primary);
  font-family: var(--ah-font-family-ui);
  font-size: var(--ah-font-size-md);
  line-height: var(--ah-font-line-height-normal);
  outline: none;
}

.ah-dialog__panel--sm { max-width: 400px; }
.ah-dialog__panel--lg { max-width: 800px; }

.ah-dialog__panel--shake { --animate-duration: var(--ah-motion-duration-slow); }

.ah-dialog__header {
  display: flex;
  align-items: center;
  gap: var(--ah-space-2);
  padding: var(--ah-space-4) var(--ah-space-6) var(--ah-space-2) var(--ah-space-4);
}

.ah-dialog__tone { color: var(--ah-color-danger-default); }

.ah-dialog__title {
  margin: 0;
  font-size: var(--ah-font-size-lg);
  font-weight: var(--ah-font-weight-semibold);
}

.ah-dialog__blocked {
  margin: 0;
  padding: 0 var(--ah-space-4);
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-sm);
}

.ah-dialog__blocked:empty { display: none; }

.ah-dialog__body {
  flex: 1 1 auto;
  padding: var(--ah-space-2) var(--ah-space-4);
  overflow-y: auto;
  border-top: 1px solid transparent;
  border-bottom: 1px solid transparent;
}

.ah-dialog__body--overflow { border-color: var(--ah-color-border-default); }

.ah-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--ah-space-2);
  padding: var(--ah-space-4);
}

.ah-dialog__close {
  position: absolute;
  top: var(--ah-space-2);
  right: var(--ah-space-2);
}
</style>
