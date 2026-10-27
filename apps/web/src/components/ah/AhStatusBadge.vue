<template>
  <span
    :class="classes"
    :title="variant === 'dot' ? text : undefined"
    @animationend="onAnimationEnd"
  >
    <span
      :aria-hidden="variant === 'label' ? 'true' : undefined"
      :aria-label="variant === 'dot' ? text : undefined"
      class="ah-status-badge__marker"
      :role="variant === 'dot' ? 'img' : undefined"
    />

    <span v-if="variant === 'label'" class="ah-status-badge__text">
      <slot>{{ text }}</slot>
    </span>

    <span v-if="announce" aria-live="polite" class="ah-status-badge__live" role="status">{{ announcement }}</span>
  </span>
</template>

<script lang="ts" setup>
  import type { AhStatusBadgeEmits, AhStatusBadgeProps } from './types'
  import { computed, ref, watch } from 'vue'
  import { STATUS_LABELS } from './statusLabels'

  const props = withDefaults(defineProps<AhStatusBadgeProps>(), {
    variant: 'label',
    size: 'md',
    label: undefined,
    announce: false,
  })

  const emit = defineEmits<AhStatusBadgeEmits>()

  const pulsing = ref(false)
  const announcement = ref('')

  const text = computed(() => props.label ?? STATUS_LABELS[props.state])

  const classes = computed(() => [
    'ah-status-badge',
    `ah-status-badge--${props.variant}`,
    `ah-status-badge--${props.size}`,
    `ah-status-badge--${props.state}`,
    { 'ah-status-badge--pulse animate__animated animate__pulse': pulsing.value },
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
.ah-status-badge {
  --ah-badge-color: var(--ah-color-status-idle);
  --ah-badge-marker: 8px;

  display: inline-flex;
  align-items: center;
  vertical-align: middle;
  font-family: var(--ah-font-family-ui);
  line-height: var(--ah-font-line-height-tight);
}

.ah-status-badge--sm { --ah-badge-marker: 6px; }
.ah-status-badge--working { --ah-badge-color: var(--ah-color-status-working); }
.ah-status-badge--waiting { --ah-badge-color: var(--ah-color-status-waiting); }
.ah-status-badge--error { --ah-badge-color: var(--ah-color-status-error); }
.ah-status-badge--idle { --ah-badge-color: var(--ah-color-status-idle); }

.ah-status-badge__marker {
  flex: none;
  box-sizing: border-box;
  width: var(--ah-badge-marker);
  height: var(--ah-badge-marker);
  border-radius: var(--ah-radius-full);
  background: var(--ah-badge-color);
  transition: background-color var(--ah-motion-duration-fast) var(--ah-motion-easing-standard);
}

.ah-status-badge--waiting .ah-status-badge__marker {
  outline: 2px solid var(--ah-badge-color);
  outline-offset: 1px;
}

.ah-status-badge--error .ah-status-badge__marker { border-radius: 0; }

.ah-status-badge--idle .ah-status-badge__marker {
  border: 1.5px solid var(--ah-badge-color);
  background: transparent;
}

.ah-status-badge--label {
  gap: var(--ah-space-1);
  height: 20px;
  padding: 0 var(--ah-space-2);
  border-radius: var(--ah-radius-full);
  background: var(--ah-color-bg-elevated);
  color: var(--ah-color-fg-primary);
  font-size: var(--ah-font-size-sm);
  font-weight: var(--ah-font-weight-medium);
}

.ah-status-badge--label.ah-status-badge--sm {
  height: 16px;
  font-size: var(--ah-font-size-xs);
}

.ah-status-badge__text { white-space: nowrap; }

.ah-status-badge--pulse {
  --animate-duration: var(--ah-motion-duration-slow);
}

.ah-status-badge__live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
