<template>
  <div class="workspaces">
    <template v-if="tabs.tabs.length > 0">
      <AhTabs
        :model-value="tabs.activeId ?? undefined"
        ariaLabel="Workspace tabs"
        closable
        reorderable
        @add="ui.notify('New tab is not available yet')"
        @close="requestClose"
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
        <p class="workspaces__pane" v-for="pane in tab.panes" :key="pane.sessionId">
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
      confirm-text="Close tab"
      :model-value="pendingClose !== undefined"
      title="Close tab"
      tone="danger"
      @confirm="confirmClose"
      @update:model-value="pendingClose = undefined"
    >
      This tab has unacknowledged activity. Close it anyway?
    </AhDialog>
  </div>
</template>

<script lang="ts" setup>
  import type { AppTab } from '@agent-hub/shared'
  import type { AhStatusBadgeState } from '@/components/ah'
  import { ref, watch } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import { AhDialog, AhTab, AhTabPanel, AhTabs } from '@/components/ah'
  import EmptyState from '@/components/EmptyState.vue'
  import { useConfigStore } from '@/stores/config'
  import { useSessionsStore } from '@/stores/sessions'
  import { useTabsStore } from '@/stores/tabs'
  import { useUiStore } from '@/stores/ui'

  const route = useRoute()
  const router = useRouter()
  const tabs = useTabsStore()
  const sessions = useSessionsStore()
  const config = useConfigStore()
  const ui = useUiStore()

  const pendingClose = ref<string>()

  function tabState (tab: AppTab): AhStatusBadgeState | undefined {
    const first = tab.panes[0]
    return first ? sessions.byId.get(first.sessionId)?.state : undefined
  }

  function select (id: string) {
    void router.push(`/workspaces/${id}`)
  }

  function requestClose (id: string) {
    if (config.confirmCloseTab && tabs.dirty[id]) {
      pendingClose.value = id
    } else {
      tabs.close(id)
    }
  }

  function confirmClose () {
    if (pendingClose.value) {
      tabs.close(pendingClose.value)
    }
    pendingClose.value = undefined
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

.workspaces__pane { color: var(--ah-color-fg-muted); }
</style>
