<template>
  <div class="workbench">
    <header class="workbench__toolbar">
      <h1 class="workbench__title">{{ title }}</h1>

      <div class="workbench__actions">
        <PmButton ariaLabel="Refresh" icon="mdi-refresh" variant="ghost" @click="refresh" />

        <PmButton v-if="mode === 'skills'" prepend-icon="mdi-plus" variant="primary" @click="openNewSkill">
          New skill
        </PmButton>
      </div>
    </header>

    <p v-if="shownError" class="workbench__error" role="alert">{{ shownError }}</p>

    <EmptyState
      v-if="scopes.scopes.length === 0"
      action-label="Reload scopes"
      :icon="icon"
      :message="`No scopes found to ${mode === 'skills' ? 'manage skills' : 'edit CLAUDE.md'} in`"
      @action="refresh"
    />

    <div v-else class="workbench__body">
      <ScopeTree
        :busy="creatingFile"
        class="workbench__tree"
        :entries="files.entries"
        :mode="mode"
        :scopes="scopes.scopes"
        :selected-path="files.current?.path"
        @create="onCreate"
        @select="onSelect"
      />

      <FileEditorPane
        :empty-icon="icon"
        :empty-message="mode === 'skills' ? 'Select a skill file or create a new skill' : 'Select a CLAUDE.md file or create a missing one'"
        @delete="deleting = true"
      />
    </div>

    <NewSkillDialog
      v-model="newSkillOpen"
      :error="newSkillError"
      :loading="creating"
      :scopes="scopes.scopes"
      @submit="onNewSkill"
    />

    <ConfirmDeleteDialog
      v-model="deleting"
      :loading="removing"
      :message="deleteMessage"
      :title="deleteTitle"
      @confirm="onDelete"
    />

    <UnsavedChangesDialog
      :model-value="leaveOpen"
      @discard="settle(true)"
      @update:model-value="onLeaveToggle"
    />
  </div>
</template>

