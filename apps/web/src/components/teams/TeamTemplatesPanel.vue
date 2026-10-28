<template>
  <section aria-label="Team templates" class="team-templates">
    <header class="team-templates__toolbar">
      <h2 class="team-templates__title">Templates</h2>
      <span class="team-templates__badge">Experimental</span>
      <span class="team-templates__spacer" />
      <PmButton prepend-icon="mdi-plus" variant="primary" @click="openCreate">New template</PmButton>
    </header>

    <p v-if="store.error" class="team-templates__error" role="alert">Could not load team templates: {{ store.error }}</p>

    <p v-else-if="store.templates.length === 0 && !store.loading" class="team-templates__empty">
      No team templates yet. A template names the lead and its teammates; launching it starts the lead, which spawns the teammates.
    </p>

    <ul v-else class="team-templates__list">
      <li v-for="template in store.templates" :key="template.name" class="team-templates__item">
        <div class="team-templates__row">
          <div class="team-templates__info">
            <span class="team-templates__name">{{ template.name }}</span>
            <span class="team-templates__meta">{{ teammateSummary(template) }}</span>
            <span v-if="template.description" class="team-templates__description">{{ template.description }}</span>
          </div>

          <PmButton
            :ariaLabel="`Launch ${template.name}`"
            :loading="launching === template.name"
            prepend-icon="mdi-play"
            size="sm"
            variant="primary"
            @click="launch(template.name)"
          >Launch</PmButton>

          <PmButton
            :ariaLabel="`Edit ${template.name}`"
            icon="mdi-pencil-outline"
            size="sm"
            variant="ghost"
            @click="openEdit(template)"
          />

          <PmButton
            :ariaLabel="`Delete ${template.name}`"
            icon="mdi-delete-outline"
            size="sm"
            variant="ghost"
            @click="deleting = template"
          />
        </div>

        <ul v-if="store.launchesOf(template.name).length > 0" aria-label="Running launches" class="team-templates__launches">
          <li v-for="item in store.launchesOf(template.name)" :key="item.sessionId" class="team-templates__launch">
            <span class="team-templates__team">{{ item.team }}</span>

            <a
              v-if="teamExists(item.team)"
              class="team-templates__link"
              :href="`#team-${safeId(item.team)}`"
              @click.prevent="showBoard(item.team)"
            >View board</a>

            <span v-else class="team-templates__waiting">Waiting for the team to appear</span>

            <PmButton :ariaLabel="`Open lead of ${item.team}`" size="sm" variant="ghost" @click="openTab(item)">Open lead</PmButton>
          </li>
        </ul>
      </li>
    </ul>

    <TeamTemplateDialog v-model="editOpen" :template="editing" @saved="ui.notify('Team template saved', 'success')" />

    <PmDialog
      confirm-text="Delete"
      initial-focus="[data-pm-cancel]"
      :loading="removing"
      :model-value="deleting !== undefined"
      :title="`Delete team template ${deleting?.name ?? ''}?`"
      tone="danger"
      @confirm="confirmDelete"
      @update:model-value="deleting = undefined"
    >
      <p>The file {{ deleting?.name }}.yaml is removed. Running sessions stay open.</p>
    </PmDialog>
  </section>
</template>

