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
      <PmStatusBadge :label="badge.label" size="sm" :state="badge.state" />
    </header>

    <p v-if="store.error" class="teams-view__error" role="alert">{{ store.error }}</p>

    <div v-if="store.warnings.length > 0" class="teams-view__warnings" role="alert">
      <p class="teams-view__warnings-title">Some files were skipped</p>

      <ul>
        <li v-for="(warning, index) in store.warnings" :key="index">{{ warning }}</li>
      </ul>
    </div>

    <TeamTemplatesPanel v-if="store.enabled" />

    <p v-if="store.loaded && store.teams.length === 0" class="teams-view__empty">No team task lists found yet.</p>

    <TeamBoard
      v-for="team in store.teams"
      :key="team.name"
      :now="now"
      :team="team"
      @open-tab="openTab"
    />
  </div>
</template>

<script lang="ts" setup>
  import type { PmStatusBadgeState } from '@/components/pm'
  import type { Team } from '@paneful-manager/shared'
  import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
  import { useRouter } from 'vue-router'
  import { connection } from '@/api/connection'
  import { wsClient } from '@/api/ws'
  import EmptyState from '@/components/EmptyState.vue'
  import { PmStatusBadge } from '@/components/pm'
  import TeamBoard from '@/components/teams/TeamBoard.vue'
  import { buildTeamTab } from '@/components/teams/teamTab'
  import TeamTemplatesPanel from '@/components/teams/TeamTemplatesPanel.vue'
  import { useLayoutSizesStore } from '@/stores/layoutSizes'
  import { useSessionsStore } from '@/stores/sessions'
  import { useTabsStore } from '@/stores/tabs'
  import { useTeamsStore } from '@/stores/teams'
  import { useUiStore } from '@/stores/ui'

  /** Relative times are re-rendered this often. */
  const CLOCK_TICK_MS = 30_000

  const router = useRouter()
  const store = useTeamsStore()
  const sessions = useSessionsStore()
  const tabs = useTabsStore()
  const layoutSizes = useLayoutSizesStore()
  const ui = useUiStore()
  const now = ref(Date.now())

  const badge = computed<{ label: string, state: PmStatusBadgeState }>(() => {
    if (store.error) {
      return { label: 'Refresh failed', state: 'error' }
    }
    return connection.value === 'connected' ? { label: 'Live', state: 'idle' } : { label: 'Reconnecting', state: 'waiting' }
  })
  /** Opens (or rebuilds) the team's tab with one pane per member and switches to it. */
  function openTab (team: Team) {
    const result = buildTeamTab(team, id => sessions.byId.has(id))
    if (!result) {
      ui.notify('This team has no members yet')
      return
    }
    layoutSizes.reset(result.tab.id)
    tabs.upsert(result.tab)
    if (result.dropped.length > 0) {
      ui.notify(`Tab is full, not shown: ${result.dropped.join(', ')}`)
    }
    void router.push(`/workspaces/${result.tab.id}`)
  }

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
  gap: var(--pm-space-4);
  padding: var(--pm-space-4);
}

.teams-view__bar {
  display: flex;
  align-items: center;
  gap: var(--pm-space-3);
}

.teams-view__title {
  margin: 0;
  color: var(--pm-color-fg-primary);
  font-size: var(--pm-font-size-2xl);
}

.teams-view__error { margin: 0; color: var(--pm-color-status-error); }

.teams-view__warnings {
  padding: var(--pm-space-3);
  border: 1px solid var(--pm-color-status-waiting);
  border-radius: var(--pm-radius-md);
  color: var(--pm-color-fg-primary);
  font-size: var(--pm-font-size-sm);
}

.teams-view__warnings-title { margin: 0 0 var(--pm-space-1); font-weight: var(--pm-font-weight-medium); }
.teams-view__warnings ul { margin: 0; padding-left: var(--pm-space-4); }
.teams-view__empty { margin: 0; color: var(--pm-color-fg-muted); }
</style>
