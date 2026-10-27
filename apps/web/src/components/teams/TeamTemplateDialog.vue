<template>
  <AhDialog
    v-model="open"
    :loading="saving"
    size="lg"
    :title="existing ? `Edit team template ${form.name}` : 'New team template'"
    @confirm="save"
  >
    <form class="team-template-form" @submit.prevent="save">
      <div class="team-template-form__row">
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
      </div>

      <v-textarea
        v-model="form.goal"
        auto-grow
        density="compact"
        hide-details="auto"
        hint="Added to the lead's first prompt"
        label="Team goal"
        persistent-hint
        rows="2"
        variant="outlined"
      />

      <fieldset class="team-template-form__group">
        <legend class="team-template-form__legend">Lead</legend>

        <div class="team-template-form__row">
          <v-text-field
            v-model="form.leadCwd"
            autocomplete="off"
            density="compact"
            hide-details="auto"
            label="Working directory"
            :rules="[required]"
            spellcheck="false"
            variant="outlined"
          />

          <v-text-field
            v-model="form.leadCommand"
            autocomplete="off"
            density="compact"
            hide-details="auto"
            label="Command"
            :rules="[required]"
            spellcheck="false"
            variant="outlined"
          />

          <v-text-field
            v-model="form.leadModel"
            autocomplete="off"
            density="compact"
            hide-details="auto"
            label="Model"
            spellcheck="false"
            variant="outlined"
          />
        </div>

        <v-textarea
          v-model="form.leadArgs"
          auto-grow
          density="compact"
          hide-details="auto"
          hint="One argument per line; team flags are added on launch"
          label="Arguments"
          persistent-hint
          rows="1"
          spellcheck="false"
          variant="outlined"
        />
      </fieldset>

      <fieldset v-for="(teammate, index) in form.teammates" :key="index" class="team-template-form__group">
        <legend class="team-template-form__legend">Teammate {{ index + 1 }}</legend>

        <div class="team-template-form__row team-template-form__row--teammate">
          <v-text-field
            v-model="teammate.name"
            autocomplete="off"
            density="compact"
            hide-details="auto"
            label="Name"
            :rules="[required]"
            spellcheck="false"
            variant="outlined"
          />

          <v-text-field
            v-model="teammate.model"
            autocomplete="off"
            density="compact"
            hide-details="auto"
            label="Model"
            spellcheck="false"
            variant="outlined"
          />

          <v-text-field
            v-model="teammate.cwd"
            autocomplete="off"
            density="compact"
            hide-details="auto"
            label="Working directory"
            spellcheck="false"
            variant="outlined"
          />

          <AhButton
            :ariaLabel="`Remove teammate ${index + 1}`"
            :disabled="form.teammates.length === 1"
            icon="mdi-delete-outline"
            size="sm"
            variant="ghost"
            @click="form.teammates.splice(index, 1)"
          />
        </div>

        <v-textarea
          v-model="teammate.prompt"
          auto-grow
          density="compact"
          hide-details="auto"
          label="Role and instructions"
          :rules="[required]"
          rows="2"
          variant="outlined"
        />
      </fieldset>

      <div>
        <AhButton
          :disabled="form.teammates.length >= MAX_TEAMMATES"
          prepend-icon="mdi-plus"
          size="sm"
          variant="ghost"
          @click="form.teammates.push(emptyTeammate())"
        >Add teammate</AhButton>
      </div>

      <v-textarea
        v-model="form.env"
        auto-grow
        density="compact"
        hide-details="auto"
        :hint="`One KEY=value per line. Allowed: ${TEAM_TEMPLATE_ENV_KEYS.join(', ')}`"
        label="Environment"
        persistent-hint
        rows="1"
        spellcheck="false"
        variant="outlined"
      />

      <ul v-if="issues.length > 0" class="team-template-form__issues" role="alert">
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
  import type { FormIssue, TeamTemplateForm } from './teamTemplateForm'
  import type { TeamTemplate } from '@agent-hub/shared'
  import { MAX_TEAMMATES, TEAM_TEMPLATE_ENV_KEYS } from '@agent-hub/shared'
  import { ref, watch } from 'vue'
  import { AhButton, AhDialog } from '@/components/ah'
  import { useTeamTemplatesStore } from '@/stores/teamTemplates'
  import { useUiStore } from '@/stores/ui'
  import { emptyTeammate, emptyTemplateForm, templateToForm, validateTemplateForm } from './teamTemplateForm'

  const open = defineModel<boolean>({ required: true })

  const props = defineProps<{
    /** Template to edit; without it the dialog creates a new one. */
    template?: TeamTemplate
  }>()

  const emit = defineEmits<{ saved: [template: TeamTemplate] }>()

  const store = useTeamTemplatesStore()
  const ui = useUiStore()
  const form = ref<TeamTemplateForm>(emptyTemplateForm())
  const issues = ref<FormIssue[]>([])
  const saving = ref(false)
  const existing = ref(false)

  watch(open, isOpen => {
    if (isOpen) {
      existing.value = props.template !== undefined
      form.value = props.template ? templateToForm(props.template) : emptyTemplateForm()
      issues.value = []
    }
  }, { immediate: true })

  function required (value: string): true | string {
    return value.trim() !== '' || 'Required'
  }

  async function save () {
    if (saving.value) {
      return
    }
    const result = validateTemplateForm(form.value)
    if ('issues' in result) {
      issues.value = result.issues
      return
    }
    issues.value = []
    saving.value = true
    try {
      const saved = await store.save(result.template, existing.value)
      emit('saved', saved)
      open.value = false
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : 'Could not save the team template', 'error')
    } finally {
      saving.value = false
    }
  }
</script>

<style scoped>
.team-template-form {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-3);
  padding-top: var(--ah-space-2);
}

.team-template-form__group {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-3);
  margin: 0;
  padding: var(--ah-space-3);
  border: 1px solid var(--ah-color-border-default);
  border-radius: var(--ah-radius-md);
}

.team-template-form__legend {
  padding: 0 var(--ah-space-1);
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-sm);
}

.team-template-form__row {
  display: grid;
  grid-auto-columns: 1fr;
  grid-auto-flow: column;
  align-items: start;
  gap: var(--ah-space-2);
}

.team-template-form__row--teammate { grid-template-columns: 1fr 1fr 1fr auto; grid-auto-flow: row; }

.team-template-form__issues {
  margin: 0;
  padding-left: var(--ah-space-6);
  color: var(--ah-color-status-error);
  font-size: var(--ah-font-size-sm);
}

@media (max-width: 640px) {
  .team-template-form__row { grid-auto-flow: row; }
  .team-template-form__row--teammate { grid-template-columns: 1fr; }
}
</style>
