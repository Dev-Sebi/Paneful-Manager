<template>
  <PmDialog
    confirm-text="Delete"
    :loading="loading"
    :model-value="modelValue"
    size="sm"
    :title="title"
    tone="danger"
    @confirm="emit('confirm')"
    @update:model-value="forward"
  >
    {{ message }}
  </PmDialog>
</template>

<script lang="ts" setup>

  import { PmDialog } from '@/components/pm'

  defineProps<{
    modelValue: boolean
    title: string
    message: string
    loading?: boolean
  }>()

  const emit = defineEmits<{
    'update:modelValue': [value: boolean]
    'confirm': []
  }>()

  function forward (value: boolean) {
    // eslint-disable-next-line vue/custom-event-name-casing
    emit('update:modelValue', value)
  }
</script>
