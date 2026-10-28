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

      <v-switch
        color="primary"
        density="compact"
        hide-details
        label="Confirm before closing a tab"
        :model-value="config.confirmCloseTab"
        @update:model-value="setConfirmCloseTab"
      />

      <ClaudeHooksSetting />

      <pre class="settings__config" tabindex="0">{{ JSON.stringify(config.config, null, 2) }}</pre>
    </template>
  </div>
</template>

<script lang="ts" setup>
  import { onMounted } from 'vue'
  import EmptyState from '@/components/EmptyState.vue'
  import ClaudeHooksSetting from '@/components/settings/ClaudeHooksSetting.vue'
  import { useConfigStore } from '@/stores/config'
  import { useUiStore } from '@/stores/ui'

  const config = useConfigStore()
  const ui = useUiStore()

  async function setConfirmCloseTab (value: boolean | null) {
    try {
      await config.patch({ confirmCloseTab: value === true })
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : 'Could not save the setting', 'error')
    }
  }

  onMounted(() => config.ensureLoaded())
</script>

<style scoped>
.settings {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--pm-space-3);
  padding: var(--pm-space-6);
}

.settings__title {
  font-size: var(--pm-font-size-xl);
  font-weight: var(--pm-font-weight-semibold);
}

.settings__config {
  padding: var(--pm-space-4);
  overflow: auto;
  border: 1px solid var(--pm-color-border-default);
  border-radius: var(--pm-radius-md);
  background: var(--pm-color-bg-surface);
  font-size: var(--pm-font-size-sm);
}
</style>
