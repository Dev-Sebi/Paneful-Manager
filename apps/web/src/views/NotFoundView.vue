<template>
  <EmptyState
    action-label="Go to Workspaces"
    icon="mdi-map-marker-question-outline"
    message="Page not found"
    @action="router.push('/workspaces')"
  />
</template>

<script lang="ts" setup>
  import { useRouter } from 'vue-router'
  import EmptyState from '@/components/EmptyState.vue'

  const router = useRouter()
</script>
