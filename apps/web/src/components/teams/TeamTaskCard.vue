<template>
  <li class="task-card" :class="{ 'task-card--blocked': task.blocked }" :data-testid="`task-${task.id}`">
    <div class="task-card__head">
      <span class="task-card__id">#{{ task.id }}</span>
      <span class="task-card__subject">{{ task.subject }}</span>
    </div>

    <p v-if="task.status === 'in_progress' && task.activeForm" class="task-card__active">{{ task.activeForm }}</p>

    <div class="task-card__meta">
      <span v-if="task.owner" class="task-card__owner">
        <span aria-hidden="true" class="task-card__dot" :style="{ background: memberColorVar(task.owner) }" />
        {{ task.owner }}
      </span>

      <span v-if="task.blocked" class="task-card__blocked">Blocked by {{ blockerText }}</span>
    </div>

    <template v-if="task.description">
      <button
        :aria-controls="descriptionId"
        :aria-expanded="open"
        class="task-card__toggle"
        type="button"
        @click="open = !open"
      >
        {{ open ? 'Hide description' : 'Show description' }}
      </button>

      <p v-show="open" :id="descriptionId" class="task-card__description">{{ task.description }}</p>
    </template>
  </li>
</template>

<script lang="ts" setup>
  import type { TeamTask } from '@agent-hub/shared'
  import { computed, ref } from 'vue'
  import { memberColorVar, safeId } from './teamColor'

  const props = defineProps<{ task: TeamTask, team: string, blockers: string[] }>()

  const open = ref(false)
  const descriptionId = computed(() => `task-desc-${safeId(props.team)}-${safeId(props.task.id)}`)
  const blockerText = computed(() => props.blockers.map(id => `#${id}`).join(', '))
</script>

<style scoped>
.task-card {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-2);
  padding: var(--ah-space-3);
  border: 1px solid var(--ah-color-border-default);
  border-radius: var(--ah-radius-md);
  background: var(--ah-color-bg-elevated);
  list-style: none;
}

.task-card--blocked { border-color: var(--ah-color-status-waiting); }

.task-card__head { display: flex; gap: var(--ah-space-2); }

.task-card__id {
  flex: none;
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-sm);
}

.task-card__subject {
  color: var(--ah-color-fg-primary);
  font-size: var(--ah-font-size-md);
  font-weight: var(--ah-font-weight-medium);
  overflow-wrap: anywhere;
}

.task-card__active {
  margin: 0;
  color: var(--ah-color-status-working);
  font-size: var(--ah-font-size-sm);
}

.task-card__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ah-space-2);
  font-size: var(--ah-font-size-sm);
}

.task-card__owner {
  display: inline-flex;
  align-items: center;
  gap: var(--ah-space-1);
  padding: 0 var(--ah-space-2);
  border-radius: var(--ah-radius-full);
  background: var(--ah-color-bg-hover);
  color: var(--ah-color-fg-primary);
}

.task-card__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--ah-radius-full);
}

.task-card__blocked {
  padding: 0 var(--ah-space-2);
  border: 1px solid var(--ah-color-status-waiting);
  border-radius: var(--ah-radius-full);
  color: var(--ah-color-status-waiting);
}

.task-card__toggle {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ah-color-accent-default);
  font-size: var(--ah-font-size-sm);
  cursor: pointer;
}

.task-card__toggle:focus-visible {
  outline: 2px solid var(--ah-color-border-focus);
  outline-offset: 2px;
}

.task-card__description {
  margin: 0;
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-sm);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
