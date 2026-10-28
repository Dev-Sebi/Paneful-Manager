<template>
  <v-btn
    :aria-busy="loading ? 'true' : undefined"
    :aria-keyshortcuts="shortcut"
    :aria-label="ariaLabel"
    :aria-pressed="pressed === undefined ? undefined : String(pressed)"
    :block="block"
    :class="classes"
    :disabled="disabled"
    :ripple="false"
    :type="type"
    variant="text"
    @click="onClick"
  >
    <span v-if="loading" aria-hidden="true" class="pm-spinner pm-button__spinner" />

    <template v-else-if="icon">
      <v-icon aria-hidden="true" class="pm-button__icon" :icon="icon" />
    </template>

    <template v-else>
      <slot name="prepend">
        <v-icon v-if="prependIcon" aria-hidden="true" class="pm-button__icon" :icon="prependIcon" />
      </slot>
    </template>

    <span v-if="!icon" class="pm-button__label"><slot /></span>

    <slot v-if="!icon" name="append">
      <v-icon v-if="appendIcon" aria-hidden="true" class="pm-button__icon" :icon="appendIcon" />
    </slot>

    <v-tooltip v-if="tooltipText" activator="parent" location="bottom">{{ tooltipText }}</v-tooltip>
  </v-btn>
</template>

<script lang="ts" setup>
  import type { PmButtonEmits, PmButtonProps, PmButtonSlots } from './types'
  import { computed, watchEffect } from 'vue'

  const props = withDefaults(defineProps<PmButtonProps>(), {
    variant: 'secondary',
    size: 'md',
    type: 'button',
    disabled: false,
    loading: false,
    pressed: undefined,
    prependIcon: undefined,
    appendIcon: undefined,
    icon: undefined,
    ariaLabel: undefined,
    shortcut: undefined,
    block: false,
  })

  const emit = defineEmits<PmButtonEmits>()

  defineSlots<PmButtonSlots>()

  const classes = computed(() => [
    'pm-button',
    `pm-button--${props.variant}`,
    `pm-button--${props.size}`,
    {
      'pm-button--icon': Boolean(props.icon),
      'pm-button--pressed': props.pressed === true,
      'pm-button--loading': props.loading,
    },
  ])

  const tooltipText = computed(() => {
    const name = props.icon ? props.ariaLabel : undefined
    if (name && props.shortcut) {
      return `${name} (${props.shortcut})`
    }
    return name ?? props.shortcut
  })

  watchEffect(() => {
    if (import.meta.env.DEV && props.icon && !props.ariaLabel) {
      console.warn('[PmButton] An icon-only button requires the "ariaLabel" prop.')
    }
  })

  function onClick (event: MouseEvent | KeyboardEvent) {
    if (props.disabled || props.loading) {
      event.preventDefault()
      return
    }
    emit('click', event)
  }
</script>

<style scoped>
.v-btn.pm-button {
  --pm-button-height: 28px;
  --pm-button-padding: var(--pm-space-3);
  --pm-button-gap: var(--pm-space-2);
  --pm-button-bg: transparent;
  --pm-button-bg-hover: var(--pm-color-bg-hover);
  --pm-button-fg: var(--pm-color-fg-primary);
  --pm-button-border: transparent;

  gap: var(--pm-button-gap);
  min-width: 0;
  height: var(--pm-button-height);
  padding: 0 var(--pm-button-padding);
  border: 1px solid var(--pm-button-border);
  border-radius: var(--pm-radius-md);
  background: var(--pm-button-bg);
  color: var(--pm-button-fg);
  font-family: var(--pm-font-family-ui);
  font-size: var(--pm-font-size-md);
  font-weight: var(--pm-font-weight-medium);
  line-height: var(--pm-font-line-height-tight);
  letter-spacing: normal;
  text-transform: none;
  box-shadow: var(--pm-shadow-0);
  transition:
    background-color var(--pm-motion-duration-fast) var(--pm-motion-easing-standard),
    border-color var(--pm-motion-duration-fast) var(--pm-motion-easing-standard);
}

.pm-button :deep(.v-btn__overlay),
.pm-button :deep(.v-btn__underlay) {
  display: none;
}

.pm-button :deep(.v-btn__content) {
  display: inline-flex;
  align-items: center;
  gap: var(--pm-button-gap);
  min-width: 0;
}

.pm-button__label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.pm-button__icon {
  font-size: 16px;
  width: 16px;
  height: 16px;
}

.pm-button__spinner {
  flex: none;
  box-sizing: border-box;
  width: 14px;
  height: 14px;
  border: 2px solid currentcolor;
  border-top-color: transparent;
  border-radius: var(--pm-radius-full);
}

.v-btn.pm-button--sm { --pm-button-height: 24px; --pm-button-padding: var(--pm-space-2); --pm-button-gap: var(--pm-space-1); font-size: var(--pm-font-size-sm); }
.v-btn.pm-button--lg { --pm-button-height: 32px; --pm-button-padding: var(--pm-space-4); }

.v-btn.pm-button--icon { width: var(--pm-button-height); padding: 0; }

.v-btn.pm-button--primary {
  --pm-button-bg: var(--pm-color-accent-default);
  --pm-button-bg-hover: var(--pm-color-accent-hover);
  --pm-button-fg: var(--pm-color-fg-on-accent);
}

.v-btn.pm-button--secondary {
  --pm-button-bg: var(--pm-color-bg-elevated);
  --pm-button-border: var(--pm-color-border-default);
}

.v-btn.pm-button--danger {
  --pm-button-bg: var(--pm-color-danger-default);
  --pm-button-bg-hover: var(--pm-color-danger-hover);
  --pm-button-fg: var(--pm-color-fg-on-danger);
}

.pm-button:not(:disabled):hover { background: var(--pm-button-bg-hover); }

.pm-button--pressed.pm-button--secondary,
.pm-button--pressed.pm-button--ghost { background: var(--pm-color-bg-selected); }

.pm-button:focus-visible {
  outline: 2px solid var(--pm-color-border-focus);
  outline-offset: 2px;
}

.pm-button:disabled {
  opacity: var(--pm-opacity-disabled);
  cursor: not-allowed;
  pointer-events: auto;
}

.pm-button--loading { cursor: progress; }
</style>
