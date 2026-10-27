<template>
  <section :aria-labelledby="headingId" class="team-board">
    <header class="team-board__header">
      <h2 :id="headingId" class="team-board__title">{{ team.name }}</h2>

      <ul aria-label="Members" class="team-board__members">
        <li v-for="member in team.members" :key="member.name" class="team-board__member" :title="member.agentType">
          <span aria-hidden="true" class="team-board__dot" :style="{ background: memberColorVar(member.name) }" />
          {{ member.name }}
        </li>
      </ul>

      <span class="team-board__updated">Updated {{ relativeTime(team.lastUpdated, now) }}</span>
    </header>

    <v-row class="team-board__columns">
      <v-col v-for="column in columns" :key="column.status" cols="12" md="4">
        <section :aria-labelledby="`${headingId}-${column.status}`" class="team-board__column">
          <h3 :id="`${headingId}-${column.status}`" class="team-board__column-title">
            {{ column.label }} <span class="team-board__count">{{ column.tasks.length }}</span>
          </h3>

          <ul v-if="column.tasks.length > 0" class="team-board__list">
            <TeamTaskCard v-for="task in column.tasks" :key="task.id" :task="task" :team="team.name" />
          </ul>

          <p v-else class="team-board__empty">No tasks</p>
        </section>
      </v-col>
    </v-row>
  </section>
</template>

<script lang="ts" setup>
  import type { Team, TeamTaskStatus } from '@agent-hub/shared'
  import { computed } from 'vue'
  import { memberColorVar, relativeTime } from './teamColor'
  import TeamTaskCard from './TeamTaskCard.vue'

  const props = defineProps<{ team: Team, now: number }>()

  const LABELS: Array<[TeamTaskStatus, string]> = [
    ['pending', 'Pending'],
    ['in_progress', 'In progress'],
    ['completed', 'Completed'],
  ]

  const headingId = computed(() => `team-${props.team.name}`)
  const columns = computed(() => LABELS.map(([status, label]) => ({
    status,
    label,
    tasks: props.team.tasks.filter(task => task.status === status),
  })))
</script>

<style scoped>
.team-board {
  padding: var(--ah-space-4);
  border: 1px solid var(--ah-color-border-default);
  border-radius: var(--ah-radius-lg);
  background: var(--ah-color-bg-surface);
}

.team-board__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ah-space-3);
}

.team-board__title {
  margin: 0;
  color: var(--ah-color-fg-primary);
  font-size: var(--ah-font-size-xl);
}

.team-board__members {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: var(--ah-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.team-board__member {
  display: inline-flex;
  align-items: center;
  gap: var(--ah-space-1);
  padding: 0 var(--ah-space-2);
  border-radius: var(--ah-radius-full);
  background: var(--ah-color-bg-elevated);
  color: var(--ah-color-fg-primary);
  font-size: var(--ah-font-size-sm);
}

.team-board__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--ah-radius-full);
}

.team-board__updated {
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-sm);
}

.team-board__columns { margin-top: var(--ah-space-2); }

.team-board__column-title {
  margin: 0 0 var(--ah-space-2);
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-md);
  font-weight: var(--ah-font-weight-medium);
}

.team-board__count { color: var(--ah-color-fg-disabled); }

.team-board__list {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-2);
  margin: 0;
  padding: 0;
}

.team-board__empty {
  margin: 0;
  color: var(--ah-color-fg-disabled);
  font-size: var(--ah-font-size-sm);
}
</style>
