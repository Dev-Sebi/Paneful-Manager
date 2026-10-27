<template>
  <AhDialog
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
  </AhDialog>
</template>

<script lang="ts" setup>

  import type { CreateFileRequest, Scope } from '@agent-hub/shared'
  import { SkillNameSchema } from '@agent-hub/shared'
  import { computed, ref, useId, watch } from 'vue'
  import { AhDialog } from '@/components/ah'
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
  gap: var(--ah-space-1);
}

.new-skill__label {
  margin-top: var(--ah-space-2);
  font-size: var(--ah-font-size-sm);
  font-weight: var(--ah-font-weight-medium);
}

.new-skill__field {
  height: 28px;
  padding: 0 var(--ah-space-2);
  border: 1px solid var(--ah-color-border-default);
  border-radius: var(--ah-radius-md);
  background: var(--ah-color-bg-canvas);
  color: var(--ah-color-fg-primary);
  font: inherit;
}

.new-skill__field:focus-visible {
  outline: 2px solid var(--ah-color-border-focus);
  outline-offset: 1px;
}

.new-skill__field[aria-invalid="true"] { border-color: var(--ah-color-status-error); }

.new-skill__hint {
  min-height: 1.4em;
  margin: 0;
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-xs);
}

.new-skill__hint--error { color: var(--ah-color-status-error); }
</style>
