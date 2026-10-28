<template>
  <li
    class="pm-tab"
    :class="classes"
    role="none"
    @auxclick.middle.prevent="requestClose"
  >
    <button
      :id="`${TAB_ID_PREFIX}${value}`"
      ref="triggerRef"
      :aria-controls="`${TABPANEL_ID_PREFIX}${value}`"
      :aria-disabled="disabled ? 'true' : undefined"
      :aria-keyshortcuts="isClosable ? 'Delete' : undefined"
      :aria-label="accessibleName"
      :aria-selected="active ? 'true' : 'false'"
      class="pm-tab__trigger"
      role="tab"
      :tabindex="tabStop ? 0 : -1"
      :title="title"
      type="button"
      @click="select"
      @keydown.backspace.prevent="requestClose"
      @keydown.delete.prevent="requestClose"
    >
      <slot name="prepend">
        <PmStatusBadge v-if="status" size="sm" :state="status" variant="dot" />
        <v-icon v-else-if="icon" aria-hidden="true" class="pm-tab__icon" :icon="icon" />
      </slot>

      <span class="pm-tab__title"><slot>{{ title }}</slot></span>
    </button>

    <span v-if="isClosable || dirty" class="pm-tab__end">
      <span v-if="dirty" aria-hidden="true" class="pm-tab__dirty" />

      <button
        v-if="isClosable"
        aria-hidden="true"
        class="pm-tab__close"
        tabindex="-1"
        type="button"
        @click.stop="requestClose"
      >
        <v-icon aria-hidden="true" icon="mdi-close" size="14" />
      </button>
    </span>
  </li>
</template>

<script lang="ts" setup>
  import type { PmTabEmits, PmTabProps, PmTabSlots } from './types'
  import { computed, inject, onBeforeUnmount, ref, watchEffect } from 'vue'
  import PmStatusBadge from './PmStatusBadge.vue'
  import { STATUS_LABELS } from './statusLabels'
  import { AH_TABS_KEY, claimTabValue, selectedTabs, TAB_ID_PREFIX, TABPANEL_ID_PREFIX } from './tabState'

  const props = withDefaults(defineProps<PmTabProps>(), {
    status: undefined,
    dirty: false,
    closable: undefined,
    disabled: false,
    icon: undefined,
  })

  const emit = defineEmits<PmTabEmits>()

  defineSlots<PmTabSlots>()

  const triggerRef = ref<HTMLButtonElement>()
  const ctx = inject(AH_TABS_KEY)
  if (!ctx) {
    throw new Error('[PmTab] must be rendered inside PmTabs.')
  }
  const tabs = ctx
  const releaseValue = claimTabValue(props.value)
  const animateOpen = tabs.ready.value

  const active = computed(() => tabs.activeValue.value === props.value)
  const isClosable = computed(() => !props.disabled && (props.closable ?? tabs.closable.value))

  const tabStop = computed(() => {
    if (props.disabled) {
      return false
    }
    const known = tabs.activeValue.value !== undefined && tabs.registry.has(tabs.activeValue.value)
    if (known) {
      return active.value
    }
    return [...tabs.registry].find(([, disabled]) => !disabled)?.[0] === props.value
  })

  const accessibleName = computed(() => {
    const parts = [props.title]
    if (props.status) {
      parts.push(STATUS_LABELS[props.status].toLowerCase())
    }
    if (props.dirty) {
      parts.push('unsaved changes')
    }
    return parts.length > 1 ? parts.join(', ') : undefined
  })

  const classes = computed(() => [
    {
      'pm-tab--active': active.value,
      'pm-tab--disabled': props.disabled,
      'pm-tab--dirty': props.dirty,
      'pm-tab--closable': isClosable.value,
      'animate__animated animate__fadeIn pm-tab--open': animateOpen,
    },
  ])

  watchEffect(() => {
    tabs.registry.set(props.value, props.disabled)
  })

  watchEffect(() => {
    if (active.value) {
      selectedTabs.add(props.value)
    } else {
      selectedTabs.delete(props.value)
    }
  })

  onBeforeUnmount(() => {
    if (triggerRef.value && triggerRef.value === document.activeElement) {
      tabs.removed(triggerRef.value)
    }
    tabs.unmounted(props.value)
    releaseValue()
    tabs.registry.delete(props.value)
    selectedTabs.delete(props.value)
  })

  function select () {
    if (!props.disabled) {
      tabs.select(props.value)
    }
  }

  function requestClose () {
    if (!isClosable.value) {
      return
    }
    emit('close', props.value)
    tabs.close(props.value, props.title)
  }
</script>

<style scoped>
.pm-tab {
  --pm-tab-bg: var(--pm-color-bg-surface);
  --pm-tab-fg: var(--pm-color-fg-muted);

  position: relative;
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: var(--pm-space-2);
  min-width: 96px;
  max-width: 240px;
  padding: 0 var(--pm-space-3);
  background: var(--pm-tab-bg);
  color: var(--pm-tab-fg);
  transition:
    background-color var(--pm-motion-duration-fast) var(--pm-motion-easing-standard),
    color var(--pm-motion-duration-fast) var(--pm-motion-easing-standard);
}

.pm-tab--open {
  --animate-duration: var(--pm-motion-duration-normal);

  animation-timing-function: var(--pm-motion-easing-decelerate);
}

.pm-tab:hover {
  --pm-tab-bg: var(--pm-color-bg-hover);
  --pm-tab-fg: var(--pm-color-fg-primary);
}

.pm-tab--active {
  --pm-tab-bg: var(--pm-color-bg-canvas);
  --pm-tab-fg: var(--pm-color-fg-primary);

  font-weight: var(--pm-font-weight-medium);
}

.pm-tab--active::after {
  content: "";
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  background: var(--pm-color-accent-default);
}

.pm-tab--disabled {
  --pm-tab-fg: var(--pm-color-fg-disabled);

  cursor: not-allowed;
}

.pm-tab:has(:focus-visible) {
  outline: 2px solid var(--pm-color-border-focus);
  outline-offset: -2px;
}

.pm-tab__trigger {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: var(--pm-space-2);
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: inherit;
  outline: none;
}

.pm-tab:not(.pm-tab--disabled) .pm-tab__trigger { cursor: pointer; }

.pm-tab__title {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.pm-tab__icon {
  flex: none;
  font-size: 16px;
}

.pm-tab__end {
  position: relative;
  display: grid;
  flex: none;
  place-items: center;
  width: 16px;
  height: 16px;
}

.pm-tab__end > * { grid-area: 1 / 1; }

.pm-tab__dirty {
  width: 8px;
  height: 8px;
  border-radius: var(--pm-radius-full);
  background: var(--pm-color-fg-primary);
}

.pm-tab__close {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: var(--pm-radius-sm);
  background: none;
  color: inherit;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--pm-motion-duration-fast) var(--pm-motion-easing-standard);
}

.pm-tab--active:not(.pm-tab--dirty) .pm-tab__close,
.pm-tab:hover .pm-tab__close,
.pm-tab:focus-within .pm-tab__close { opacity: 1; }

.pm-tab--dirty:not(:hover):not(:focus-within) .pm-tab__close { pointer-events: none; }

.pm-tab--closable:hover .pm-tab__dirty,
.pm-tab--closable:focus-within .pm-tab__dirty { opacity: 0; }

.pm-tab__close:hover { background: var(--pm-color-bg-selected); }
</style>
