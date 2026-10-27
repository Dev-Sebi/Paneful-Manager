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

        <template #append>
          <AhButton
            v-if="activeTab && activeTab.panes.length > 1"
            prepend-icon="mdi-view-grid-outline"
            size="sm"
            variant="ghost"
            @click="resetLayout"
          >Reset layout</AhButton>

          <AhButton prepend-icon="mdi-plus" size="sm" variant="ghost" @click="openCreate">New session</AhButton>
        </template>
      </AhTabs>

      <AhTabPanel v-for="tab in tabs.tabs" :key="tab.id" class="workspaces__panel" :value="tab.id">
        <AhSplitLayout
          :ref="el => setLayoutRef(tab.id, el)"
          class="workspaces__layout"
          :layout="tab.layout"
          :panes="tab.panes"
          :tab-id="tab.id"
          @resized="refit"
        >
          <template #pane="{ index }">
            <template v-for="pane in tab.panes.slice(index, index + 1)" :key="pane.sessionId">
              <AhTerminalPane
                :ref="el => setPaneRef(pane.sessionId, el)"
                class="workspaces__pane"
                :connection="sessions.byId.get(pane.sessionId)?.lifecycle === 'exited' ? 'exited' : 'connecting'"
                :cwd="sessions.byId.get(pane.sessionId)?.cwd"
                :exit-code="sessions.byId.get(pane.sessionId)?.exitCode"
                :focused="tab.id === tabs.activeId"
                :maximized="maximized === pane.sessionId"
                :session-id="pane.sessionId"
                :status="sessions.byId.get(pane.sessionId)?.state"
                :title="paneTitle(pane.sessionId)"
                @close="ui.notify('Closing panes is not available yet')"
                @restart="ui.notify('Restarting sessions is not available yet')"
                @split="ui.notify('Split panes are not available yet')"
                @toggle-maximize="toggleMaximize(pane.sessionId)"
              />
            </template>
          </template>
        </AhSplitLayout>
      </AhTabPanel>
    </template>

    <EmptyState
      v-else
      action-label="Open preset"
      icon="mdi-console"
      message="No sessions yet"
      @action="ui.notify('Presets are not available yet')"
    >
      <template #actions>
        <AhButton prepend-icon="mdi-plus" @click="openCreate">New session</AhButton>
      </template>
    </EmptyState>

    <AhDialog
      v-model="createOpen"
      :loading="creating"
      title="New session"
      @confirm="createSession"
    >
      <div class="workspaces__form">
        <v-text-field
          v-model="createCwd"
          autocomplete="off"
          density="compact"
          hide-details="auto"
          label="Working directory"
          :rules="[required]"
          spellcheck="false"
          variant="outlined"
        />

        <v-text-field
          v-model="createCommand"
          autocomplete="off"
          density="compact"
          hide-details="auto"
          label="Command"
          :rules="[required]"
          spellcheck="false"
          variant="outlined"
        />
      </div>

      <template #actions="{ cancel, confirm }">
        <AhButton data-ah-cancel @click="cancel">Cancel</AhButton>

        <AhButton
          data-ah-confirm
          :disabled="!canCreate"
          :loading="creating"
          variant="primary"
          @click="confirm"
        >Create</AhButton>
      </template>
    </AhDialog>

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
  import type { AhSplitLayoutExpose, AhStatusBadgeState, AhTerminalPaneExpose } from '@/components/ah'
  import type { AppTab } from '@agent-hub/shared'
  import { DEFAULT_COMMAND } from '@agent-hub/shared'
  import { computed, nextTick, ref, watch } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import { api } from '@/api/client'
  import { AhButton, AhDialog, AhSplitLayout, AhTab, AhTabPanel, AhTabs } from '@/components/ah'
  // Imported directly, not through the barrel, so xterm stays in the lazy Workspaces chunk.
  import AhTerminalPane from '@/components/ah/AhTerminalPane.vue'
  import EmptyState from '@/components/EmptyState.vue'
  import { useCloseTab } from '@/composables/useCloseTab'
  import { useLayoutSizesStore } from '@/stores/layoutSizes'
  import { useSessionsStore } from '@/stores/sessions'
  import { useTabsStore } from '@/stores/tabs'
  import { useUiStore } from '@/stores/ui'

  const route = useRoute()
  const router = useRouter()
  const tabs = useTabsStore()
  const sessions = useSessionsStore()
  const layoutSizes = useLayoutSizesStore()
  const ui = useUiStore()

  const closing = useCloseTab()
  const maximized = ref<string>()
  const createOpen = ref(false)
  const creating = ref(false)
  const createCwd = ref('~/')
  const createCommand = ref(DEFAULT_COMMAND)

  const activeTab = computed(() => tabs.tabs.find(tab => tab.id === tabs.activeId))
  const layoutRefs = new Map<string, AhSplitLayoutExpose>()
  const paneRefs = new Map<string, AhTerminalPaneExpose>()

  function setLayoutRef (tabId: string, el: unknown) {
    if (el) {
      layoutRefs.set(tabId, el as AhSplitLayoutExpose)
    } else {
      layoutRefs.delete(tabId)
    }
  }

  function setPaneRef (sessionId: string, el: unknown) {
    if (el) {
      paneRefs.set(sessionId, el as AhTerminalPaneExpose)
    } else {
      paneRefs.delete(sessionId)
    }
  }

  /** Refits the panes of the active tab after a splitter move or a tab switch. */
  function refit () {
    for (const pane of activeTab.value?.panes ?? []) {
      paneRefs.get(pane.sessionId)?.fit()
    }
  }

  function resetLayout () {
    if (tabs.activeId) {
      layoutRefs.get(tabs.activeId)?.resetSizes()
    }
  }

  watch(() => tabs.activeId, () => nextTick(refit))
  watch(() => tabs.tabs.map(tab => tab.id), ids => layoutSizes.prune(ids))

  const canCreate = computed(() => createCwd.value.trim() !== '' && createCommand.value.trim() !== '')

  function required (value: string): true | string {
    return value.trim() !== '' || 'Required'
  }

  function paneTitle (sessionId: string): string {
    const session = sessions.byId.get(sessionId)
    return session?.title ?? session?.command ?? sessionId
  }

  function toggleMaximize (sessionId: string) {
    maximized.value = maximized.value === sessionId ? undefined : sessionId
  }

  function openCreate () {
    createCwd.value = '~/'
    createCommand.value = DEFAULT_COMMAND
    createOpen.value = true
  }

  async function createSession () {
    if (!canCreate.value || creating.value) {
      return
    }
    creating.value = true
    try {
      const { session } = await api.createSession({ cwd: createCwd.value.trim(), command: createCommand.value.trim() })
      sessions.upsert(session)
      const tab: AppTab = { id: `tab-${session.id}`, title: session.title ?? session.command, layout: { kind: 'single' }, panes: [{ sessionId: session.id }] }
      tabs.add(tab)
      createOpen.value = false
      void router.push(`/workspaces/${tab.id}`)
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : 'Could not create the session', 'error')
    } finally {
      creating.value = false
    }
  }

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
  min-height: 0;
  padding: var(--ah-space-1);
  background: var(--ah-color-bg-canvas);
}

/* `hidden` must keep winning over the flex layout of the active panel. */
.workspaces__panel:not([hidden]) {
  position: relative;
  display: flex;
  flex-direction: column;
}

.workspaces__layout { flex: 1; min-height: 0; }

.workspaces__pane { height: 100%; }

.workspaces__form {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-4);
  padding-top: var(--ah-space-2);
}

.workspaces__sessions {
  margin: var(--ah-space-2) 0;
  padding-left: var(--ah-space-6);
}
</style>
