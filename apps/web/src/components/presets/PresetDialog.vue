<template>
  <AhDialog
    v-model="open"
    :loading="saving"
    size="lg"
    :title="existing ? `Edit preset ${form.name}` : 'New preset'"
    @confirm="save"
  >
    <form class="preset-form" @submit.prevent="save">
      <v-text-field
        v-model="form.name"
        autocomplete="off"
        density="compact"
        :disabled="existing"
        hide-details="auto"
        label="Name"
        :rules="[required]"
        spellcheck="false"
        variant="outlined"
      />

      <v-text-field
        v-model="form.description"
        autocomplete="off"
        density="compact"
        hide-details="auto"
        label="Description"
        variant="outlined"
      />

      <v-checkbox v-model="form.autostart" density="compact" hide-details label="Autostart when the server starts" />

      <fieldset v-for="(tab, tabIndex) in form.tabs" :key="tabIndex" class="preset-form__tab">
        <legend class="preset-form__legend">Tab {{ tabIndex + 1 }}</legend>

        <div class="preset-form__row">
          <v-text-field
            v-model="tab.title"
            autocomplete="off"
            density="compact"
            hide-details="auto"
            label="Tab title"
            variant="outlined"
          />

          <v-select
            v-model="tab.layout"
            density="compact"
            hide-details="auto"
            :items="layoutItems(tab)"
            label="Layout"
            variant="outlined"
          />

          <AhButton
            ariaLabel="Remove tab"
            :disabled="form.tabs.length === 1"
            icon="mdi-delete-outline"
            size="sm"
            variant="ghost"
            @click="form.tabs.splice(tabIndex, 1)"
          />
        </div>

        <div v-for="(pane, paneIndex) in tab.panes" :key="paneIndex" class="preset-form__pane">
          <v-text-field
            v-model="pane.cwd"
            autocomplete="off"
            density="compact"
            hide-details="auto"
            label="Working directory"
            :rules="[required]"
            spellcheck="false"
            variant="outlined"
          />

          <v-text-field
            v-model="pane.command"
            autocomplete="off"
            density="compact"
            hide-details="auto"
            label="Command"
            :rules="[required]"
            spellcheck="false"
            variant="outlined"
          />

          <v-text-field
            v-model="pane.title"
            autocomplete="off"
            density="compact"
            hide-details="auto"
            label="Pane title"
            variant="outlined"
          />

          <v-textarea
            v-model="pane.args"
            auto-grow
            density="compact"
            hide-details="auto"
            hint="One argument per line"
            label="Arguments"
            persistent-hint
            rows="1"
            spellcheck="false"
            variant="outlined"
          />

          <AhButton
            ariaLabel="Remove pane"
            :disabled="tab.panes.length === 1"
            icon="mdi-close"
            size="sm"
            variant="ghost"
            @click="tab.panes.splice(paneIndex, 1)"
          />
        </div>

        <div>
          <AhButton
            :disabled="tab.panes.length >= MAX_PANES_PER_TAB"
            prepend-icon="mdi-plus"
            size="sm"
            variant="ghost"
            @click="tab.panes.push(emptyPane())"
          >Add pane</AhButton>
        </div>
      </fieldset>

      <div>
        <AhButton prepend-icon="mdi-plus" size="sm" variant="ghost" @click="form.tabs.push(emptyTab())">Add tab</AhButton>
      </div>

      <ul v-if="issues.length > 0" class="preset-form__issues" role="alert">
        <li v-for="issue in issues" :key="`${issue.path}:${issue.message}`">
          <code v-if="issue.path">{{ issue.path }}</code> {{ issue.message }}
        </li>
      </ul>
    </form>

    <template #actions="{ cancel, confirm }">
      <AhButton data-ah-cancel @click="cancel">Cancel</AhButton>
      <AhButton data-ah-confirm :loading="saving" variant="primary" @click="confirm">Save</AhButton>
    </template>
  </AhDialog>
</template>

<script lang="ts" setup>
  import type { FormIssue, PresetForm, TabForm } from './presetForm'
  import type { WorkspacePreset } from '@agent-hub/shared'
  import { MAX_PANES_PER_TAB } from '@agent-hub/shared'
  import { ref, watch } from 'vue'
  import { AhButton, AhDialog } from '@/components/ah'
  import { usePresetsStore } from '@/stores/presets'
  import { useUiStore } from '@/stores/ui'
  import { cloneForm, emptyForm, emptyPane, emptyTab, LAYOUT_OPTIONS, presetToForm, validateForm } from './presetForm'

  const open = defineModel<boolean>({ required: true })

  const props = defineProps<{
    /** Preset to edit; without it the dialog creates one, optionally from `initial`. */
    preset?: WorkspacePreset
    initial?: PresetForm
  }>()

  const emit = defineEmits<{ saved: [preset: WorkspacePreset] }>()

  const presets = usePresetsStore()
  const ui = useUiStore()
  const form = ref<PresetForm>(emptyForm())
  const issues = ref<FormIssue[]>([])
  const saving = ref(false)
  const existing = ref(false)

  watch(open, isOpen => {
    if (isOpen) {
      existing.value = props.preset !== undefined
      form.value = props.preset ? presetToForm(props.preset) : cloneForm(props.initial ?? emptyForm())
      issues.value = []
    }
  }, { immediate: true })

  function layoutItems (tab: TabForm) {
    return tab.custom ? [...LAYOUT_OPTIONS, 'custom'] : [...LAYOUT_OPTIONS]
  }

  function required (value: string): true | string {
    return value.trim() !== '' || 'Required'
  }

  async function save () {
    if (saving.value) {
      return
    }
    const result = validateForm(form.value)
    if ('issues' in result) {
      issues.value = result.issues
      return
    }
    issues.value = []
    saving.value = true
    try {
      const saved = await presets.save(result.preset, existing.value)
      emit('saved', saved)
      open.value = false
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : 'Could not save the preset', 'error')
    } finally {
      saving.value = false
    }
  }
</script>

<style scoped>
.preset-form {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-3);
  padding-top: var(--ah-space-2);
}

.preset-form__tab {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-3);
  margin: 0;
  padding: var(--ah-space-3);
  border: 1px solid var(--ah-color-border-default);
  border-radius: var(--ah-radius-md);
}

.preset-form__legend {
  padding: 0 var(--ah-space-1);
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-sm);
}

.preset-form__row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  align-items: start;
  gap: var(--ah-space-2);
}

.preset-form__pane {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr auto;
  align-items: start;
  gap: var(--ah-space-2);
}

.preset-form__issues {
  margin: 0;
  padding-left: var(--ah-space-6);
  color: var(--ah-color-status-error);
  font-size: var(--ah-font-size-sm);
}

@media (max-width: 640px) {
  .preset-form__row,
  .preset-form__pane { grid-template-columns: 1fr; }
}
</style>
