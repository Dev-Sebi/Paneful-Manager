<template>
  <main class="ah-home">
    <h1 class="ah-home__title">Components</h1>
    <p class="ah-home__note">Development-only component gallery.</p>

    <section class="ah-home__section">
      <h2>AhButton</h2>

      <div v-for="size in sizes" :key="size" class="ah-home__row">
        <AhButton v-for="variant in variants" :key="variant" :size="size" :variant="variant">{{ variant }} {{ size }}</AhButton>
        <AhButton prepend-icon="mdi-plus" :size="size">Prepend</AhButton>
        <AhButton append-icon="mdi-chevron-down" :size="size">Append</AhButton>
        <AhButton ariaLabel="Add" icon="mdi-plus" :size="size" variant="ghost" />
      </div>

      <div class="ah-home__row">
        <AhButton disabled>Disabled</AhButton>
        <AhButton loading variant="primary">Loading</AhButton>
        <AhButton :pressed="pressed" variant="ghost" @click="pressed = !pressed">Pressed: {{ pressed }}</AhButton>
        <AhButton shortcut="Alt+Shift+N">With shortcut</AhButton>
      </div>
    </section>

    <section class="ah-home__section">
      <h2>AhStatusBadge</h2>

      <div v-for="variant in badgeVariants" :key="variant" class="ah-home__row">
        <AhStatusBadge v-for="state in states" :key="state" :state="state" :variant="variant" />
        <AhStatusBadge size="sm" state="working" :variant="variant" />
      </div>

      <div class="ah-home__row">
        <AhStatusBadge announce :state="liveState" />
        <AhButton size="sm" @click="cycleState">Change state</AhButton>
      </div>
    </section>

    <section class="ah-home__section">
      <h2>AhTabs</h2>

      <AhTabs
        v-model="active"
        ariaLabel="Demo sessions"
        closable
        reorderable
        @add="addTab"
        @close="closeTab"
        @reorder="moveTab"
      >
        <AhTab
          v-for="tab in tabs"
          :key="tab.value"
          :dirty="tab.dirty"
          :status="tab.status"
          :title="tab.title"
          :value="tab.value"
        />

        <AhTab disabled title="Disabled" value="disabled" />
      </AhTabs>

      <AhTabPanel v-for="tab in tabs" :key="tab.value" class="ah-home__panel" :value="tab.value">Panel {{ tab.title }}</AhTabPanel>
    </section>

    <section class="ah-home__section">
      <h2>AhDialog</h2>

      <div class="ah-home__row">
        <AhButton @click="dialog = 'default'">Default</AhButton>
        <AhButton variant="danger" @click="dialog = 'danger'">Danger</AhButton>
        <AhButton @click="dialog = 'persistent'">Persistent</AhButton>
      </div>

      <AhDialog
        confirm-text="Confirm"
        :model-value="dialog === 'default'"
        title="Save preset"
        @update:model-value="dialog = undefined"
      >
        Name your preset.
      </AhDialog>

      <AhDialog
        confirm-text="Close session"
        :model-value="dialog === 'danger'"
        title="Close session"
        tone="danger"
        @update:model-value="dialog = undefined"
      >
        Unsaved work is lost.
      </AhDialog>

      <AhDialog
        confirm-text="Stop"
        :model-value="dialog === 'persistent'"
        persistent
        title="Running action"
        @confirm="dialog = undefined"
      >
        Escape and scrim are blocked.
      </AhDialog>
    </section>
  </main>
</template>

<script lang="ts" setup>
  import type { AhButtonSize, AhButtonVariant, AhStatusBadgeState, AhStatusBadgeVariant, AhTabsReorderPayload } from '@/components/ah'
  import { ref } from 'vue'
  import { AhButton, AhDialog, AhStatusBadge, AhTab, AhTabPanel, AhTabs } from '@/components/ah'

  interface DemoTab {
    value: string
    title: string
    status?: AhStatusBadgeState
    dirty?: boolean
  }

  const sizes: AhButtonSize[] = ['sm', 'md', 'lg']
  const variants: AhButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger']
  const states: AhStatusBadgeState[] = ['working', 'waiting', 'error', 'idle']
  const badgeVariants: AhStatusBadgeVariant[] = ['label', 'dot']

  const pressed = ref(false)
  const liveState = ref<AhStatusBadgeState>('working')
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

  function moveTab ({ from, to }: AhTabsReorderPayload) {
    const [moved] = tabs.value.splice(from, 1)
    if (moved) {
      tabs.value.splice(to, 0, moved)
    }
  }
</script>

<style scoped>
.ah-home {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-4);
  padding: var(--ah-space-8);
  color: var(--ah-color-fg-primary);
}

.ah-home__title {
  font-size: var(--ah-font-size-2xl);
  font-weight: var(--ah-font-weight-semibold);
  line-height: var(--ah-font-line-height-tight);
}

.ah-home__note { color: var(--ah-color-fg-muted); }

.ah-home__section {
  display: flex;
  flex-direction: column;
  gap: var(--ah-space-2);
}

.ah-home__section h2 {
  font-size: var(--ah-font-size-lg);
  font-weight: var(--ah-font-weight-semibold);
}

.ah-home__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ah-space-2);
}

.ah-home__panel { padding: var(--ah-space-3); }
</style>
