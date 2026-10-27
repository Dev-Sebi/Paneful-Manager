import type { AppTab, TeamLaunch, TeamTemplate } from '@agent-hub/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/api/client'
import { useSessionsStore } from './sessions'

export interface LaunchedTeam {
  launch: TeamLaunch
  tab: AppTab
  untestedVersion: boolean
  claudeVersion: string
}

/** Team templates (experimental); only loaded while `experimental.agentTeams` is on. */
export const useTeamTemplatesStore = defineStore('teamTemplates', () => {
  const templates = ref<TeamTemplate[]>([])
  const launches = ref<TeamLaunch[]>([])
  const loading = ref(false)
  const error = ref<string>()

  async function load () {
    loading.value = true
    try {
      const response = await api.listTeamTemplates()
      templates.value = response.templates
      launches.value = response.launches
      error.value = undefined
    } catch (error_) {
      error.value = error_ instanceof Error ? error_.message : 'Could not load team templates'
    } finally {
      loading.value = false
    }
  }

  /** Creates a template, or replaces the one with the same name when `existing` is set. */
  async function save (template: TeamTemplate, existing: boolean) {
    const { template: saved } = await (existing
      ? api.updateTeamTemplate(template.name, { template })
      : api.createTeamTemplate({ template }))
    const index = templates.value.findIndex(item => item.name === saved.name)
    if (index === -1) {
      templates.value = [...templates.value, saved].toSorted((a, b) => a.name.localeCompare(b.name))
    } else {
      templates.value[index] = saved
    }
    return saved
  }

  async function remove (name: string) {
    await api.deleteTeamTemplate(name)
    templates.value = templates.value.filter(item => item.name !== name)
    launches.value = launches.value.filter(launch => launch.template !== name)
  }

  /** Starts the lead session and returns a single-pane tab for it, ready for the tabs store. */
  async function launch (name: string): Promise<LaunchedTeam> {
    const response = await api.launchTeamTemplate(name)
    launches.value = [response.launch, ...launches.value]
    await useSessionsStore().load()
    const { sessionId } = response.launch
    return {
      launch: response.launch,
      tab: { id: `tab-${sessionId}`, title: name, layout: { kind: 'single' }, panes: [{ sessionId }] },
      untestedVersion: response.untestedVersion,
      claudeVersion: response.claudeVersion,
    }
  }

  function launchesOf (name: string) {
    return launches.value.filter(launch => launch.template === name)
  }

  return { templates, launches, loading, error, load, save, remove, launch, launchesOf }
})
