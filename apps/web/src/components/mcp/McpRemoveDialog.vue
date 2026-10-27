<template>
  <AhDialog
    v-model="open"
    confirm-text="Remove"
    :loading="removing"
    size="sm"
    title="Remove server"
    tone="danger"
    @after-leave="error = undefined"
    @confirm="confirm"
  >
    <div class="mcp-remove">
      <p>Remove <strong>{{ entry.name }}</strong> from the {{ scopeLabel(entry.scope) }}?</p>
      <p v-if="entry.config.transport !== 'stdio'">Stored OAuth tokens for this server are dropped; you have to sign in again after adding it back.</p>
      <p v-if="error" class="mcp-remove__error" role="alert">{{ error }}</p>
    </div>
  </AhDialog>
</template>

<script lang="ts" setup>
  import type { McpServerEntryMasked } from '@agent-hub/shared'
  import { ref } from 'vue'
  import { AhDialog } from '@/components/ah'
  import { scopeLabel, useMcpStore } from '@/stores/mcp'

  const open = defineModel<boolean>({ required: true })
  const props = defineProps<{ entry: McpServerEntryMasked }>()

  const emit = defineEmits<{
    removed: []
  }>()

  const mcp = useMcpStore()
  const removing = ref(false)
  const error = ref<string>()

  async function confirm () {
    removing.value = true
    error.value = undefined
    try {
      await mcp.remove({ name: props.entry.name, scope: props.entry.scope })
      open.value = false
      emit('removed')
    } catch (error_) {
      error.value = error_ instanceof Error ? error_.message : 'Could not remove the server'
    } finally {
      removing.value = false
    }
  }
</script>

<style scoped>
.mcp-remove p { margin: 0 0 var(--ah-space-2); }
.mcp-remove__error { color: var(--ah-color-danger-default); }
</style>
