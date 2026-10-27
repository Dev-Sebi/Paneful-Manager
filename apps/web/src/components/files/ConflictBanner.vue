<template>
  <section aria-live="assertive" class="conflict-banner animate__animated animate__fadeInUp" role="alert">
    <v-icon aria-hidden="true" class="conflict-banner__icon" icon="mdi-alert-outline" />
    <p class="conflict-banner__text">{{ text }}</p>

    <div class="conflict-banner__actions">
      <AhButton :disabled="busy" size="sm" @click="emit('reload')">Reload from disk</AhButton>
      <AhButton :disabled="busy" size="sm" variant="danger" @click="confirming = true">Overwrite</AhButton>
    </div>

    <AhDialog
      v-model="confirming"
      confirm-text="Overwrite"
      title="Overwrite the file on disk?"
      tone="danger"
      @confirm="onConfirm"
    >
      Your version replaces the one on disk. The other changes are lost.
    </AhDialog>
  </section>
</template>

<script lang="ts" setup>
  import { computed, ref } from 'vue'
  import { AhButton, AhDialog } from '@/components/ah'

  const props = defineProps<{
    kind: 'conflict' | 'changed' | 'removed'
    busy?: boolean
  }>()

  const emit = defineEmits<{
    reload: []
    overwrite: []
  }>()

  const confirming = ref(false)

  const text = computed(() => {
    if (props.kind === 'conflict') {
      return 'Not saved: the file changed on disk after you opened it.'
    }
    return props.kind === 'removed'
      ? 'This file was deleted on disk. Your edits are kept in the editor.'
      : 'This file changed on disk. Your edits are kept in the editor.'
  })

  function onConfirm () {
    confirming.value = false
    emit('overwrite')
  }
</script>

<style scoped>
.conflict-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ah-space-3);
  padding: var(--ah-space-2) var(--ah-space-3);
  border: 1px solid var(--ah-color-status-waiting);
  border-radius: var(--ah-radius-md);
  background: var(--ah-color-bg-elevated);
}

.conflict-banner__icon { color: var(--ah-color-status-waiting); }

.conflict-banner__text {
  flex: 1;
  min-width: 200px;
  margin: 0;
  font-size: var(--ah-font-size-sm);
}

.conflict-banner__actions {
  display: flex;
  gap: var(--ah-space-2);
}
</style>
