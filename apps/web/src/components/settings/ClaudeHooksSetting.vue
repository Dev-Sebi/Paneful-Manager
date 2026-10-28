<template>
  <section aria-labelledby="claude-hooks-title" class="claude-hooks">
    <h2 id="claude-hooks-title" class="claude-hooks__title">Claude Code session status</h2>

    <v-switch
      color="primary"
      density="compact"
      :disabled="busy || status === undefined"
      hide-details
      label="Install status hooks in the Claude Code settings"
      :loading="busy"
      :model-value="checked"
      @update:model-value="toggle"
    />

    <p class="claude-hooks__hint">
      Agent Hub adds its own entries to
      <code>{{ status?.settingsPath ?? 'settings.json' }}</code>
      so sessions report working, waiting and idle. Other entries are kept; turning this off removes only Agent Hub's entries.
    </p>

    <p v-if="loadError" class="claude-hooks__error" role="alert">
      {{ loadError }}
      <AhButton size="sm" @click="load">Retry</AhButton>
    </p>

    <p v-if="changeError" class="claude-hooks__error" role="alert">{{ changeError }}</p>

    <ul v-if="problems.length > 0" class="claude-hooks__problems" role="status">
      <li v-for="problem in problems" :key="`${problem.code}:${problem.source}`">
        {{ problem.message }} <span class="claude-hooks__source">({{ problem.source }})</span>
      </li>
    </ul>
  </section>
</template>

<script lang="ts" setup>
  import type { HookStatus } from '@agent-hub/shared'
  import { computed, onMounted, ref } from 'vue'
  import { api } from '@/api/client'
  import AhButton from '@/components/ah/AhButton.vue'

  const status = ref<HookStatus>()
  /** Follows the click while a change runs, then snaps back to the server's state (also after a failure). */
  const checked = ref(false)
  const busy = ref(false)
  const loadError = ref<string>()
  const changeError = ref<string>()

  /** `not_installed` is what the switch already shows; everything else needs the user's attention. */
  const problems = computed(() => (status.value?.reasons ?? []).filter(reason => reason.code !== 'not_installed'))

  function messageOf (error: unknown, fallback: string): string {
    return error instanceof Error && error.message !== '' ? error.message : fallback
  }

  async function load () {
    loadError.value = undefined
    try {
      status.value = await api.hooks.status()
      checked.value = status.value.installed
    } catch (error) {
      loadError.value = `Could not read the hook status: ${messageOf(error, 'unknown error')}`
    }
  }

  async function toggle (value: boolean | null) {
    if (busy.value) {
      return
    }
    busy.value = true
    checked.value = value === true
    changeError.value = undefined
    try {
      const result = value === true ? await api.hooks.install() : await api.hooks.uninstall()
      status.value = result.status
    } catch (error) {
      changeError.value = `Could not ${value === true ? 'install' : 'remove'} the hooks: ${messageOf(error, 'unknown error')}`
    } finally {
      checked.value = status.value?.installed ?? false
      busy.value = false
    }
  }

  onMounted(load)
</script>

<style scoped>
.claude-hooks {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-2);
  padding: var(--ah-space-4);
  border: 1px solid var(--ah-color-border-default);
  border-radius: var(--ah-radius-md);
  background: var(--ah-color-bg-surface);
}

.claude-hooks__title {
  font-size: var(--ah-font-size-md);
  font-weight: var(--ah-font-weight-semibold);
}

.claude-hooks__hint,
.claude-hooks__source {
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-sm);
}

.claude-hooks__error {
  display: flex;
  align-items: center;
  gap: var(--ah-space-2);
  color: var(--ah-color-status-error);
  font-size: var(--ah-font-size-sm);
}

.claude-hooks__problems {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-1);
  padding-left: var(--ah-space-4);
  color: var(--ah-color-status-waiting);
  font-size: var(--ah-font-size-sm);
}
</style>
