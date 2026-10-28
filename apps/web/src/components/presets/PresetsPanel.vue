<template>
  <section class="presets">
    <header class="presets__toolbar">
      <h2 class="presets__title">Presets</h2>
      <span class="presets__spacer" />

      <PmButton
        :disabled="tabs.tabs.length === 0"
        prepend-icon="mdi-content-save-outline"
        @click="openFromTabs"
      >Save current tabs</PmButton>

      <PmButton prepend-icon="mdi-plus" variant="primary" @click="openCreate">New preset</PmButton>
    </header>

    <p v-if="presets.error" class="presets__error" role="alert">Could not load presets: {{ presets.error }}</p>

    <p v-else-if="presets.presets.length === 0 && !presets.loading" class="presets__empty">No presets yet</p>

    <ul v-else class="presets__list">
      <li v-for="preset in presets.presets" :key="preset.name" class="presets__item">
        <div class="presets__info">
          <span class="presets__name">{{ preset.name }}</span>
          <span v-if="preset.autostart" class="presets__badge">Autostart</span>
          <span v-if="preset.description" class="presets__description">{{ preset.description }}</span>
        </div>

        <PmButton
          :ariaLabel="`Launch ${preset.name}`"
          :loading="launching === preset.name"
          prepend-icon="mdi-play"
          size="sm"
          variant="primary"
          @click="launch(preset.name)"
        >Launch</PmButton>

        <PmButton
          :ariaLabel="`Edit ${preset.name}`"
          icon="mdi-pencil-outline"
          size="sm"
          variant="ghost"
          @click="openEdit(preset)"
        />

        <PmButton
          :ariaLabel="`Delete ${preset.name}`"
          icon="mdi-delete-outline"
          size="sm"
          variant="ghost"
          @click="deleting = preset"
        />
      </li>
    </ul>

    <PresetDialog v-model="editOpen" :initial="initial" :preset="editing" @saved="ui.notify('Preset saved', 'success')" />

    <PmDialog
      confirm-text="Delete"
      initial-focus="[data-pm-cancel]"
      :loading="removing"
      :model-value="deleting !== undefined"
      :title="`Delete preset ${deleting?.name ?? ''}?`"
      tone="danger"
      @confirm="confirmDelete"
      @update:model-value="deleting = undefined"
    >
      <p>The file {{ deleting?.name }}.yaml is removed. Running sessions stay open.</p>
    </PmDialog>
  </section>
</template>

<script lang="ts" setup>
  import type { PresetForm } from './presetForm'
  import type { WorkspacePreset } from '@paneful-manager/shared'
  import { ref } from 'vue'
  import { useRouter } from 'vue-router'
  import { PmButton, PmDialog } from '@/components/pm'
  import { usePresetsStore } from '@/stores/presets'
  import { useSessionsStore } from '@/stores/sessions'
  import { useTabsStore } from '@/stores/tabs'
  import { useUiStore } from '@/stores/ui'
  import PresetDialog from './PresetDialog.vue'
  import { emptyForm, tabsToForm } from './presetForm'

  const emit = defineEmits<{ launched: [] }>()

  const presets = usePresetsStore()
  const tabs = useTabsStore()
  const sessions = useSessionsStore()
  const ui = useUiStore()
  const router = useRouter()

  const editOpen = ref(false)
  const editing = ref<WorkspacePreset>()
  const initial = ref<PresetForm>()
  const launching = ref<string>()
  const deleting = ref<WorkspacePreset>()
  const removing = ref(false)

  void presets.load()

  function openCreate () {
    editing.value = undefined
    initial.value = emptyForm()
    editOpen.value = true
  }

  function openEdit (preset: WorkspacePreset) {
    editing.value = preset
    initial.value = undefined
    editOpen.value = true
  }

  function openFromTabs () {
    editing.value = undefined
    initial.value = tabsToForm(tabs.tabs, sessions.byId)
    if (initial.value.tabs.length === 0) {
      ui.notify('The open tabs have no known sessions to save', 'warning')
      return
    }
    editOpen.value = true
  }

  async function launch (name: string) {
    launching.value = name
    try {
      const launched = await presets.launch(name)
      for (const tab of launched) {
        tabs.add(tab)
      }
      emit('launched')
      const first = launched[0]
      if (first) {
        void router.push(`/workspaces/${first.id}`)
      }
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : 'Could not launch the preset', 'error')
    } finally {
      launching.value = undefined
    }
  }

  async function confirmDelete () {
    const target = deleting.value
    if (!target) {
      return
    }
    removing.value = true
    try {
      await presets.remove(target.name)
      deleting.value = undefined
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : 'Could not delete the preset', 'error')
    } finally {
      removing.value = false
    }
  }
</script>

<style scoped>
.presets {
  display: flex;
  flex-direction: column;
  gap: var(--pm-space-3);
  width: 100%;
  max-width: 640px;
}

.presets__toolbar {
  display: flex;
  align-items: center;
  gap: var(--pm-space-2);
}

.presets__title {
  font-size: var(--pm-font-size-lg);
  font-weight: var(--pm-font-weight-semibold);
}

.presets__spacer { flex: 1; }

.presets__list {
  display: flex;
  flex-direction: column;
  gap: var(--pm-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.presets__item {
  display: flex;
  align-items: center;
  gap: var(--pm-space-2);
  padding: var(--pm-space-2) var(--pm-space-3);
  border: 1px solid var(--pm-color-border-default);
  border-radius: var(--pm-radius-md);
  background: var(--pm-color-bg-surface);
}

.presets__info {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--pm-space-2);
  min-width: 0;
  text-align: left;
}

.presets__name {
  color: var(--pm-color-fg-primary);
  font-weight: var(--pm-font-weight-medium);
}

.presets__badge {
  padding: 0 var(--pm-space-2);
  border: 1px solid var(--pm-color-border-default);
  border-radius: var(--pm-radius-full);
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-xs);
}

.presets__description {
  flex-basis: 100%;
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-sm);
}

.presets__empty,
.presets__error {
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-sm);
}

.presets__error { color: var(--pm-color-status-error); }
</style>
