<template>
  <PmDialog
    cancel-text="Keep editing"
    confirm-text="Discard changes"
    :model-value="modelValue"
    size="sm"
    title="Unsaved changes"
    tone="danger"
    @confirm="emit('discard')"
    @update:model-value="forward"
  >
    The open file has changes that are not saved yet.
  </PmDialog>
</template>

<script lang="ts" setup>

  import { PmDialog } from '@/components/pm'

  defineProps<{ modelValue: boolean }>()

  const emit = defineEmits<{
    'update:modelValue': [value: boolean]
    'discard': []
  }>()

  function forward (value: boolean) {
    // eslint-disable-next-line vue/custom-event-name-casing
    emit('update:modelValue', value)
  }
</script>
