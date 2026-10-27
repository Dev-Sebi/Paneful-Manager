<template>
  <EmptyState
    action-label="Open settings"
    icon="mdi-account-group-outline"
    message="Agent teams are experimental and not available yet"
    @action="router.push('/settings')"
  />
</template>

<script lang="ts" setup>
  import { useRouter } from 'vue-router'
  import EmptyState from '@/components/EmptyState.vue'

  const router = useRouter()
</script>