<script lang="ts" setup>
  import type { TeamLaunch, TeamTemplate } from '@paneful-manager/shared'
  import { ref } from 'vue'
  import { useRouter } from 'vue-router'
  import { PmButton, PmDialog } from '@/components/pm'
  import { useTabsStore } from '@/stores/tabs'
  import { useTeamsStore } from '@/stores/teams'
  import { useTeamTemplatesStore } from '@/stores/teamTemplates'
  import { useUiStore } from '@/stores/ui'
  import { safeId } from './teamColor'
  import TeamTemplateDialog from './TeamTemplateDialog.vue'

  const store = useTeamTemplatesStore()
  const teams = useTeamsStore()
  const tabs = useTabsStore()
  const ui = useUiStore()
  const router = useRouter()

  const editOpen = ref(false)
  const editing = ref<TeamTemplate>()
  const launching = ref<string>()
  const deleting = ref<TeamTemplate>()
  const removing = ref(false)

  void store.load()

  function teammateSummary (template: TeamTemplate) {
    const names = template.teammates.map(teammate => teammate.name).join(', ')
    return `${template.teammates.length} teammate${template.teammates.length === 1 ? '' : 's'}: ${names}`
  }

  function teamExists (team: string) {
    return teams.teams.some(item => item.name === team)
  }

  function showBoard (team: string) {
    document.querySelector(`#team-${safeId(team)}`)?.scrollIntoView({ block: 'start' })
  }

  function openCreate () {
    editing.value = undefined
    editOpen.value = true
  }

  function openEdit (template: TeamTemplate) {
    editing.value = template
    editOpen.value = true
  }

  /** Activates the tab that shows the lead session, or opens a new one. */
  function openTab (launch: TeamLaunch) {
    const existing = tabs.tabs.find(tab => tab.panes.some(pane => pane.sessionId === launch.sessionId))
    if (existing) {
      tabs.activate(existing.id)
      void router.push(`/workspaces/${existing.id}`)
      return
    }
    const id = `tab-${launch.sessionId}`
    tabs.add({ id, title: launch.template, layout: { kind: 'single' }, panes: [{ sessionId: launch.sessionId }] })
    void router.push(`/workspaces/${id}`)
  }

  async function launch (name: string) {
    launching.value = name
    try {
      const launched = await store.launch(name)
      tabs.add(launched.tab)
      if (launched.untestedVersion) {
        ui.notify(`Claude Code ${launched.claudeVersion} is newer than the last tested version; agent teams may behave differently`, 'warning')
      }
      void router.push(`/workspaces/${launched.tab.id}`)
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : 'Could not launch the team', 'error')
    } finally {
      launching.value = undefined
    }
  }

  async function confirmDelete () {
    const target = deleting.value
    if (!target) {
      return
    }
    removing.value = true
    try {
      await store.remove(target.name)
      deleting.value = undefined
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : 'Could not delete the team template', 'error')
    } finally {
      removing.value = false
    }
  }
</script>

<style scoped>
.team-templates {
  display: flex;
  flex-direction: column;
  gap: var(--pm-space-3);
}

.team-templates__toolbar {
  display: flex;
  align-items: center;
  gap: var(--pm-space-2);
}

.team-templates__title {
  margin: 0;
  color: var(--pm-color-fg-primary);
  font-size: var(--pm-font-size-lg);
  font-weight: var(--pm-font-weight-semibold);
}

.team-templates__spacer { flex: 1; }

.team-templates__badge {
  padding: 0 var(--pm-space-2);
  border: 1px solid var(--pm-color-status-waiting);
  border-radius: var(--pm-radius-full);
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-xs);
}

.team-templates__list,
.team-templates__launches {
  display: flex;
  flex-direction: column;
  gap: var(--pm-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.team-templates__item {
  display: flex;
  flex-direction: column;
  gap: var(--pm-space-2);
  padding: var(--pm-space-2) var(--pm-space-3);
  border: 1px solid var(--pm-color-border-default);
  border-radius: var(--pm-radius-md);
  background: var(--pm-color-bg-surface);
}

.team-templates__row {
  display: flex;
  align-items: center;
  gap: var(--pm-space-2);
}

.team-templates__info {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--pm-space-2);
  min-width: 0;
}

.team-templates__name {
  color: var(--pm-color-fg-primary);
  font-weight: var(--pm-font-weight-medium);
}

.team-templates__meta,
.team-templates__waiting {
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-sm);
}

.team-templates__description {
  flex-basis: 100%;
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-sm);
}

.team-templates__launch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--pm-space-3);
  padding-top: var(--pm-space-2);
  border-top: 1px solid var(--pm-color-border-default);
  font-size: var(--pm-font-size-sm);
}

.team-templates__team {
  color: var(--pm-color-fg-primary);
  font-family: var(--pm-font-family-mono);
}

.team-templates__link { color: var(--pm-color-accent-default); }

.team-templates__empty { margin: 0; color: var(--pm-color-fg-muted); font-size: var(--pm-font-size-sm); }
.team-templates__error { margin: 0; color: var(--pm-color-status-error); font-size: var(--pm-font-size-sm); }
</style>
