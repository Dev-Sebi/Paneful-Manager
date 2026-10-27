<template>
  <div class="settings">
    <EmptyState
      v-if="!config.config"
      action-label="Retry"
      icon="mdi-cog-outline"
      :message="config.error ?? 'Config is not loaded'"
      @action="config.reload()"
    />

    <template v-else>
      <h1 class="settings__title">Settings</h1>
      <p class="settings__note">Read-only for now.</p>
      <pre class="settings__config" tabindex="0">{{ JSON.stringify(config.config, null, 2) }}</pre>
    </template>
  </div>
</template>

<script lang="ts" setup>
  import { onMounted } from 'vue'
  import EmptyState from '@/components/EmptyState.vue'
  import { useConfigStore } from '@/stores/config'

  const config = useConfigStore()

  onMounted(() => config.ensureLoaded())
</script>

<style scoped>
.settings {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--ah-space-3);
  padding: var(--ah-space-6);
}

.settings__title {
  font-size: var(--ah-font-size-xl);
  font-weight: var(--ah-font-weight-semibold);
}

.settings__note { color: var(--ah-color-fg-muted); }

.settings__config {
  padding: var(--ah-space-4);
  overflow: auto;
  border: 1px solid var(--ah-color-border-default);
  border-radius: var(--ah-radius-md);
  background: var(--ah-color-bg-surface);
  font-size: var(--ah-font-size-sm);
}
</style>
