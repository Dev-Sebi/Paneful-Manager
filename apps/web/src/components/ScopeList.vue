<template>
  <div class="scope-list">
    <EmptyState
      v-if="scopes.error"
      action-label="Retry"
      icon="mdi-alert-circle-outline"
      message="Could not load scopes. Check that the Agent Hub server is running."
      @action="scopes.load()"
    />

    <EmptyState
      v-else-if="scopes.scopes.length === 0"
      action-label="Reload scopes"
      :icon="icon"
      :message="message"
      @action="scopes.load()"
    />

    <ul v-else aria-label="Scopes" class="scope-list__items">
      <li v-for="scope in scopes.scopes" :key="`${scope.kind}:${scope.path}`" class="scope-list__item">
        <span class="scope-list__kind">{{ scope.kind }}</span>
        <code class="scope-list__path">{{ scope.path }}</code>
      </li>
    </ul>
  </div>
</template>

<script lang="ts" setup>
  import { onMounted } from 'vue'
  import EmptyState from '@/components/EmptyState.vue'
  import { useScopesStore } from '@/stores/scopes'

  defineProps<{
    icon: string
    message: string
  }>()

  const scopes = useScopesStore()

  onMounted(() => scopes.load())
</script>

<style scoped>
.scope-list {
  display: flex;
  flex: 1;
  flex-direction: column;
}

.scope-list__items {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-1);
  padding: var(--ah-space-4);
  list-style: none;
}

.scope-list__item {
  display: flex;
  gap: var(--ah-space-3);
  align-items: baseline;
  padding: var(--ah-space-2) var(--ah-space-3);
  border: 1px solid var(--ah-color-border-default);
  border-radius: var(--ah-radius-md);
  background: var(--ah-color-bg-surface);
}

.scope-list__kind {
  min-width: 72px;
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-sm);
}
</style>
