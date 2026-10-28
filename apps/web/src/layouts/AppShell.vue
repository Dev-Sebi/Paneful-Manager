<template>
  <v-app>
    <a class="shell__skip" href="#main-content" @click.prevent="focusMain">Skip to content</a>

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
          <PmButton
            :ariaLabel="ui.rail ? 'Expand sidebar' : 'Collapse sidebar'"
            :icon="ui.rail ? 'mdi-chevron-right' : 'mdi-chevron-left'"
            variant="ghost"
            @click="ui.toggleRail()"
          />
        </div>
      </template>
    </v-navigation-drawer>

    <v-app-bar class="shell__bar" flat>
      <span class="shell__name">Paneful Manager</span>
      <v-spacer />
      <PmStatusBadge :label="connectionLabel" :state="connectionState" />

      <div aria-label="Theme" class="shell__theme" role="group">
        <PmButton
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

    <v-main id="main-content" ref="mainRef" class="shell__main" tabindex="-1">
      <EmptyState
        v-if="loginRequired"
        icon="mdi-key-outline"
        :message="loginMessage"
      />

      <router-view v-else />
    </v-main>

    <v-snackbar
      v-if="current"
      :key="current.id"
      :color="current.color"
      :model-value="true"
      role="status"
      :timeout="current.persistent ? -1 : 5000"
      @update:model-value="ui.dismiss(current.id)"
    >
      {{ current.text }}
    </v-snackbar>
  </v-app>
</template>

<script lang="ts" setup>
  import type { ConnectionState } from '@/api/connection'
  import type { PmStatusBadgeState } from '@/components/pm'
  import { BIND_HOST, type Theme } from '@paneful-manager/shared'
  import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import { useTheme } from 'vuetify'
  import { loginCodeRejected, loginRequired, untrustedHost } from '@/api/access'
  import { connection } from '@/api/connection'
  import { wsClient } from '@/api/ws'
  import { PmButton, PmStatusBadge } from '@/components/pm'
  import EmptyState from '@/components/EmptyState.vue'
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
  const loginMessage = computed(() => {
    if (untrustedHost.value) {
      return `Open Paneful Manager at http://${BIND_HOST}:${location.port}/ instead: on this host name another local user's server can answer. Then open a login URL.`
    }
    const hint = 'Print a new one with install.sh --login-url (or pnpm login-url in a checkout); it works once and expires after 10 minutes.'
    return loginCodeRejected.value ? `This login URL was already used or has expired. ${hint}` : `Open a login URL in this browser to log in. ${hint}`
  })

  const CONNECTION_BADGES: Record<ConnectionState, { state: PmStatusBadgeState, label: string }> = {
    connected: { state: 'idle', label: 'Connected' },
    connecting: { state: 'working', label: 'Connecting' },
    disconnected: { state: 'error', label: 'Disconnected' },
  }

  const connectionState = computed(() => CONNECTION_BADGES[connection.value].state)
  const connectionLabel = computed(() => CONNECTION_BADGES[connection.value].label)

  const mainRef = ref<{ $el: HTMLElement }>()

  function focusMain () {
    mainRef.value?.$el.focus()
  }

  function isEditable (target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, [contenteditable], .xterm') !== null)
  }

  watch(activeTheme, value => theme.change(value), { immediate: true })
  // Without a login every reconnect would only be refused again.
  watch(loginRequired, required => {
    if (required) {
      wsClient.close()
    }
  })

  function onKeydown (event: KeyboardEvent) {
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyN') {
      event.preventDefault()
      ui.notify('New tab is not available yet')
      return
    }
    if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || isEditable(event.target)) {
      return
    }
    const index = /^[1-5]$/.test(event.key) ? Number(event.key) - 1 : -1
    const section = visibleSections.value[index]
    if (section) {
      event.preventDefault()
      void router.push(section.to)
    }
  }

  let unbind: (() => void) | undefined
  let offFatal: (() => void) | undefined
  let offOpen: (() => void) | undefined

  onMounted(() => {
    window.addEventListener('keydown', onKeydown)
    unbind = sessions.bind(wsClient)
    offFatal = wsClient.onFatal(() => ui.notify('Protocol mismatch, reload the page', 'error', true))
    if (loginRequired.value) {
      return
    }
    // State events missed while disconnected are not replayed, so resync the list on every (re)connect.
    offOpen = wsClient.onOpen(() => void sessions.load())
    void config.ensureLoaded()
    void sessions.load()
    wsClient.connect()
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown)
    unbind?.()
    offFatal?.()
    offOpen?.()
    wsClient.close()
  })
</script>

<style scoped>
.shell__drawer,
.shell__bar {
  border-color: var(--pm-color-border-default);
  background: var(--pm-color-bg-surface);
  color: var(--pm-color-fg-primary);
}

.shell__skip {
  position: absolute;
  z-index: var(--pm-z-toast);
  padding: var(--pm-space-2) var(--pm-space-4);
  border-radius: var(--pm-radius-md);
  background: var(--pm-color-accent-default);
  color: var(--pm-color-fg-on-accent);
  inset-block-start: var(--pm-space-2);
  inset-inline-start: var(--pm-space-2);
  transform: translateY(-200%);
}

.shell__skip:focus { transform: none; }

.shell__name {
  padding-inline: var(--pm-space-4);
  font-size: var(--pm-font-size-lg);
  font-weight: var(--pm-font-weight-semibold);
}

.shell__theme {
  display: flex;
  gap: var(--pm-space-1);
  margin-inline: var(--pm-space-3) var(--pm-space-4);
}

.shell__rail-toggle {
  display: flex;
  justify-content: center;
  padding: var(--pm-space-2);
}

.shell__main {
  display: flex;
  flex-direction: column;
  background: var(--pm-color-bg-canvas);
  color: var(--pm-color-fg-primary);
}
</style>