<script lang="ts" setup>
  import type { FilesMode } from './scopeLabel'
  import type { CreateFileRequest, FileEntry, ManagedFileKind, Scope } from '@paneful-manager/shared'
  import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
  import { onBeforeRouteLeave } from 'vue-router'
  import { ApiClientError } from '@/api/client'
  import { wsClient } from '@/api/ws'
  import EmptyState from '@/components/EmptyState.vue'
  import { PmButton } from '@/components/pm'
  import { useFilesStore } from '@/stores/files'
  import { useScopesStore } from '@/stores/scopes'
  import ConfirmDeleteDialog from './ConfirmDeleteDialog.vue'
  import FileEditorPane from './FileEditorPane.vue'
  import NewSkillDialog from './NewSkillDialog.vue'
  import ScopeTree from './ScopeTree.vue'
  import UnsavedChangesDialog from './UnsavedChangesDialog.vue'

  const CLAUDE_MD_STARTER = '<!-- Instructions for Claude in this scope. -->\n'

  const props = defineProps<{ mode: FilesMode }>()

  const files = useFilesStore()
  const scopes = useScopesStore()

  const title = computed(() => props.mode === 'skills' ? 'Skills' : 'CLAUDE.md')
  const icon = computed(() => props.mode === 'skills' ? 'mdi-lightning-bolt-outline' : 'mdi-file-document-outline')

  const actionError = ref<string>()
  const newSkillOpen = ref(false)
  const newSkillError = ref<string>()
  const creating = ref(false)
  const deleting = ref(false)
  const removing = ref(false)
  const leaveOpen = ref(false)
  const creatingFile = ref(false)
  const shownError = computed(() => actionError.value ?? files.error ?? scopes.error)

  let resolveLeave: ((ok: boolean) => void) | undefined
  let leavePending: Promise<boolean> | undefined
  let unbind: (() => void) | undefined

  /** The skill folder when the open file is its SKILL.md, otherwise just the file. */
  const deleteTarget = computed(() => {
    const file = files.current
    if (!file) {
      return undefined
    }
    const isMain = file.kind === 'skill' && file.relPath.endsWith('/SKILL.md')
    return { path: isMain ? file.path.slice(0, file.path.lastIndexOf('/')) : file.path, wholeSkill: isMain, name: file.name }
  })
  const deleteTitle = computed(() => deleteTarget.value?.wholeSkill ? `Delete skill "${deleteTarget.value.name}"?` : 'Delete file?')
  const deleteMessage = computed(() => deleteTarget.value?.wholeSkill
    ? 'The skill folder and its files are deleted. This cannot be undone.'
    : `${files.current?.relPath ?? 'The file'} is deleted. This cannot be undone.`)

  /** Resolves true right away when nothing is unsaved, otherwise after the user decides. */
  function confirmDiscard (): Promise<boolean> {
    if (!files.dirty) {
      return Promise.resolve(true)
    }
    leavePending ??= new Promise(resolve => {
      resolveLeave = resolve
    })
    leaveOpen.value = true
    return leavePending
  }

  function settle (ok: boolean) {
    leaveOpen.value = false
    resolveLeave?.(ok)
    resolveLeave = undefined
    leavePending = undefined
  }

  function onLeaveToggle (open: boolean) {
    if (!open) {
      settle(false)
    }
  }

  onBeforeRouteLeave(() => confirmDiscard())

  function onBeforeUnload (event: BeforeUnloadEvent) {
    if (files.dirty) {
      event.preventDefault()
    }
  }

  async function refresh () {
    await Promise.all([scopes.load(), files.load()])
  }

  watch(() => files.dirty, dirty => {
    if (dirty) {
      window.addEventListener('beforeunload', onBeforeUnload)
    } else {
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  })

  onMounted(() => {
    unbind = files.bind(wsClient)
    void refresh()
  })

  onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', onBeforeUnload)
    unbind?.()
    files.close()
  })

  async function onSelect (entry: FileEntry) {
    actionError.value = undefined
    if (entry.path === files.current?.path || !(await confirmDiscard())) {
      return
    }
    await files.open(entry.path)
  }

  async function openNewSkill () {
    if (await confirmDiscard()) {
      newSkillError.value = undefined
      newSkillOpen.value = true
    }
  }

  function createError (error: unknown, conflictMessage: string): string {
    if (error instanceof ApiClientError && error.code === 'conflict') {
      return conflictMessage
    }
    return error instanceof Error ? error.message : 'Could not create the file'
  }

  async function onNewSkill (request: CreateFileRequest) {
    creating.value = true
    try {
      await files.create(request)
      newSkillOpen.value = false
    } catch (error) {
      newSkillError.value = createError(error, `A skill named "${request.name}" already exists in this scope`)
    } finally {
      creating.value = false
    }
  }

  async function onCreate (scope: Scope, kind: Exclude<ManagedFileKind, 'skill'>) {
    actionError.value = undefined
    if (!(await confirmDiscard())) {
      return
    }
    creatingFile.value = true
    try {
      await files.create({ scopePath: scope.path, kind, template: 'empty' }, CLAUDE_MD_STARTER)
    } catch (error) {
      actionError.value = createError(error, 'This file already exists')
    } finally {
      creatingFile.value = false
    }
  }

  async function onDelete () {
    const target = deleteTarget.value
    if (!target) {
      return
    }
    removing.value = true
    await files.remove(target.path)
    removing.value = false
    deleting.value = false
  }
</script>

<style scoped>
.workbench {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--pm-space-3);
  height: 100%;
  min-height: 0;
  padding: var(--pm-space-4);
}

.workbench__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--pm-space-3);
}

.workbench__title {
  margin: 0;
  font-size: var(--pm-font-size-xl);
  font-weight: var(--pm-font-weight-semibold);
}

.workbench__actions {
  display: flex;
  gap: var(--pm-space-2);
}

.workbench__error {
  margin: 0;
  color: var(--pm-color-status-error);
  font-size: var(--pm-font-size-sm);
}

.workbench__body {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
  gap: var(--pm-space-4);
  align-content: start;
  min-height: 0;
}

.workbench__tree { max-height: 100%; }

@media (width <= 800px) {
  .workbench__body { grid-template-columns: minmax(0, 1fr); }
}
</style>
