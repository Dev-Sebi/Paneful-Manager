<template>
  <section class="empty-state">
    <v-icon aria-hidden="true" class="empty-state__icon" :icon="icon" size="40" />
    <p class="empty-state__text">{{ message }}</p>

    <div v-if="actionLabel || $slots.actions" class="empty-state__actions">
      <PmButton v-if="actionLabel" variant="primary" @click="emit('action')">{{ actionLabel }}</PmButton>
      <slot name="actions" />
    </div>
  </section>
</template>

<script lang="ts" setup>
  import { PmButton } from '@/components/pm'

  defineProps<{
    icon: string
    message: string
    actionLabel?: string
  }>()

  const emit = defineEmits<{ action: [] }>()

  defineSlots<{ actions?: () => unknown }>()
</script>

<style scoped>
.empty-state {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--pm-space-4);
  min-height: 240px;
  padding: var(--pm-space-8);
  text-align: center;
}

.empty-state__icon { color: var(--pm-color-fg-muted); }

.empty-state__text {
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-md);
}

.empty-state__actions {
  display: flex;
  gap: var(--pm-space-2);
}
</style>
