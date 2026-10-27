<template>
  <div class="ah-split-layout">
    <AhSplitNode :node="tree" path="0" :tab-id="tabId" @resized="scheduleResized">
      <template #pane="slotProps">
        <slot name="pane" v-bind="slotProps" />
      </template>
    </AhSplitNode>
  </div>
</template>

<script lang="ts" setup>
  import type { AhSplitLayoutExpose, AhSplitLayoutProps, AhSplitLayoutSlots } from './types'
  import { computed, onBeforeUnmount } from 'vue'
  import { useLayoutSizesStore } from '@/stores/layoutSizes'
  import AhSplitNode from './AhSplitNode.vue'
  import { layoutToTree } from './layoutTree'
  import 'splitpanes/dist/splitpanes.css'

  /** Quiet period after the last splitter move before `resized` fires. */
  const RESIZED_DEBOUNCE_MS = 120

  const props = defineProps<AhSplitLayoutProps>()
  const emit = defineEmits<{ (e: 'resized'): void }>()
  defineSlots<AhSplitLayoutSlots>()

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

  defineExpose<AhSplitLayoutExpose>({ resetSizes })
</script>

<style scoped>
.ah-split-layout {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
</style>
