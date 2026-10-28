<template>
  <article :aria-label="`Server ${entry.name}`" class="mcp-detail">
    <header class="mcp-detail__header">
      <h2 class="mcp-detail__title">{{ entry.name }}</h2>
      <span class="mcp-detail__chip">{{ config.transport }}</span>
      <slot :entry="entry" name="health" />
      <span class="mcp-detail__spacer" />
      <PmButton prepend-icon="mdi-pencil-outline" @click="emit('edit')">Edit</PmButton>
      <PmButton prepend-icon="mdi-delete-outline" variant="danger" @click="emit('remove')">Remove</PmButton>
    </header>

    <dl class="mcp-detail__facts">
      <dt>Scope</dt>
      <dd>{{ scopeText }}</dd>

      <dt>Source</dt>
      <dd>{{ entry.source === 'cli' ? 'claude CLI' : 'Config file' }} ({{ entry.source }})</dd>

      <template v-if="config.transport === 'stdio'">
        <dt>Command</dt>
        <dd><code>{{ config.command }}</code></dd>

        <dt>Arguments</dt>

        <dd>
          <ol v-if="config.args.length > 0" class="mcp-detail__args">
            <li v-for="(arg, index) in config.args" :key="index"><code>{{ arg }}</code></li>
          </ol>

          <span v-else class="mcp-detail__muted">None</span>
        </dd>
      </template>

      <template v-else>
        <dt>URL</dt>
        <dd><code>{{ config.url }}</code></dd>
      </template>
    </dl>

    <section class="mcp-detail__values">
      <h3 class="mcp-detail__subtitle">{{ config.transport === 'stdio' ? 'Environment variables' : 'Headers' }}</h3>

      <p v-if="rows.length === 0" class="mcp-detail__muted">None</p>

      <table v-else class="mcp-detail__table">
        <thead>
          <tr><th scope="col">Key</th><th scope="col">Value</th><th scope="col">Status</th></tr>
        </thead>

        <tbody>
          <tr v-for="row in rows" :key="row.key">
            <td><code>{{ row.key }}</code></td>

            <td>
              <template v-if="row.hidden">
                <span aria-hidden="true">{{ row.text }}</span>

                <span class="mcp-detail__hidden">{{ row.hidden }}</span>
              </template>

              <template v-else>{{ row.text }}</template>
            </td>

            <td>{{ row.status }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </article>
</template>

<script lang="ts" setup>
  import type { McpServerEntryMasked } from '@paneful-manager/shared'
  import { computed } from 'vue'
  import { PmButton } from '@/components/pm'
  import { scopeLabel } from '@/stores/mcp'

  const props = defineProps<{ entry: McpServerEntryMasked }>()

  const emit = defineEmits<{ edit: [], remove: [] }>()

  const config = computed(() => props.entry.config)
  const scopeText = computed(() => scopeLabel(props.entry.scope))

  /** Secrets arrive masked; only keys the server marks as plain come with a value. */
  const rows = computed(() => {
    const values = config.value.transport === 'stdio' ? config.value.env : config.value.headers
    return Object.entries(values).map(([key, value]) => {
      if (typeof value === 'string') {
        return { key, text: value, hidden: undefined, status: 'plain' }
      }
      return { key, text: '••••', hidden: value.set ? 'value set, hidden' : 'no value', status: value.set ? 'set' : 'not set' }
    })
  })
</script>

<style scoped>
.mcp-detail {
  display: flex;
  flex-direction: column;
  gap: var(--pm-space-4);
  min-width: 0;
}

.mcp-detail__header {
  display: flex;
  flex-wrap: wrap;
  gap: var(--pm-space-2);
  align-items: center;
}

.mcp-detail__title {
  margin: 0;
  font-size: var(--pm-font-size-lg);
  font-weight: var(--pm-font-weight-semibold);
}

.mcp-detail__spacer { flex: 1; }

.mcp-detail__chip {
  padding: 0 var(--pm-space-2);
  border: 1px solid var(--pm-color-border-default);
  border-radius: var(--pm-radius-full);
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-sm);
}

.mcp-detail__facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--pm-space-2) var(--pm-space-4);
  margin: 0;
}

.mcp-detail__facts dt { color: var(--pm-color-fg-muted); }
.mcp-detail__facts dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }

.mcp-detail__args {
  margin: 0;
  padding: 0;
  list-style: none;
}

.mcp-detail__subtitle {
  margin: 0 0 var(--pm-space-2);
  font-size: var(--pm-font-size-md);
  font-weight: var(--pm-font-weight-semibold);
}

.mcp-detail__hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.mcp-detail__muted { color: var(--pm-color-fg-muted); }

.mcp-detail__table {
  width: 100%;
  border-collapse: collapse;
}

.mcp-detail__table th,
.mcp-detail__table td {
  padding: var(--pm-space-1) var(--pm-space-2);
  border-bottom: 1px solid var(--pm-color-border-default);
  text-align: left;
}

.mcp-detail__table th {
  color: var(--pm-color-fg-muted);
  font-size: var(--pm-font-size-sm);
  font-weight: var(--pm-font-weight-medium);
}
</style>
