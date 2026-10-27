<template>
  <li
    class="ah-tab"
    :class="classes"
    role="none"
    @auxclick.middle.prevent="requestClose"
  >
    <button
      :id="`${TAB_ID_PREFIX}${value}`"
      ref="triggerRef"
      :aria-controls="`${TABPANEL_ID_PREFIX}${value}`"
      :aria-disabled="disabled ? 'true' : undefined"
      :aria-label="accessibleName"
      :aria-selected="active ? 'true' : 'false'"
      class="ah-tab__trigger"
      role="tab"
      :tabindex="tabStop ? 0 : -1"
      :title="title"
      type="button"
      @click="select"
      @keydown.backspace.prevent="requestClose"
      @keydown.delete.prevent="requestClose"
    >
      <slot name="prepend">
        <AhStatusBadge v-if="status" size="sm" :state="status" variant="dot" />
        <v-icon v-else-if="icon" aria-hidden="true" class="ah-tab__icon" :icon="icon" />
      </slot>

      <span class="ah-tab__title"><slot>{{ title }}</slot></span>
    </button>

    <span v-if="isClosable || dirty" class="ah-tab__end">
      <span v-if="dirty" aria-hidden="true" class="ah-tab__dirty" />

      <button
        v-if="isClosable"
        :aria-label="`Close ${title}`"
        class="ah-tab__close"
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
  import type { AhTabEmits, AhTabProps } from './types'
  import { computed, inject, nextTick, onBeforeUnmount, ref, watchEffect } from 'vue'
  import AhStatusBadge from './AhStatusBadge.vue'
  import { STATUS_LABELS } from './statusLabels'
  import { AH_TABS_KEY, selectedTabs, TAB_ID_PREFIX, TABPANEL_ID_PREFIX } from './tabState'

  const props = withDefaults(defineProps<AhTabProps>(), {
    status: undefined,
    dirty: false,
    closable: undefined,
    disabled: false,
    icon: undefined,
  })

  const emit = defineEmits<AhTabEmits>()

  const triggerRef = ref<HTMLButtonElement>()
  const ctx = inject(AH_TABS_KEY)
  if (!ctx) {
    throw new Error('[AhTab] must be rendered inside AhTabs.')
  }
  const tabs = ctx
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
      'ah-tab--active': active.value,
      'ah-tab--disabled': props.disabled,
      'ah-tab--dirty': props.dirty,
      'ah-tab--closable': isClosable.value,
      'animate__animated animate__fadeIn ah-tab--open': animateOpen,
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
    tabs.registry.delete(props.value)
    selectedTabs.delete(props.value)
  })

  function select () {
    if (!props.disabled) {
      tabs.select(props.value)
    }
  }

  /** Tab that takes over focus when this one closes: next, else previous. */
  function neighbour (): HTMLElement | undefined {
    const own = triggerRef.value
    const all = Array.from(own?.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]:not([aria-disabled="true"])') ?? [])
    const index = own ? all.indexOf(own) : -1
    return all[index + 1] ?? all[index - 1]
  }

  function requestClose () {
    if (!isClosable.value) {
      return
    }
    const next = neighbour()
    const hadFocus = document.activeElement === triggerRef.value
    emit('close', props.value)
    tabs.close(props.value, props.title)
    if (next && hadFocus) {
      if (active.value) {
        tabs.select(next.id.slice(TAB_ID_PREFIX.length))
      }
      void nextTick(() => next.focus())
    }
  }
</script>

<style scoped>
.ah-tab {
  --ah-tab-bg: var(--ah-color-bg-surface);
  --ah-tab-fg: var(--ah-color-fg-muted);

  position: relative;
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: var(--ah-space-2);
  min-width: 96px;
  max-width: 240px;
  padding: 0 var(--ah-space-3);
  background: var(--ah-tab-bg);
  color: var(--ah-tab-fg);
  transition:
    background-color var(--ah-motion-duration-fast) var(--ah-motion-easing-standard),
    color var(--ah-motion-duration-fast) var(--ah-motion-easing-standard);
}

.ah-tab--open {
  --animate-duration: var(--ah-motion-duration-normal);

  animation-timing-function: var(--ah-motion-easing-decelerate);
}

.ah-tab:hover {
  --ah-tab-bg: var(--ah-color-bg-hover);
  --ah-tab-fg: var(--ah-color-fg-primary);
}

.ah-tab--active {
  --ah-tab-bg: var(--ah-color-bg-canvas);
  --ah-tab-fg: var(--ah-color-fg-primary);

  font-weight: var(--ah-font-weight-medium);
}

.ah-tab--active::after {
  content: "";
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  background: var(--ah-color-accent-default);
}

.ah-tab--disabled {
  --ah-tab-fg: var(--ah-color-fg-disabled);

  cursor: not-allowed;
}

.ah-tab:focus-within {
  outline: 2px solid var(--ah-color-border-focus);
  outline-offset: -2px;
}

.ah-tab__trigger {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: var(--ah-space-2);
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

.ah-tab:not(.ah-tab--disabled) .ah-tab__trigger { cursor: pointer; }

.ah-tab__title {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ah-tab__icon {
  flex: none;
  font-size: 16px;
}

.ah-tab__end {
  position: relative;
  display: grid;
  flex: none;
  place-items: center;
  width: 16px;
  height: 16px;
}

.ah-tab__end > * { grid-area: 1 / 1; }

.ah-tab__dirty {
  width: 8px;
  height: 8px;
  border-radius: var(--ah-radius-full);
  background: var(--ah-color-fg-primary);
}

.ah-tab__close {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: var(--ah-radius-sm);
  background: none;
  color: inherit;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--ah-motion-duration-fast) var(--ah-motion-easing-standard);
}

.ah-tab--active:not(.ah-tab--dirty) .ah-tab__close,
.ah-tab:hover .ah-tab__close,
.ah-tab:focus-within .ah-tab__close { opacity: 1; }

.ah-tab--dirty:not(:hover):not(:focus-within) .ah-tab__close { pointer-events: none; }

.ah-tab:hover .ah-tab__dirty,
.ah-tab:focus-within .ah-tab__dirty { opacity: 0; }

.ah-tab__close:hover { background: var(--ah-color-bg-selected); }
</style>
