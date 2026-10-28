<template>
  <span
    :class="classes"
    :title="variant === 'dot' ? text : undefined"
    @animationend="onAnimationEnd"
  >
    <span
      :aria-hidden="variant === 'label' ? 'true' : undefined"
      :aria-label="variant === 'dot' ? text : undefined"
      class="pm-status-badge__marker"
      :role="variant === 'dot' ? 'img' : undefined"
    />

    <span v-if="variant === 'label'" class="pm-status-badge__text">
      <slot>{{ text }}</slot>
    </span>

    <span v-if="announce" aria-live="polite" class="pm-status-badge__live" role="status">{{ announcement }}</span>
  </span>
</template>

<script lang="ts" setup>
  import type { PmStatusBadgeEmits, PmStatusBadgeProps, PmStatusBadgeSlots } from './types'
  import { computed, ref, watch } from 'vue'
  import { STATUS_LABELS } from './statusLabels'

  const props = withDefaults(defineProps<PmStatusBadgeProps>(), {
    variant: 'label',
    size: 'md',
    label: undefined,
    announce: false,
  })

  const emit = defineEmits<PmStatusBadgeEmits>()

  defineSlots<PmStatusBadgeSlots>()

  const pulsing = ref(false)
  const announcement = ref('')

  const text = computed(() => props.label ?? STATUS_LABELS[props.state])

  const classes = computed(() => [
    'pm-status-badge',
    `pm-status-badge--${props.variant}`,
    `pm-status-badge--${props.size}`,
    `pm-status-badge--${props.state}`,
    { 'pm-status-badge--pulse animate__animated animate__pulse': pulsing.value },
  ])

  function prefersReducedMotion () {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  watch(() => props.state, state => {
    if (props.announce) {
      announcement.value = text.value
    }
    if (state !== 'waiting') {
      pulsing.value = false
      return
    }
    if (prefersReducedMotion()) {
      emit('attention-end')
      return
    }
    pulsing.value = true
  })

  function onAnimationEnd (event: AnimationEvent) {
    if (event.target === event.currentTarget && pulsing.value) {
      pulsing.value = false
      emit('attention-end')
    }
  }
</script>

<style scoped>
.pm-status-badge {
  --pm-badge-color: var(--pm-color-status-idle);
  --pm-badge-marker: 8px;

  display: inline-flex;
  align-items: center;
  vertical-align: middle;
  font-family: var(--pm-font-family-ui);
  line-height: var(--pm-font-line-height-tight);
}

.pm-status-badge--sm { --pm-badge-marker: 6px; }
.pm-status-badge--working { --pm-badge-color: var(--pm-color-status-working); }
.pm-status-badge--waiting { --pm-badge-color: var(--pm-color-status-waiting); }
.pm-status-badge--error { --pm-badge-color: var(--pm-color-status-error); }
.pm-status-badge--idle { --pm-badge-color: var(--pm-color-status-idle); }

.pm-status-badge__marker {
  flex: none;
  box-sizing: border-box;
  width: var(--pm-badge-marker);
  height: var(--pm-badge-marker);
  border-radius: var(--pm-radius-full);
  background: var(--pm-badge-color);
  transition: background-color var(--pm-motion-duration-fast) var(--pm-motion-easing-standard);
}

.pm-status-badge--waiting .pm-status-badge__marker {
  outline: 2px solid var(--pm-badge-color);
  outline-offset: 1px;
}

.pm-status-badge--error .pm-status-badge__marker { border-radius: 0; }

.pm-status-badge--idle .pm-status-badge__marker {
  border: 1.5px solid var(--pm-badge-color);
  background: transparent;
}

.pm-status-badge--label {
  gap: var(--pm-space-1);
  height: 20px;
  padding: 0 var(--pm-space-2);
  border-radius: var(--pm-radius-full);
  background: var(--pm-color-bg-elevated);
  color: var(--pm-color-fg-primary);
  font-size: var(--pm-font-size-sm);
  font-weight: var(--pm-font-weight-medium);
}

.pm-status-badge--label.pm-status-badge--sm {
  height: 16px;
  font-size: var(--pm-font-size-xs);
}

.pm-status-badge__text { white-space: nowrap; }

.pm-status-badge--pulse {
  --animate-duration: var(--pm-motion-duration-slow);
}

.pm-status-badge__live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
