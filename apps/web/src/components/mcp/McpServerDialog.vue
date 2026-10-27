<template>
  <AhDialog
    v-model="open"
    confirm-text="Save"
    :loading="saving"
    size="lg"
    :title="form.mode === 'edit' ? `Edit ${form.name}` : 'Add MCP server'"
    @after-leave="reset"
    @confirm="submit"
  >
    <form class="mcp-form" novalidate @submit.prevent="submit">
      <v-text-field
        v-model="form.name"
        autocomplete="off"
        density="compact"
        :disabled="form.mode === 'edit'"
        :error-messages="errors.name"
        hide-details="auto"
        label="Name"
        variant="outlined"
      />

      <v-select
        v-model="form.scopeKind"
        density="compact"
        :disabled="form.mode === 'edit'"
        hide-details="auto"
        item-title="title"
        item-value="value"
        :items="scopeItems"
        label="Scope"
        variant="outlined"
      />

      <v-radio-group
        v-model="form.transport"
        density="compact"
        :disabled="form.mode === 'edit'"
        hide-details="auto"
        inline
        label="Transport"
      >
        <v-radio v-for="item in TRANSPORTS" :key="item" :label="item" :value="item" />
      </v-radio-group>

      <template v-if="form.transport === 'stdio'">
        <v-text-field
          v-model="form.command"
          autocomplete="off"
          density="compact"
          :error-messages="errors.command"
          hide-details="auto"
          label="Command"
          variant="outlined"
        />

        <v-textarea
          v-model="form.argsText"
          density="compact"
          hide-details="auto"
          hint="One argument per line"
          label="Arguments"
          persistent-hint
          rows="3"
          variant="outlined"
        />
      </template>

      <v-text-field
        v-else
        v-model="form.url"
        autocomplete="off"
        density="compact"
        :error-messages="errors.url"
        hide-details="auto"
        label="URL"
        variant="outlined"
      />

      <fieldset class="mcp-form__rows">
        <legend>{{ rowsLabel }}</legend>

        <div v-for="row in form.rows" :key="row.id" class="mcp-form__row">
          <v-text-field
            v-model="row.key"
            :aria-label="`${rowsLabel} key`"
            autocomplete="off"
            density="compact"
            :disabled="row.masked"
            hide-details="auto"
            placeholder="Key"
            variant="outlined"
          />

          <v-text-field
            v-model="row.value"
            :append-inner-icon="revealed.has(row.id) ? 'mdi-eye-off' : 'mdi-eye'"
            :aria-label="`${row.key || 'New'} value`"
            autocomplete="new-password"
            density="compact"
            :disabled="row.clear"
            :error-messages="errors.rows[row.id]"
            hide-details="auto"
            :placeholder="row.masked ? 'unchanged, leave empty to keep' : 'Value'"
            :type="revealed.has(row.id) ? 'text' : 'password'"
            variant="outlined"
            @click:append-inner="toggleReveal(row.id)"
          />

          <v-checkbox
            v-if="row.masked"
            v-model="row.clear"
            density="compact"
            hide-details
            :label="`Clear ${row.key}`"
          />

          <AhButton
            v-else
            :ariaLabel="`Remove row ${row.key || ''}`.trim()"
            icon="mdi-close"
            size="sm"
            variant="ghost"
            @click="removeRow(row.id)"
          />
        </div>

        <AhButton prepend-icon="mdi-plus" size="sm" @click="form.rows.push(newRow())">Add row</AhButton>
      </fieldset>

      <p v-if="serverError" class="mcp-form__error" role="alert">{{ serverError }}</p>
    </form>
  </AhDialog>
</template>

<script lang="ts" setup>
  import type { McpScope, McpServerEntryMasked } from '@agent-hub/shared'
  import { computed, reactive, ref, watch } from 'vue'
  import { ApiClientError } from '@/api/client'
  import { AhButton, AhDialog } from '@/components/ah'
  import { useMcpStore } from '@/stores/mcp'
  import { buildRequest, emptyForm, formFromEntry, hasErrors, newRow, validateForm } from './mcpForm'

  const TRANSPORTS = ['stdio', 'http', 'sse'] as const

  const open = defineModel<boolean>({ required: true })
  const props = defineProps<{
    /** Server to edit; add mode when absent. */
    entry?: McpServerEntryMasked
    /** Project or worktree path that project and local scopes apply to. */
    projectPath?: string
    /** Scope preselected in add mode. */
    scope?: McpScope
  }>()

  const emit = defineEmits<{
    saved: []
  }>()

  const mcp = useMcpStore()
  const form = reactive(emptyForm())
  const saving = ref(false)
  const submitted = ref(false)
  const serverError = ref<string>()
  const revealed = ref(new Set<number>())

  const errors = computed(() => {
    const result = validateForm(form)
    if (!submitted.value) {
      const live = (message?: string) => (message?.endsWith('is required') ? undefined : message)
      return { name: live(result.name), url: live(result.url), rows: {} }
    }
    return result
  })

  const rowsLabel = computed(() => (form.transport === 'stdio' ? 'Environment variables' : 'Headers'))

  const scopeItems = computed(() => {
    const items = [{ title: 'User (all projects)', value: 'user' }]
    if (form.projectPath) {
      items.push(
        { title: 'Project (.mcp.json, shared)', value: 'project' },
        { title: 'Local (private)', value: 'local' },
      )
    }
    return items
  })

  function toggleReveal (id: number) {
    const next = new Set(revealed.value)
    if (!next.delete(id)) {
      next.add(id)
    }
    revealed.value = next
  }

  function removeRow (id: number) {
    form.rows = form.rows.filter(row => row.id !== id)
  }

  function init () {
    submitted.value = false
    serverError.value = undefined
    revealed.value = new Set()
    if (props.entry) {
      Object.assign(form, formFromEntry(props.entry))
    } else {
      const scope = props.scope ?? { kind: 'user' }
      Object.assign(form, emptyForm(scope.kind, props.projectPath ?? ''))
    }
  }

  /** Drops everything typed, secrets included. */
  function reset () {
    Object.assign(form, emptyForm())
    revealed.value = new Set()
    serverError.value = undefined
    submitted.value = false
  }

  watch(open, isOpen => {
    if (isOpen) {
      init()
    }
  }, { immediate: true })

  watch(() => form.transport, () => {
    if (form.mode === 'add') {
      form.rows = []
    }
  })

  async function submit () {
    submitted.value = true
    serverError.value = undefined
    if (saving.value || hasErrors(validateForm(form))) {
      return
    }
    saving.value = true
    try {
      await mcp.upsert(buildRequest(form))
      for (const row of form.rows) {
        row.value = ''
      }
      open.value = false
      emit('saved')
    } catch (error) {
      serverError.value = error instanceof ApiClientError || error instanceof Error ? error.message : 'Could not save the server'
    } finally {
      saving.value = false
    }
  }
</script>

<style scoped>
.mcp-form {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-3);
  padding: var(--ah-space-2) 0;
}

.mcp-form__rows {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-2);
  align-items: flex-start;
  min-width: 0;
  padding: var(--ah-space-3);
  border: 1px solid var(--ah-color-border-default);
  border-radius: var(--ah-radius-md);
}

.mcp-form__rows legend {
  padding: 0 var(--ah-space-1);
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-sm);
}

.mcp-form__row {
  display: grid;
  grid-template-columns: 1fr 2fr auto;
  gap: var(--ah-space-2);
  align-items: start;
  width: 100%;
}

.mcp-form__error {
  margin: 0;
  color: var(--ah-color-danger-default);
  font-size: var(--ah-font-size-sm);
}
</style>
