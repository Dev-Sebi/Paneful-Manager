<template>
  <div class="pm-home">
    <h1 class="pm-home__title">Components</h1>
    <p class="pm-home__note">Development-only component gallery.</p>

    <section class="pm-home__section">
      <h2>PmButton</h2>

      <div v-for="size in sizes" :key="size" class="pm-home__row">
        <PmButton v-for="variant in variants" :key="variant" :size="size" :variant="variant">{{ variant }} {{ size }}</PmButton>
        <PmButton prepend-icon="mdi-plus" :size="size">Prepend</PmButton>
        <PmButton append-icon="mdi-chevron-down" :size="size">Append</PmButton>
        <PmButton ariaLabel="Add" icon="mdi-plus" :size="size" variant="ghost" />
      </div>

      <div class="pm-home__row">
        <PmButton disabled>Disabled</PmButton>
        <PmButton loading variant="primary">Loading</PmButton>
        <PmButton :pressed="pressed" variant="ghost" @click="pressed = !pressed">Pressed: {{ pressed }}</PmButton>
        <PmButton shortcut="Alt+Shift+N">With shortcut</PmButton>
      </div>
    </section>

    <section class="pm-home__section">
      <h2>PmStatusBadge</h2>

      <div v-for="variant in badgeVariants" :key="variant" class="pm-home__row">
        <PmStatusBadge v-for="state in states" :key="state" :state="state" :variant="variant" />
        <PmStatusBadge size="sm" state="working" :variant="variant" />
      </div>

      <div class="pm-home__row">
        <PmStatusBadge announce :state="liveState" />
        <PmButton size="sm" @click="cycleState">Change state</PmButton>
      </div>
    </section>

    <section class="pm-home__section">
      <h2>PmTabs</h2>

      <PmTabs
        v-model="active"
        ariaLabel="Demo sessions"
        closable
        reorderable
        @add="addTab"
        @close="closeTab"
        @reorder="moveTab"
      >
        <PmTab
          v-for="tab in tabs"
          :key="tab.value"
          :dirty="tab.dirty"
          :status="tab.status"
          :title="tab.title"
          :value="tab.value"
        />

        <PmTab disabled title="Disabled" value="disabled" />
      </PmTabs>

      <PmTabPanel v-for="tab in tabs" :key="tab.value" class="pm-home__panel" :value="tab.value">Panel {{ tab.title }}</PmTabPanel>
    </section>

    <section class="pm-home__section">
      <h2>PmDialog</h2>

      <div class="pm-home__row">
        <PmButton @click="dialog = 'default'">Default</PmButton>
        <PmButton variant="danger" @click="dialog = 'danger'">Danger</PmButton>
        <PmButton @click="dialog = 'persistent'">Persistent</PmButton>
      </div>

      <PmDialog
        confirm-text="Confirm"
        :model-value="dialog === 'default'"
        title="Save preset"
        @update:model-value="dialog = undefined"
      >
        Name your preset.
      </PmDialog>

      <PmDialog
        confirm-text="Close session"
        :model-value="dialog === 'danger'"
        title="Close session"
        tone="danger"
        @update:model-value="dialog = undefined"
      >
        Unsaved work is lost.
      </PmDialog>

      <PmDialog
        confirm-text="Stop"
        :model-value="dialog === 'persistent'"
        persistent
        title="Running action"
        @confirm="dialog = undefined"
      >
        Escape and scrim are blocked.
      </PmDialog>
    </section>

    <EditorShowcase />
  </div>
</template>

<script lang="ts" setup>
  import type { PmButtonSize, PmButtonVariant, PmStatusBadgeState, PmStatusBadgeVariant, PmTabsReorderPayload } from '@/components/pm'
  import { ref } from 'vue'
  import { PmButton, PmDialog, PmStatusBadge, PmTab, PmTabPanel, PmTabs } from '@/components/pm'
  import EditorShowcase from '@/components/editor/EditorShowcase.vue'

  interface DemoTab {
    value: string
    title: string
    status?: PmStatusBadgeState
    dirty?: boolean
  }

  const sizes: PmButtonSize[] = ['sm', 'md', 'lg']
  const variants: PmButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger']
  const states: PmStatusBadgeState[] = ['working', 'waiting', 'error', 'idle']
  const badgeVariants: PmStatusBadgeVariant[] = ['label', 'dot']

  const pressed = ref(false)
  const liveState = ref<PmStatusBadgeState>('working')
  const dialog = ref<'default' | 'danger' | 'persistent'>()

  const tabs = ref<DemoTab[]>([
    { value: 'api', title: 'api-server', status: 'working' },
    { value: 'web', title: 'web-client', status: 'waiting', dirty: true },
    { value: 'docs', title: 'docs' },
  ])
  const active = ref('api')
  let counter = 0

  function cycleState () {
    liveState.value = states[(states.indexOf(liveState.value) + 1) % states.length] ?? 'working'
  }

  function addTab () {
    counter += 1
    const value = `new-${counter}`
    tabs.value.push({ value, title: `session ${counter}` })
    active.value = value
  }

  function closeTab (value: string) {
    tabs.value = tabs.value.filter(tab => tab.value !== value)
  }

  function moveTab ({ from, to }: PmTabsReorderPayload) {
    const [moved] = tabs.value.splice(from, 1)
    if (moved) {
      tabs.value.splice(to, 0, moved)
    }
  }
</script>

<style scoped>
.pm-home {
  display: flex;
  flex-direction: column;
  gap: var(--pm-space-4);
  padding: var(--pm-space-8);
  color: var(--pm-color-fg-primary);
}

.pm-home__title {
  font-size: var(--pm-font-size-2xl);
  font-weight: var(--pm-font-weight-semibold);
  line-height: var(--pm-font-line-height-tight);
}

.pm-home__note { color: var(--pm-color-fg-muted); }

.pm-home__section {
  display: flex;
  flex-direction: column;
  gap: var(--pm-space-2);
}

.pm-home__section h2 {
  font-size: var(--pm-font-size-lg);
  font-weight: var(--pm-font-weight-semibold);
}

.pm-home__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--pm-space-2);
}

.pm-home__panel { padding: var(--pm-space-3); }
</style>
