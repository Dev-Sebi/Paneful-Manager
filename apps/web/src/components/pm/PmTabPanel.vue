<template>
  <div
    :id="`${TABPANEL_ID_PREFIX}${value}`"
    ref="panelRef"
    :aria-labelledby="`${TAB_ID_PREFIX}${value}`"
    class="pm-tab-panel"
    :hidden="!active"
    role="tabpanel"
    :tabindex="needsStop ? 0 : undefined"
  >
    <slot v-if="keepAlive || active" />
  </div>
</template>

<script lang="ts" setup>
  import type { PmTabPanelProps, PmTabPanelSlots } from './types'
  import { computed, onMounted, onUpdated, ref } from 'vue'
  import { selectedTabs, TAB_ID_PREFIX, TABPANEL_ID_PREFIX } from './tabState'

  const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

  const props = withDefaults(defineProps<PmTabPanelProps>(), { keepAlive: true })

  defineSlots<PmTabPanelSlots>()

  const panelRef = ref<HTMLElement>()
  const hasFocusable = ref(false)
  const active = computed(() => selectedTabs.has(props.value))
  const needsStop = computed(() => active.value && !hasFocusable.value)

  function measure () {
    const found = Boolean(panelRef.value?.querySelector(FOCUSABLE))
    if (found !== hasFocusable.value) {
      hasFocusable.value = found
    }
  }

  onMounted(measure)
  onUpdated(measure)
</script>

<style scoped>
.pm-tab-panel[hidden] { display: none; }
</style>
