<template>
  <div class="workspaces">
    <template v-if="tabs.tabs.length > 0">
      <AhTabs
        ariaLabel="Workspace tabs"
        closable
        :model-value="tabs.activeId ?? undefined"
        reorderable
        @add="ui.notify('New tab is not available yet')"
        @close="closing.closeTab"
        @reorder="({ from, to }) => tabs.move(from, to)"
        @update:model-value="select"
      >
        <AhTab
          v-for="tab in tabs.tabs"
          :key="tab.id"
          :dirty="tabs.dirty[tab.id]"
          :status="tabState(tab)"
          :title="tab.title"
          :value="tab.id"
        />
      </AhTabs>

      <AhTabPanel v-for="tab in tabs.tabs" :key="tab.id" class="workspaces__panel" :value="tab.id">
        <p v-for="pane in tab.panes" :key="pane.sessionId" class="workspaces__pane">
          Session {{ sessions.byId.get(pane.sessionId)?.title ?? pane.sessionId }}
        </p>
      </AhTabPanel>
    </template>

    <EmptyState
      v-else
      action-label="Open preset"
      icon="mdi-console"
      message="No sessions yet"
      @action="ui.notify('Presets are not available yet')"
    />

    <AhDialog
      confirm-text="Close and kill sessions"
      initial-focus="[data-ah-cancel]"
      :loading="closing.busy.value"
      :model-value="closing.pendingTabId.value !== undefined"
      title="Close tab?"
      tone="danger"
      @confirm="closing.confirm"
      @update:model-value="closing.cancel"
    >
      <p>Closing this tab kills its running sessions:</p>

      <ul class="workspaces__sessions">
        <li v-for="session in closing.pendingSessions.value" :key="session.id">{{ session.title }}</li>
      </ul>

      <v-checkbox v-model="closing.dontAskAgain.value" density="compact" hide-details label="Don't ask again" />
    </AhDialog>
  </div>
</template>

<script lang="ts" setup>
  import type { AhStatusBadgeState } from '@/components/ah'
  import type { AppTab } from '@agent-hub/shared'
  import { watch } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import { AhDialog, AhTab, AhTabPanel, AhTabs } from '@/components/ah'
  import EmptyState from '@/components/EmptyState.vue'
  import { useCloseTab } from '@/composables/useCloseTab'
  import { useSessionsStore } from '@/stores/sessions'
  import { useTabsStore } from '@/stores/tabs'
  import { useUiStore } from '@/stores/ui'

  const route = useRoute()
  const router = useRouter()
  const tabs = useTabsStore()
  const sessions = useSessionsStore()
  const ui = useUiStore()

  const closing = useCloseTab()

  function tabState (tab: AppTab): AhStatusBadgeState | undefined {
    const first = tab.panes[0]
    return first ? sessions.byId.get(first.sessionId)?.state : undefined
  }

  function select (id: string) {
    void router.push(`/workspaces/${id}`)
  }

  // Keeps the URL and the store in agreement: the URL wins when it names a tab, otherwise the active tab is shown.
  watch(
    () => [route.params.tabId, tabs.activeId, tabs.tabs.length] as const,
    ([param, active]) => {
      if (route.name !== 'workspaces' && route.name !== 'workspace-tab') {
        return
      }
      const tabId = typeof param === 'string' ? param : undefined
      if (tabId && tabs.tabs.some(tab => tab.id === tabId)) {
        tabs.activate(tabId)
      } else if (active) {
        void router.replace(`/workspaces/${active}`)
      } else if (tabId) {
        void router.replace('/workspaces')
      }
    },
    { immediate: true },
  )
</script>

<style scoped>
.workspaces {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.workspaces__panel {
  flex: 1;
  padding: var(--ah-space-4);
}

.workspaces__sessions {
  margin: var(--ah-space-2) 0;
  padding-left: var(--ah-space-6);
}

.workspaces__pane { color: var(--ah-color-fg-muted); }
</style>
