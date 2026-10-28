<template>
  <PmDialog
    confirm-text="Create skill"
    initial-focus="input"
    :loading="loading"
    :model-value="modelValue"
    title="New skill"
    @confirm="submit"
    @update:model-value="forward"
  >
    <form class="new-skill" novalidate @submit.prevent="submit">
      <label class="new-skill__label" :for="nameId">Name</label>

      <input
        :id="nameId"
        v-model="name"
        :aria-describedby="nameHint"
        :aria-invalid="nameError ? 'true' : undefined"
        autocomplete="off"
        class="new-skill__field"
        spellcheck="false"
        type="text"
        @blur="touched = true"
      >

      <p :id="nameHint" class="new-skill__hint" :class="{ 'new-skill__hint--error': nameError }">
        {{ nameError ?? 'Letters, numbers, dots, dashes and underscores; starts with a letter or number.' }}
      </p>

      <label class="new-skill__label" :for="scopeId">Scope</label>

      <select :id="scopeId" v-model="scopePath" class="new-skill__field">
        <option v-for="scope in scopes" :key="scope.path" :value="scope.path">{{ optionLabel(scope) }}</option>
      </select>

      <p v-if="error" class="new-skill__hint new-skill__hint--error" role="alert">{{ error }}</p>
    </form>
  </PmDialog>
</template>

<script lang="ts" setup>

  import type { CreateFileRequest, Scope } from '@paneful-manager/shared'
  import { SkillNameSchema } from '@paneful-manager/shared'
  import { computed, ref, useId, watch } from 'vue'
  import { PmDialog } from '@/components/pm'
  import { scopeLabel } from './scopeLabel'

  const props = defineProps<{
    modelValue: boolean
    scopes: Scope[]
    defaultScopePath?: string
    loading?: boolean
    error?: string
  }>()

  const emit = defineEmits<{
    'update:modelValue': [value: boolean]
    'submit': [request: CreateFileRequest]
  }>()

  const id = useId()
  const nameId = `${id}-name`
  const nameHint = `${id}-hint`
  const scopeId = `${id}-scope`

  const name = ref('')
  const scopePath = ref('')
  const touched = ref(false)

  const nameError = computed(() => {
    if (!touched.value) {
      return undefined
    }
    if (name.value === '') {
      return 'Enter a name'
    }
    return SkillNameSchema.safeParse(name.value).success ? undefined : 'Use letters, numbers, ".", "-" or "_" (max 64), starting with a letter or number'
  })

  watch(() => props.modelValue, open => {
    if (open) {
      name.value = ''
      touched.value = false
      scopePath.value = props.scopes.find(scope => scope.path === props.defaultScopePath)?.path ?? props.scopes[0]?.path ?? ''
    }
  }, { immediate: true })

  function optionLabel (scope: Scope) {
    const branch = scope.kind === 'worktree' && scope.branch ? `, ${scope.branch}` : ''
    return `${scopeLabel(scope)} (${scope.kind}${branch})`
  }

  function submit () {
    touched.value = true
    const parsed = SkillNameSchema.safeParse(name.value)
    if (parsed.success && scopePath.value) {
      emit('submit', { scopePath: scopePath.value, kind: 'skill', name: parsed.data, template: 'skill' })
    }
  }

  function forward (value: boolean) {
    // eslint-disable-next-line vue/custom-event-name-casing
    emit('update:modelValue', value)
  }
</script>

<style scoped>
.new-skill {
  display: flex;
  flex-direction: column;
  gap: var(--pm-space-1);
}

.new-skill__label {
  margin-top: var(--pm-space-2);
  font-size: var(--pm-font-size-sm);
  font-weight: var(--pm-font-weight-medium);
}

.new-skill__field {
  height: 28px;
  padding: 0 var(--pm-space-2);
  border: 1px solid var(--pm-color-border-default);
  border-radius: var(--pm-radius-md);
  background: var(--pm-color-bg-canvas);
  color: var(--pm-color-fg-primary);
  font: inherit;
}

.new-skill__field:focus-visible {
  outline: 2px solid var(--pm-color-border-focus);
  outline-offset: 1px;
}

.new-skill__field[aria-invalid="true"] { border-color: var(--pm-color-status-error); }

.new-skill__hint {
  min-height: 1.4em;
  margin: 0;
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-xs);
}

.new-skill__hint--error { color: var(--pm-color-status-error); }
</style>
