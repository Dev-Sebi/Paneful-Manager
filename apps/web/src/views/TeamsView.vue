<template>
  <EmptyState
    v-if="store.loaded && !store.enabled"
    action-label="Open settings"
    icon="mdi-account-group-outline"
    message="Agent teams are turned off. Enable experimental.agentTeams in the settings to see team task boards."
    @action="router.push('/settings')"
  />

  <div v-else class="teams-view">
    <header class="teams-view__bar">
      <h1 class="teams-view__title">Teams</h1>
      <AhStatusBadge :label="store.error ? 'Refresh failed' : 'Live'" size="sm" :state="store.error ? 'error' : 'idle'" />
    </header>

    <p v-if="store.error" class="teams-view__error" role="alert">{{ store.error }}</p>

    <div v-if="store.warnings.length > 0" class="teams-view__warnings" role="alert">
      <p class="teams-view__warnings-title">Some files were skipped</p>
      <ul>
        <li v-for="warning in store.warnings" :key="warning">{{ warning }}</li>
      </ul>
    </div>

    <p v-if="store.loaded && store.teams.length === 0" class="teams-view__empty">No team task lists found yet.</p>

    <TeamBoard v-for="team in store.teams" :key="team.name" :now="now" :team="team" />
  </div>
</template>

<script lang="ts" setup>
  import { onBeforeUnmount, onMounted, ref } from 'vue'
  import { useRouter } from 'vue-router'
  import { wsClient } from '@/api/ws'
  import { AhStatusBadge } from '@/components/ah'
  import EmptyState from '@/components/EmptyState.vue'
  import TeamBoard from '@/components/teams/TeamBoard.vue'
  import { useTeamsStore } from '@/stores/teams'

  /** Relative times are re-rendered this often. */
  const CLOCK_TICK_MS = 30_000

  const router = useRouter()
  const store = useTeamsStore()
  const now = ref(Date.now())
  let unbind: (() => void) | undefined
  let clock: ReturnType<typeof setInterval> | undefined

  onMounted(() => {
    unbind = store.bind(wsClient)
    clock = setInterval(() => {
      now.value = Date.now()
    }, CLOCK_TICK_MS)
    void store.load()
  })

  onBeforeUnmount(() => {
    unbind?.()
    clearInterval(clock)
  })
</script>

<style scoped>
.teams-view {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-4);
  padding: var(--ah-space-4);
}

.teams-view__bar {
  display: flex;
  align-items: center;
  gap: var(--ah-space-3);
}

.teams-view__title {
  margin: 0;
  color: var(--ah-color-fg-primary);
  font-size: var(--ah-font-size-2xl);
}

.teams-view__error { margin: 0; color: var(--ah-color-status-error); }

.teams-view__warnings {
  padding: var(--ah-space-3);
  border: 1px solid var(--ah-color-status-waiting);
  border-radius: var(--ah-radius-md);
  color: var(--ah-color-fg-primary);
  font-size: var(--ah-font-size-sm);
}

.teams-view__warnings-title { margin: 0 0 var(--ah-space-1); font-weight: var(--ah-font-weight-medium); }
.teams-view__warnings ul { margin: 0; padding-left: var(--ah-space-4); }
.teams-view__empty { margin: 0; color: var(--ah-color-fg-muted); }
</style>
