<template>
  <nav aria-label="MCP servers" class="mcp-tree">
    <ul class="mcp-tree__groups">
      <li v-for="group in groups" :key="group.key" class="mcp-tree__group">
        <div class="mcp-tree__heading">
          <v-icon aria-hidden="true" :icon="group.kind === 'user' ? 'mdi-account-outline' : 'mdi-folder-outline'" size="16" />
          <span class="mcp-tree__label" :title="group.path">{{ group.label }}</span>
          <span v-if="group.branch" class="mcp-tree__chip">{{ group.branch }}</span>
        </div>

        <section
          v-for="section in group.sections"
          :key="section.key"
          :aria-label="`${group.label} ${section.label}`"
          class="mcp-tree__section"
        >
          <div v-if="group.kind !== 'user'" class="mcp-tree__section-head">
            <h3 class="mcp-tree__section-title">{{ section.label }}</h3>

            <PmButton
              :ariaLabel="`Add server to ${group.label} ${section.label}`"
              icon="mdi-plus"
              size="sm"
              variant="ghost"
              @click="emit('add', section.scope)"
            />
          </div>

          <p v-if="section.servers.length === 0" class="mcp-tree__none">No servers</p>

          <ul v-else class="mcp-tree__servers">
            <li v-for="server in section.servers" :key="entryKey(server)">
              <button
                :aria-current="entryKey(server) === selected ? 'true' : undefined"
                class="mcp-tree__server"
                :class="{ 'mcp-tree__server--active': entryKey(server) === selected }"
                type="button"
                @click="emit('select', server)"
              >
                <span class="mcp-tree__name">{{ server.name }}</span>
                <span class="mcp-tree__chip">{{ server.config.transport }}</span>
                <span class="mcp-tree__source" :title="`Last written through ${server.source === 'cli' ? 'the claude CLI' : 'the config file'}`">{{ server.source }}</span>
                <slot :entry="server" name="health" />
              </button>
            </li>
          </ul>
        </section>
      </li>
    </ul>

    <p v-if="groups.length === 1" class="mcp-tree__hint">
      No projects configured. Add one in Settings to manage project and local servers.
    </p>
  </nav>
</template>

<script lang="ts" setup>
  import type { McpGroup } from '@/stores/mcp'
  import type { McpScope, McpServerEntryMasked } from '@paneful-manager/shared'
  import { PmButton } from '@/components/pm'
  import { entryKey } from '@/stores/mcp'

  defineProps<{
    groups: McpGroup[]
    /** `entryKey` of the selected server. */
    selected?: string
  }>()

  const emit = defineEmits<{
    add: [scope: McpScope]
    select: [entry: McpServerEntryMasked]
  }>()
</script>

<style scoped>
.mcp-tree {
  display: flex;
  flex-direction: column;
  gap: var(--pm-space-3);
  overflow-y: auto;
}

.mcp-tree ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.mcp-tree__groups {
  display: flex;
  flex-direction: column;
  gap: var(--pm-space-4);
}

.mcp-tree__heading {
  display: flex;
  gap: var(--pm-space-2);
  align-items: center;
  color: var(--pm-color-fg-primary);
  font-weight: var(--pm-font-weight-semibold);
}

.mcp-tree__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcp-tree__section { padding-left: var(--pm-space-4); }

.mcp-tree__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.mcp-tree__section-title {
  margin: var(--pm-space-1) 0;
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-xs);
  font-weight: var(--pm-font-weight-medium);
}

.mcp-tree__none,
.mcp-tree__hint {
  margin: 0;
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-sm);
}

.mcp-tree__server {
  display: flex;
  gap: var(--pm-space-2);
  align-items: center;
  width: 100%;
  padding: var(--pm-space-1) var(--pm-space-2);
  border: 0;
  border-radius: var(--pm-radius-md);
  background: transparent;
  color: var(--pm-color-fg-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--pm-motion-duration-fast) var(--pm-motion-easing-standard);
}

.mcp-tree__server:hover { background: var(--pm-color-bg-elevated); }
.mcp-tree__server:focus-visible { outline: 2px solid var(--pm-color-border-focus); }
.mcp-tree__server--active { background: var(--pm-color-bg-elevated); font-weight: var(--pm-font-weight-semibold); }

.mcp-tree__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcp-tree__chip {
  padding: 0 var(--pm-space-2);
  border: 1px solid var(--pm-color-border-default);
  border-radius: var(--pm-radius-full);
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-xs);
  font-weight: var(--pm-font-weight-regular);
}

.mcp-tree__source {
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-xs);
}
</style>
