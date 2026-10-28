<template>
  <div class="pm-split-layout">
    <PmSplitNode :node="tree" path="0" :tab-id="tabId" @resized="scheduleResized">
      <template #pane="slotProps">
        <slot name="pane" v-bind="slotProps" />
      </template>
    </PmSplitNode>
  </div>
</template>

<script lang="ts" setup>
  import type { PmSplitLayoutExpose, PmSplitLayoutProps, PmSplitLayoutSlots } from './types'
  import { computed, onBeforeUnmount } from 'vue'
  import { useLayoutSizesStore } from '@/stores/layoutSizes'
  import { layoutToTree } from './layoutTree'
  import PmSplitNode from './PmSplitNode.vue'
  import 'splitpanes/dist/splitpanes.css'

  /** Quiet period after the last splitter move before `resized` fires. */
  const RESIZED_DEBOUNCE_MS = 120

  const props = defineProps<PmSplitLayoutProps>()
  const emit = defineEmits<{ (e: 'resized'): void }>()
  defineSlots<PmSplitLayoutSlots>()

  const store = useLayoutSizesStore()
  const tree = computed(() => layoutToTree(props.layout, props.panes))
  let timer: ReturnType<typeof setTimeout> | undefined

  function scheduleResized () {
    clearTimeout(timer)
    timer = setTimeout(() => emit('resized'), RESIZED_DEBOUNCE_MS)
  }

  function resetSizes () {
    store.reset(props.tabId)
    scheduleResized()
  }

  onBeforeUnmount(() => clearTimeout(timer))

  defineExpose<PmSplitLayoutExpose>({ resetSizes })
</script>

<style scoped>
.pm-split-layout {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
</style>
