<template>
  <section :aria-label="`Empty pane: ${title}`" class="pane-placeholder" role="group">
    <header class="pane-placeholder__header">
      <span class="pane-placeholder__title">{{ title }}</span>
    </header>

    <EmptyState icon="mdi-console-network-outline" :message="reason" />
  </section>
</template>

<script lang="ts" setup>
  import EmptyState from '@/components/EmptyState.vue'

  defineProps<{ title: string, reason: string }>()
</script>

<style scoped>
.pane-placeholder {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: auto;
  border: 1px dashed var(--ah-color-border-default);
  background: var(--ah-color-bg-canvas);
}

.pane-placeholder__header {
  display: flex;
  flex: none;
  align-items: center;
  height: 28px;
  padding: 0 var(--ah-space-2);
  background: var(--ah-color-bg-surface);
  color: var(--ah-color-fg-primary);
  font-family: var(--ah-font-family-ui);
  font-size: var(--ah-font-size-sm);
}

.pane-placeholder__title {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
