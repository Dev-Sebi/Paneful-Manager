<template>
  <nav aria-label="Scopes" class="scope-tree">
    <ul class="scope-tree__scopes">
      <li v-for="scope in scopes" :key="`${scope.kind}:${scope.path}`" class="scope-tree__scope">
        <div class="scope-tree__head">
          <span class="scope-tree__name">{{ scopeLabel(scope) }}</span>
          <span class="scope-tree__kind">{{ scope.kind }}</span>

          <AhStatusBadge
            v-if="scope.kind === 'worktree' && scope.branch"
            class="scope-tree__branch"
            :label="scope.branch"
            size="sm"
            state="idle"
          />
        </div>

        <code class="scope-tree__path" :title="scope.path">{{ scope.path }}</code>

        <template v-if="mode === 'skills'">
          <p v-if="skillsOf(scope).length === 0" class="scope-tree__none">No skills</p>

          <ul v-else class="scope-tree__skills">
            <li v-for="skill in skillsOf(scope)" :key="skill.name">
              <span class="scope-tree__skill">{{ skill.name }}</span>

              <ul class="scope-tree__files">
                <li v-for="entry in skill.files" :key="entry.path">
                  <button
                    :aria-current="entry.path === selectedPath ? 'true' : undefined"
                    class="scope-tree__file"
                    :class="{ 'scope-tree__file--selected': entry.path === selectedPath }"
                    type="button"
                    @click="emit('select', entry)"
                  >
                    {{ skillFileLabel(entry) }}
                  </button>
                </li>
              </ul>
            </li>
          </ul>
        </template>

        <ul v-else class="scope-tree__files">
          <li v-for="item in claudeMdItems(scope)" :key="item.kind" class="scope-tree__row">
            <button
              v-if="item.entry"
              :aria-current="item.entry.path === selectedPath ? 'true' : undefined"
              class="scope-tree__file"
              :class="{ 'scope-tree__file--selected': item.entry.path === selectedPath }"
              type="button"
              @click="item.entry && emit('select', item.entry)"
            >
              {{ item.fileName }}
            </button>

            <template v-else>
              <span class="scope-tree__missing">{{ item.fileName }}</span>

              <AhButton
                :ariaLabel="`Create ${item.fileName} in ${scopeLabel(scope)}`"
                :disabled="busy"
                :loading="busy"
                size="sm"
                @click="emit('create', scope, item.kind)"
              >
                Create
              </AhButton>
            </template>
          </li>
        </ul>
      </li>
    </ul>
  </nav>
</template>

<script lang="ts" setup>
  import type { FilesMode } from './scopeLabel'
  import type { FileEntry, ManagedFileKind, Scope } from '@agent-hub/shared'
  import { AhButton, AhStatusBadge } from '@/components/ah'
  import { CLAUDE_MD_KINDS, scopeLabel, skillFileLabel } from './scopeLabel'

  const props = defineProps<{
    scopes: Scope[]
    entries: FileEntry[]
    mode: FilesMode
    selectedPath?: string
    busy?: boolean
  }>()

  const emit = defineEmits<{
    select: [entry: FileEntry]
    create: [scope: Scope, kind: Exclude<ManagedFileKind, 'skill'>]
  }>()

  function inScope (scope: Scope, kind: ManagedFileKind) {
    return props.entries.filter(entry => entry.scope.path === scope.path && entry.kind === kind)
  }

  function skillsOf (scope: Scope) {
    const groups = new Map<string, FileEntry[]>()
    for (const entry of inScope(scope, 'skill')) {
      groups.set(entry.name, [...(groups.get(entry.name) ?? []), entry])
    }
    return [...groups.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, files]) => ({
        name,
        files: files.toSorted((a, b) => Number(b.relPath.endsWith('/SKILL.md')) - Number(a.relPath.endsWith('/SKILL.md')) || a.relPath.localeCompare(b.relPath)),
      }))
  }

  function claudeMdItems (scope: Scope) {
    return CLAUDE_MD_KINDS.map(({ kind, fileName }) => ({
      kind,
      fileName,
      entry: inScope(scope, kind)[0],
    }))
  }
</script>

<style scoped>
.scope-tree {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-y: auto;
}

.scope-tree ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.scope-tree__scopes {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-3);
  padding: var(--ah-space-3);
}

.scope-tree__scope {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-1);
  padding: var(--ah-space-2);
  border: 1px solid var(--ah-color-border-default);
  border-radius: var(--ah-radius-md);
  background: var(--ah-color-bg-surface);
}

.scope-tree__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ah-space-2);
}

.scope-tree__name {
  font-weight: var(--ah-font-weight-semibold);
  overflow-wrap: anywhere;
}

.scope-tree__kind {
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-xs);
  text-transform: uppercase;
}

.scope-tree__path {
  overflow: hidden;
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-xs);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.scope-tree__none,
.scope-tree__missing {
  margin: 0;
  padding: var(--ah-space-1) var(--ah-space-2);
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-sm);
}

.scope-tree__skill {
  display: block;
  padding: var(--ah-space-1) 0;
  font-size: var(--ah-font-size-sm);
  font-weight: var(--ah-font-weight-medium);
}

.scope-tree__files { padding-left: var(--ah-space-2); }

.scope-tree__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ah-space-2);
  min-height: 28px;
}

.scope-tree__file {
  display: block;
  width: 100%;
  padding: var(--ah-space-1) var(--ah-space-2);
  border: 0;
  border-radius: var(--ah-radius-sm);
  background: transparent;
  color: var(--ah-color-fg-primary);
  font: inherit;
  font-size: var(--ah-font-size-sm);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--ah-motion-duration-fast) var(--ah-motion-easing-standard);
}

.scope-tree__file:hover { background: var(--ah-color-bg-hover); }
.scope-tree__file--selected { background: var(--ah-color-bg-selected); }

.scope-tree__file:focus-visible {
  outline: 2px solid var(--ah-color-border-focus);
  outline-offset: 1px;
}
</style>
