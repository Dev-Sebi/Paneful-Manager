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
    <span v-if="loading" aria-hidden="true" class="ah-spinner ah-button__spinner" />

    <template v-else-if="icon">
      <v-icon aria-hidden="true" class="ah-button__icon" :icon="icon" />
    </template>

    <template v-else>
      <slot name="prepend">
        <v-icon v-if="prependIcon" aria-hidden="true" class="ah-button__icon" :icon="prependIcon" />
      </slot>
    </template>

    <span v-if="!icon" class="ah-button__label"><slot /></span>

    <slot v-if="!icon" name="append">
      <v-icon v-if="appendIcon" aria-hidden="true" class="ah-button__icon" :icon="appendIcon" />
    </slot>

    <v-tooltip v-if="tooltipText" activator="parent" location="bottom">{{ tooltipText }}</v-tooltip>
  </v-btn>
</template>

<script lang="ts" setup>
  import type { AhButtonEmits, AhButtonProps } from './types'
  import { computed, watchEffect } from 'vue'

  const props = withDefaults(defineProps<AhButtonProps>(), {
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

  const emit = defineEmits<AhButtonEmits>()

  const classes = computed(() => [
    'ah-button',
    `ah-button--${props.variant}`,
    `ah-button--${props.size}`,
    {
      'ah-button--icon': Boolean(props.icon),
      'ah-button--pressed': props.pressed === true,
      'ah-button--loading': props.loading,
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
      console.warn('[AhButton] An icon-only button requires the "ariaLabel" prop.')
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
.v-btn.ah-button {
  --ah-button-height: 28px;
  --ah-button-padding: var(--ah-space-3);
  --ah-button-gap: var(--ah-space-2);
  --ah-button-bg: transparent;
  --ah-button-bg-hover: var(--ah-color-bg-hover);
  --ah-button-fg: var(--ah-color-fg-primary);
  --ah-button-border: transparent;

  gap: var(--ah-button-gap);
  min-width: 0;
  height: var(--ah-button-height);
  padding: 0 var(--ah-button-padding);
  border: 1px solid var(--ah-button-border);
  border-radius: var(--ah-radius-md);
  background: var(--ah-button-bg);
  color: var(--ah-button-fg);
  font-family: var(--ah-font-family-ui);
  font-size: var(--ah-font-size-md);
  font-weight: var(--ah-font-weight-medium);
  line-height: var(--ah-font-line-height-tight);
  letter-spacing: normal;
  text-transform: none;
  box-shadow: var(--ah-shadow-0);
  transition:
    background-color var(--ah-motion-duration-fast) var(--ah-motion-easing-standard),
    border-color var(--ah-motion-duration-fast) var(--ah-motion-easing-standard);
}

.ah-button :deep(.v-btn__overlay),
.ah-button :deep(.v-btn__underlay) {
  display: none;
}

.ah-button :deep(.v-btn__content) {
  display: inline-flex;
  align-items: center;
  gap: var(--ah-button-gap);
  min-width: 0;
}

.ah-button__label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ah-button__icon {
  font-size: 16px;
  width: 16px;
  height: 16px;
}

.ah-button__spinner {
  flex: none;
  box-sizing: border-box;
  width: 14px;
  height: 14px;
  border: 2px solid currentcolor;
  border-top-color: transparent;
  border-radius: var(--ah-radius-full);
}

.ah-button--sm { --ah-button-height: 24px; --ah-button-padding: var(--ah-space-2); --ah-button-gap: var(--ah-space-1); font-size: var(--ah-font-size-sm); }
.ah-button--lg { --ah-button-height: 32px; --ah-button-padding: var(--ah-space-4); }

.ah-button--icon { width: var(--ah-button-height); padding: 0; }

.ah-button--primary {
  --ah-button-bg: var(--ah-color-accent-default);
  --ah-button-bg-hover: var(--ah-color-accent-hover);
  --ah-button-fg: var(--ah-color-fg-on-accent);
}

.ah-button--secondary {
  --ah-button-bg: var(--ah-color-bg-elevated);
  --ah-button-border: var(--ah-color-border-default);
}

.ah-button--danger {
  --ah-button-bg: var(--ah-color-danger-default);
  --ah-button-bg-hover: var(--ah-color-danger-hover);
  --ah-button-fg: var(--ah-color-fg-on-danger);
}

.ah-button:not(:disabled):hover { background: var(--ah-button-bg-hover); }

.ah-button--pressed.ah-button--secondary,
.ah-button--pressed.ah-button--ghost { background: var(--ah-color-bg-selected); }

.ah-button:focus-visible {
  outline: 2px solid var(--ah-color-border-focus);
  outline-offset: 2px;
}

.ah-button:disabled {
  opacity: var(--ah-opacity-disabled);
  cursor: not-allowed;
  pointer-events: auto;
}

.ah-button--loading { cursor: progress; }
</style>
