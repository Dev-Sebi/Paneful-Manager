<template>
  <section :aria-labelledby="titleId" class="file-pane">
    <EmptyState v-if="!file" :icon="emptyIcon" :message="emptyMessage" />

    <template v-else>
      <header class="file-pane__header">
        <div class="file-pane__title">
          <span
            v-if="files.dirty"
            aria-label="Unsaved changes"
            class="file-pane__dot"
            role="img"
            title="Unsaved changes"
          />

          <code :id="titleId" class="file-pane__path" :title="file.path">{{ file.relPath }}</code>
          <span class="file-pane__chip">{{ scopeLabel(file.scope) }}</span>

          <PmStatusBadge
            v-if="file.scope.kind === 'worktree' && file.scope.branch"
            :label="file.scope.branch"
            size="sm"
            state="idle"
          />
        </div>

        <div class="file-pane__actions">
          <PmButton
            :disabled="!files.dirty"
            :loading="files.saving"
            shortcut="Ctrl+S"
            variant="primary"
            @click="save"
          >
            Save
          </PmButton>

          <PmButton :disabled="files.saving" variant="danger" @click="emit('delete')">Delete</PmButton>
        </div>
      </header>

      <p v-if="files.fileError" class="file-pane__error" role="alert">{{ files.fileError }}</p>

      <ConflictBanner
        v-if="banner"
        :busy="files.saving"
        :kind="banner"
        @overwrite="files.overwrite()"
        @reload="files.reload()"
      />

      <section v-if="isSkillMain" aria-label="Frontmatter preview" class="file-pane__preview">
        <dl class="file-pane__fields">
          <dt>name</dt>
          <dd>{{ previewField('name') ?? '-' }}</dd>
          <dt>description</dt>
          <dd>{{ previewField('description') ?? '-' }}</dd>
        </dl>

        <ul v-if="hints.length > 0" class="file-pane__hints">
          <li v-for="hint in hints" :key="hint">{{ hint }}</li>
        </ul>
      </section>

      <PmCodeEditor
        :ariaLabel="`Editing ${file.relPath}`"
        class="file-pane__editor"
        :language="language"
        :model-value="files.buffer"
        :path="file.path"
        @save="save"
        @update:model-value="files.setBuffer"
      />
    </template>
  </section>
</template>

<script lang="ts" setup>
  import type { EditorLanguage } from '@/components/editor/PmCodeEditor.vue'
  import { computed, useId } from 'vue'
  import { PmButton, PmStatusBadge } from '@/components/pm'
  import PmCodeEditor from '@/components/editor/PmCodeEditor.vue'
  import { parseFrontmatter } from '@/components/editor/frontmatter'
  import EmptyState from '@/components/EmptyState.vue'
  import { useFilesStore } from '@/stores/files'
  import { useUiStore } from '@/stores/ui'
  import ConflictBanner from './ConflictBanner.vue'
  import { scopeLabel } from './scopeLabel'

  defineProps<{
    emptyIcon: string
    emptyMessage: string
  }>()

  const emit = defineEmits<{ delete: [] }>()

  const titleId = `file-pane-${useId()}`
  const files = useFilesStore()
  const ui = useUiStore()

  const LANGUAGES: Record<string, EditorLanguage> = { md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml' }

  const file = computed(() => files.current)
  const language = computed<EditorLanguage>(() => LANGUAGES[file.value?.path.split('.').at(-1) ?? ''] ?? 'plaintext')
  const isSkillMain = computed(() => file.value?.kind === 'skill' && file.value.relPath.endsWith('/SKILL.md'))

  const banner = computed(() => {
    if (files.conflict) {
      return 'conflict'
    }
    if (files.diskChange) {
      return files.diskChange.removed ? 'removed' : 'changed'
    }
    return undefined
  })

  const frontmatter = computed(() => parseFrontmatter(files.buffer))

  function previewField (key: string): string | undefined {
    const value = frontmatter.value.data?.[key]
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }

  const hints = computed(() => {
    const list: string[] = []
    if (frontmatter.value.error) {
      list.push(`Invalid frontmatter: ${frontmatter.value.error}`)
    } else if (frontmatter.value.data === null) {
      list.push('No frontmatter block. Start the file with --- and add name and description.')
    }
    if (frontmatter.value.data) {
      for (const key of ['name', 'description']) {
        if (previewField(key) === undefined) {
          list.push(`Missing "${key}" in the frontmatter`)
        }
      }
      const name = previewField('name')
      if (name && file.value && name !== file.value.name) {
        list.push(`"name" differs from the folder name "${file.value.name}"`)
      }
    }
    return list
  })

  async function save () {
    if (!files.dirty || files.saving) {
      return
    }
    if (await files.save()) {
      ui.notify('Saved')
    }
  }
</script>

<style scoped>
.file-pane {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--pm-space-3);
  min-width: 0;
  min-height: 0;
}

.file-pane__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--pm-space-3);
}

.file-pane__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--pm-space-2);
  min-width: 0;
}

.file-pane__path { overflow-wrap: anywhere; }

.file-pane__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--pm-radius-full);
  background: var(--pm-color-status-waiting);
}

.file-pane__chip {
  padding: 0 var(--pm-space-2);
  border-radius: var(--pm-radius-full);
  background: var(--pm-color-bg-elevated);
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-sm);
}

.file-pane__actions {
  display: flex;
  gap: var(--pm-space-2);
}

.file-pane__error {
  margin: 0;
  color: var(--pm-color-status-error);
  font-size: var(--pm-font-size-sm);
}

.file-pane__preview {
  padding: var(--pm-space-2) var(--pm-space-3);
  border: 1px solid var(--pm-color-border-default);
  border-radius: var(--pm-radius-md);
  background: var(--pm-color-bg-surface);
}

.file-pane__fields {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--pm-space-1) var(--pm-space-3);
  margin: 0;
  font-size: var(--pm-font-size-sm);
}

.file-pane__fields dt { color: var(--pm-color-fg-muted); }
.file-pane__fields dd { margin: 0; overflow-wrap: anywhere; }

.file-pane__hints {
  margin: var(--pm-space-2) 0 0;
  padding: 0;
  color: var(--pm-color-status-waiting);
  font-size: var(--pm-font-size-sm);
  list-style: none;
}

.file-pane__editor {
  flex: 1;
  min-height: 240px;
}
</style>
