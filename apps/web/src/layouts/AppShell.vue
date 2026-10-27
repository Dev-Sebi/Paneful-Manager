<template>
  <v-app>
    <v-navigation-drawer
      aria-label="Main navigation"
      class="shell__drawer"
      permanent
      :rail="ui.rail"
      :width="220"
    >
      <v-list density="compact" nav>
        <v-list-item
          v-for="section in visibleSections"
          :key="section.key"
          :aria-label="section.label"
          :prepend-icon="section.icon"
          :title="section.label"
          :to="section.to"
        />
      </v-list>

      <template #append>
        <div class="shell__rail-toggle">
          <AhButton
            :ariaLabel="ui.rail ? 'Expand sidebar' : 'Collapse sidebar'"
            :icon="ui.rail ? 'mdi-chevron-right' : 'mdi-chevron-left'"
            variant="ghost"
            @click="ui.toggleRail()"
          />
        </div>
      </template>
    </v-navigation-drawer>

    <v-app-bar class="shell__bar" flat>
      <span class="shell__name">Agent Hub</span>
      <v-spacer />
      <AhStatusBadge :label="connectionLabel" :state="connectionState" />
      <div aria-label="Theme" class="shell__theme" role="group">
        <AhButton
          v-for="option in themeOptions"
          :key="option.value"
          :ariaLabel="`${option.label} theme`"
          :icon="option.icon"
          :pressed="activeTheme === option.value"
          size="sm"
          variant="ghost"
          @click="ui.setTheme(option.value)"
        />
      </div>
    </v-app-bar>

    <v-main class="shell__main">
      <router-view />
    </v-main>

    <v-snackbar
      v-if="current"
      :key="current.id"
      :color="current.color"
      :model-value="true"
      role="status"
      @update:model-value="ui.dismiss(current.id)"
    >
      {{ current.text }}
    </v-snackbar>
  </v-app>
</template>

<script lang="ts" setup>
  import type { Theme } from '@agent-hub/shared'
  import type { AhStatusBadgeState } from '@/components/ah'
  import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import { useTheme } from 'vuetify'
  import { connection } from '@/api/connection'
  import { wsClient } from '@/api/ws'
  import { AhButton, AhStatusBadge } from '@/components/ah'
  import { SECTIONS } from '@/layouts/sections'
  import { useConfigStore } from '@/stores/config'
  import { useSessionsStore } from '@/stores/sessions'
  import { useUiStore } from '@/stores/ui'

  const THEME_OPTIONS: Array<{ value: Theme, label: string, icon: string }> = [
    { value: 'dark', label: 'Dark', icon: 'mdi-weather-night' },
    { value: 'light', label: 'Light', icon: 'mdi-white-balance-sunny' },
    { value: 'system', label: 'System', icon: 'mdi-theme-light-dark' },
  ]

  const router = useRouter()
  const theme = useTheme()
  const ui = useUiStore()
  const config = useConfigStore()
  const sessions = useSessionsStore()

  const themeOptions = THEME_OPTIONS
  const visibleSections = computed(() => SECTIONS.filter(section => !section.flagged || config.agentTeams))
  const current = computed(() => ui.snackbars[0])
  const activeTheme = computed(() => ui.theme ?? config.theme)

  const connectionState = computed<AhStatusBadgeState>(() => {
    if (connection.value === 'online') {
      return 'working'
    }
    return connection.value === 'offline' ? 'error' : 'idle'
  })
  const connectionLabel = computed(() => {
    if (connection.value === 'online') {
      return 'Connected'
    }
    return connection.value === 'offline' ? 'Disconnected' : 'Connecting'
  })

  watch(activeTheme, value => theme.change(value), { immediate: true })

  function onKeydown (event: KeyboardEvent) {
    if (!event.ctrlKey || event.altKey || event.metaKey) {
      return
    }
    if (event.shiftKey && event.key.toLowerCase() === 't') {
      event.preventDefault()
      ui.notify('New tab is not available yet')
      return
    }
    const index = /^[1-5]$/.test(event.key) && !event.shiftKey ? Number(event.key) - 1 : -1
    const section = SECTIONS[index]
    if (section) {
      event.preventDefault()
      void router.push(section.to)
    }
  }

  let unbind: (() => void) | undefined

  onMounted(() => {
    window.addEventListener('keydown', onKeydown)
    unbind = sessions.bind(wsClient)
    void config.ensureLoaded()
    void sessions.load()
    wsClient.connect()
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown)
    unbind?.()
    wsClient.close()
  })
</script>

<style scoped>
.shell__drawer,
.shell__bar {
  border-color: var(--ah-color-border-default);
  background: var(--ah-color-bg-surface);
  color: var(--ah-color-fg-primary);
}

.shell__name {
  padding-inline: var(--ah-space-4);
  font-size: var(--ah-font-size-lg);
  font-weight: var(--ah-font-weight-semibold);
}

.shell__theme {
  display: flex;
  gap: var(--ah-space-1);
  margin-inline: var(--ah-space-3) var(--ah-space-4);
}

.shell__rail-toggle {
  display: flex;
  justify-content: center;
  padding: var(--ah-space-2);
}

.shell__main {
  display: flex;
  flex-direction: column;
  background: var(--ah-color-bg-canvas);
  color: var(--ah-color-fg-primary);
}
</style>
