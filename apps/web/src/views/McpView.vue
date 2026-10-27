<template>
  <section ref="root" class="mcp">
    <header class="mcp__toolbar">
      <h1 class="mcp__title">MCP servers</h1>
      <span v-if="mcp.mode" class="mcp__mode">{{ modeText }}</span>
      <span class="mcp__spacer" />
      <AhButton :loading="mcp.loading" prepend-icon="mdi-refresh" @click="reloadAll">Reload</AhButton>
      <AhButton prepend-icon="mdi-plus" variant="primary" @click="openAdd()">Add server</AhButton>
    </header>

    <EmptyState
      v-if="mcp.error"
      action-label="Retry"
      icon="mdi-alert-circle-outline"
      :message="`Could not load MCP servers: ${mcp.error}`"
      @action="reloadAll"
    />

    <div v-else class="mcp__body">
      <McpScopeTree
        class="mcp__tree"
        :groups="mcp.groups"
        :selected="selectedKey"
        @add="openAdd"
        @select="select"
      />

      <div class="mcp__detail">
        <McpServerDetail v-if="selected" :entry="selected" @edit="editOpen = true" @remove="openRemove" />

        <EmptyState
          v-else-if="mcp.entries.length === 0 && !mcp.loading"
          action-label="Add server"
          icon="mdi-connection"
          message="No MCP servers configured yet"
          @action="openAdd()"
        />

        <p v-else class="mcp__hint">Select a server to see its details.</p>
      </div>
    </div>

    <McpServerDialog
      v-model="addOpen"
      :project-path="addPath"
      :projects="projects"
      :scope="addScope"
      @saved="onSaved"
    />

    <McpServerDialog v-if="selected" v-model="editOpen" :entry="selected" @saved="onSaved" />

    <McpRemoveDialog
      v-if="removeEntry"
      v-model="removeOpen"
      :entry="removeEntry"
      @after-leave="onRemoveLeave"
      @removed="removed = true"
    />
  </section>
</template>

<script lang="ts" setup>
  import type { McpScope, McpServerEntryMasked } from '@agent-hub/shared'
  import { computed, nextTick, onMounted, ref } from 'vue'
  import { AhButton } from '@/components/ah'
  import EmptyState from '@/components/EmptyState.vue'
  import McpRemoveDialog from '@/components/mcp/McpRemoveDialog.vue'
  import McpScopeTree from '@/components/mcp/McpScopeTree.vue'
  import McpServerDetail from '@/components/mcp/McpServerDetail.vue'
  import McpServerDialog from '@/components/mcp/McpServerDialog.vue'
  import { entryKey, useMcpStore } from '@/stores/mcp'
  import { useScopesStore } from '@/stores/scopes'

  const mcp = useMcpStore()
  const scopes = useScopesStore()

  const selectedKey = ref<string>()
  const addOpen = ref(false)
  const editOpen = ref(false)
  const removeOpen = ref(false)
  const addPath = ref<string>()
  const addScope = ref<McpScope>()
  const removeEntry = ref<McpServerEntryMasked>()
  const removed = ref(false)
  const root = ref<HTMLElement>()

  const projects = computed(() => mcp.groups.flatMap(group => (group.path ? [group.path] : [])))

  const selected = computed(() => mcp.entries.find(entry => entryKey(entry) === selectedKey.value))

  const modeText = computed(() =>
    mcp.mode === 'cli' ? `claude CLI${mcp.cliVersion ? ` ${mcp.cliVersion}` : ''}` : 'Direct file edits')

  function select (entry: McpServerEntryMasked) {
    selectedKey.value = entryKey(entry)
  }

  function onSaved (target: { name: string, scope: McpScope }) {
    selectedKey.value = entryKey(target)
  }

  /** Works on a snapshot, so the dialog survives the list reload that follows a removal. */
  function openRemove () {
    removeEntry.value = selected.value
    removed.value = false
    removeOpen.value = true
  }

  async function onRemoveLeave () {
    if (!removed.value) {
      return
    }
    removed.value = false
    selectedKey.value = undefined
    removeEntry.value = undefined
    await nextTick()
    const next = root.value?.querySelector<HTMLElement>('.mcp__tree button:not(:disabled)') ?? root.value?.querySelector<HTMLElement>('.mcp__toolbar button')
    next?.focus()
  }

  function reloadAll () {
    void scopes.load()
    return mcp.reload()
  }

  /** Preselects the given scope, or the one of the selected server, so new servers land next to it. */
  function openAdd (target?: McpScope) {
    const scope = target ?? selected.value?.scope
    addScope.value = scope
    addPath.value = scope && scope.kind !== 'user' ? scope.projectPath : undefined
    addOpen.value = true
  }

  onMounted(reloadAll)
</script>

<style scoped>
.mcp {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--ah-space-4);
  min-height: 0;
  padding: var(--ah-space-4);
}

.mcp__toolbar {
  display: flex;
  gap: var(--ah-space-2);
  align-items: center;
}

.mcp__title {
  margin: 0;
  font-size: var(--ah-font-size-lg);
  font-weight: var(--ah-font-weight-semibold);
}

.mcp__mode {
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-sm);
}

.mcp__spacer { flex: 1; }

.mcp__body {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(240px, 1fr) 2fr;
  gap: var(--ah-space-4);
  min-height: 0;
}

.mcp__tree,
.mcp__detail {
  padding: var(--ah-space-3);
  border: 1px solid var(--ah-color-border-default);
  border-radius: var(--ah-radius-md);
  background: var(--ah-color-bg-surface);
}

.mcp__hint {
  margin: 0;
  color: var(--ah-color-fg-muted);
}
</style>
