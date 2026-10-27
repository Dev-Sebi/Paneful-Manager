<template>
  <section class="empty-state">
    <v-icon aria-hidden="true" class="empty-state__icon" :icon="icon" size="40" />
    <p class="empty-state__text">{{ message }}</p>
    <AhButton variant="primary" @click="emit('action')">{{ actionLabel }}</AhButton>
  </section>
</template>

<script lang="ts" setup>
  import { AhButton } from '@/components/ah'

  defineProps<{
    icon: string
    message: string
    actionLabel: string
  }>()

  const emit = defineEmits<{ action: [] }>()
</script>

<style scoped>
.empty-state {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--ah-space-4);
  min-height: 240px;
  padding: var(--ah-space-8);
  text-align: center;
}

.empty-state__icon { color: var(--ah-color-fg-muted); }

.empty-state__text {
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-md);
}
</style>
