<template>
  <EmptyState
    action-label="Open settings"
    icon="mdi-connection"
    message="MCP server management is coming soon"
    @action="router.push('/settings')"
  />
</template>

<script lang="ts" setup>
  import { useRouter } from 'vue-router'
  import EmptyState from '@/components/EmptyState.vue'

  const router = useRouter()
</script>
