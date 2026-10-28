<template>
  <section :aria-labelledby="headingId" class="team-board">
    <header class="team-board__header">
      <h2 :id="headingId" class="team-board__title">{{ team.name }}</h2>

      <ul aria-label="Members" class="team-board__members">
        <li v-for="member in team.members" :key="member.name" class="team-board__member" :title="memberTitle(member)">
          <span aria-hidden="true" class="team-board__dot" :style="{ background: memberColorVar(member.name) }" />
          {{ member.name }}
        </li>
      </ul>

      <span class="team-board__updated">Updated {{ relativeTime(team.lastUpdated, now) }}</span>

      <PmButton
        :disabled="team.members.length === 0"
        prepend-icon="mdi-view-grid-plus-outline"
        size="sm"
        variant="secondary"
        @click="emit('open-tab', team)"
      >Open as tab</PmButton>
    </header>

    <v-row class="team-board__columns">
      <v-col v-for="column in columns" :key="column.status" cols="12" :md="column.status === 'unknown' || hasUnknown ? 3 : 4">
        <section :aria-labelledby="`${headingId}-${column.status}`" class="team-board__column">
          <h3 :id="`${headingId}-${column.status}`" class="team-board__column-title">
            {{ column.label }} <span class="team-board__count">{{ column.tasks.length }}</span>
          </h3>

          <ul v-if="column.tasks.length > 0" class="team-board__list">
            <TeamTaskCard
              v-for="task in column.tasks"
              :key="task.id"
              :blockers="openBlockers(task)"
              :task="task"
              :team="team.name"
            />
          </ul>

          <p v-else class="team-board__empty">No tasks</p>
        </section>
      </v-col>
    </v-row>
  </section>
</template>

<script lang="ts" setup>
  import type { Team, TeamMember, TeamTask, TeamTaskStatus } from '@paneful-manager/shared'
  import { computed } from 'vue'
  import { PmButton } from '@/components/pm'
  import { memberColorVar, relativeTime, safeId } from './teamColor'
  import { memberRole } from './teamTab'
  import TeamTaskCard from './TeamTaskCard.vue'

  const props = defineProps<{ team: Team, now: number }>()
  const emit = defineEmits<{ 'open-tab': [team: Team] }>()

  function memberTitle (member: TeamMember): string {
    const role = memberRole(member)
    return member.link?.status === 'linked' ? `${role}, has a pane` : role
  }

  const LABELS: Array<[TeamTaskStatus, string]> = [
    ['pending', 'Pending'],
    ['in_progress', 'In progress'],
    ['completed', 'Completed'],
    ['unknown', 'Unknown'],
  ]

  const headingId = computed(() => `team-${safeId(props.team.name)}`)
  const hasUnknown = computed(() => props.team.tasks.some(task => task.status === 'unknown'))
  const completed = computed(() => new Set(props.team.tasks.filter(task => task.status === 'completed').map(task => task.id)))

  /** Blocker ids that are not completed (unknown ids count as open). */
  function openBlockers (task: TeamTask) {
    return task.blockedBy.filter(id => !completed.value.has(id))
  }

  const columns = computed(() => LABELS.filter(([status]) => status !== 'unknown' || hasUnknown.value).map(([status, label]) => ({
    status,
    label,
    tasks: props.team.tasks.filter(task => task.status === status),
  })))
</script>

<style scoped>
.team-board {
  padding: var(--pm-space-4);
  border: 1px solid var(--pm-color-border-default);
  border-radius: var(--pm-radius-lg);
  background: var(--pm-color-bg-surface);
}

.team-board__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--pm-space-3);
}

.team-board__title {
  margin: 0;
  color: var(--pm-color-fg-primary);
  font-size: var(--pm-font-size-xl);
}

.team-board__members {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: var(--pm-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.team-board__member {
  display: inline-flex;
  align-items: center;
  gap: var(--pm-space-1);
  padding: 0 var(--pm-space-2);
  border-radius: var(--pm-radius-full);
  background: var(--pm-color-bg-elevated);
  color: var(--pm-color-fg-primary);
  font-size: var(--pm-font-size-sm);
}

.team-board__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--pm-radius-full);
}

.team-board__updated {
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-sm);
}

.team-board__columns { margin-top: var(--pm-space-2); }

.team-board__column-title {
  margin: 0 0 var(--pm-space-2);
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-md);
  font-weight: var(--pm-font-weight-medium);
}

.team-board__count { color: var(--pm-color-fg-disabled); }

.team-board__list {
  display: flex;
  flex-direction: column;
  gap: var(--pm-space-2);
  margin: 0;
  padding: 0;
}

.team-board__empty {
  margin: 0;
  color: var(--pm-color-fg-disabled);
  font-size: var(--pm-font-size-sm);
}
</style>
