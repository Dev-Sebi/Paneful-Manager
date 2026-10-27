<template>
  <Splitpanes
    v-if="node.type === 'split'"
    ref="splitRef"
    class="ah-split-node"
    :horizontal="node.direction === 'column'"
    @resized="onResized"
  >
    <Pane
      v-for="(child, index) in node.children"
      :key="childKey(child, index)"
      class="ah-split-node__pane"
      :min-size="MIN_PANE_PERCENT"
      :size="sizes[index]"
    >
      <AhSplitNode :node="child" :path="`${path}.${index}`" :tab-id="tabId" @resized="emit('resized')">
        <template #pane="slotProps">
          <slot name="pane" v-bind="slotProps" />
        </template>
      </AhSplitNode>
    </Pane>
  </Splitpanes>

  <div v-else class="ah-split-node__leaf">
    <slot :index="node.pane" name="pane" />
  </div>
</template>

<script lang="ts" setup>
  import type { LayoutNode } from '@agent-hub/shared'
  import type { SplitpanesResizedPayload } from 'splitpanes'
  import { Pane, Splitpanes } from 'splitpanes'
  import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
  import { useLayoutSizesStore } from '@/stores/layoutSizes'
  import { defaultSizes } from './layoutTree'

  /** Smallest share of a split a pane can shrink to, in percent. */
  const MIN_PANE_PERCENT = 10

  const props = defineProps<{
    node: LayoutNode
    /** Position of the node in the tree, used as the persistence key. */
    path: string
    tabId: string
  }>()

  const emit = defineEmits<{ (e: 'resized'): void }>()

  defineSlots<{ pane?: (props: { index: number }) => unknown }>()

  const store = useLayoutSizesStore()
  const splitRef = ref<{ $el: HTMLElement }>()
  let observer: MutationObserver | undefined

  const sizes = computed(() => {
    const node = props.node
    if (node.type !== 'split') {
      return []
    }
    return store.get(props.tabId, props.path, node.children.length) ?? defaultSizes(node)
  })

  function firstPane (node: LayoutNode): number {
    if (node.type === 'pane') {
      return node.pane
    }
    const [first] = node.children
    return first ? firstPane(first) : 0
  }

  function childKey (child: LayoutNode, index: number): string {
    return `${index}-${firstPane(child)}`
  }

  function onResized (payload: SplitpanesResizedPayload) {
    if (!payload.event || props.node.type !== 'split') {
      return
    }
    store.set(props.tabId, props.path, payload.panes.map(pane => pane.size))
    emit('resized')
  }

  /** Splitpanes creates the splitter elements itself, so labels are applied to the DOM. */
  function decorate () {
    const node = props.node
    const container = splitRef.value?.$el
    if (node.type !== 'split' || !container) {
      return
    }
    const splitters = Array.from(container.children).filter(el => el.classList.contains('splitpanes__splitter'))
    for (const [index, splitter] of splitters.entries()) {
      const before = node.children[index]
      const after = node.children[index + 1]
      if (!before || !after) {
        continue
      }
      splitter.setAttribute('aria-label', `Resize panes ${firstPane(before) + 1} and ${firstPane(after) + 1}`)
      const position = sizes.value.slice(0, index + 1).reduce((sum, value) => sum + value, 0)
      splitter.setAttribute('aria-valuenow', String(Math.round(position)))
    }
  }

  onMounted(() => {
    const container = splitRef.value?.$el
    if (container) {
      observer = new MutationObserver(decorate)
      observer.observe(container, { childList: true })
    }
    decorate()
  })

  onBeforeUnmount(() => observer?.disconnect())

  watch(sizes, () => nextTick(decorate))
</script>

<style scoped>
.ah-split-node__leaf {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.ah-split-node__pane {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* Splitpanes creates the splitters at runtime, so they carry no scope attribute. */
.ah-split-node :deep(> .splitpanes__splitter) {
  flex: none;
  background: transparent;
  transition: background-color var(--ah-motion-duration-fast) var(--ah-motion-easing-standard);
}

.ah-split-node.splitpanes--vertical > :deep(.splitpanes__splitter) { width: var(--ah-space-1); }
.ah-split-node.splitpanes--horizontal > :deep(.splitpanes__splitter) { height: var(--ah-space-1); }

.ah-split-node :deep(> .splitpanes__splitter:hover),
.ah-split-node :deep(> .splitpanes__splitter:focus-visible) {
  background: var(--ah-color-border-focus);
  outline: none;
}

.ah-split-node.splitpanes--ready > :deep(.splitpanes__pane) {
  transition: none;
}
</style>
