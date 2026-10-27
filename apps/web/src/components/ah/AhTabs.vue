<template>
  <div class="ah-tabs" :class="`ah-tabs--${density}`">
    <ul
      ref="listRef"
      :aria-label="ariaLabel"
      aria-orientation="horizontal"
      class="ah-tabs__list"
      role="tablist"
      @keydown="onKeydown"
    >
      <slot />
    </ul>

    <div v-if="addable || $slots.append" class="ah-tabs__append">
      <AhButton
        v-if="addable"
        aria-label="New tab"
        icon="mdi-plus"
        size="sm"
        variant="ghost"
        @click="emit('add')"
      />

      <slot name="append" />
    </div>

    <div aria-live="polite" class="ah-tabs__live" role="status">{{ announcement }}</div>
  </div>
</template>

<script lang="ts" setup>
  /* eslint-disable vue/custom-event-name-casing -- v-model event name is fixed by Vue */
  import type { AhTabsContext } from './tabState'
  import type { AhTabsEmits, AhTabsProps } from './types'
  import { nextTick, onMounted, provide, reactive, ref, toRef } from 'vue'
  import AhButton from './AhButton.vue'
  import { AH_TABS_KEY, TAB_ID_PREFIX } from './tabState'

  const props = withDefaults(defineProps<AhTabsProps>(), {
    modelValue: undefined,
    reorderable: false,
    closable: false,
    addable: false,
    density: 'default',
  })

  const emit = defineEmits<AhTabsEmits>()

  const listRef = ref<HTMLUListElement>()
  const announcement = ref('')
  const ready = ref(false)

  const context: AhTabsContext = {
    activeValue: toRef(props, 'modelValue'),
    closable: toRef(props, 'closable'),
    ready,
    registry: reactive(new Map<string, boolean>()),
    select: value => emit('update:modelValue', value),
    close: (value, title) => {
      emit('close', value)
      announcement.value = `Closed ${title}`
    },
  }

  provide(AH_TABS_KEY, context)

  onMounted(() => {
    ready.value = true
  })

  function tabElements (enabledOnly: boolean) {
    const selector = enabledOnly ? '[role="tab"]:not([aria-disabled="true"])' : '[role="tab"]'
    return Array.from(listRef.value?.querySelectorAll<HTMLElement>(selector) ?? [])
  }

  function valueOf (el: HTMLElement) {
    return el.id.slice(TAB_ID_PREFIX.length)
  }

  function activate (el: HTMLElement | undefined) {
    if (!el) {
      return
    }
    el.focus()
    emit('update:modelValue', valueOf(el))
  }

  function reorder (current: HTMLElement, direction: -1 | 1) {
    const all = tabElements(false)
    const from = all.indexOf(current)
    const to = from + direction
    if (from < 0 || to < 0 || to >= all.length) {
      return
    }
    const value = valueOf(current)
    const title = current.textContent?.trim() || value
    emit('reorder', { value, from, to })
    announcement.value = `Moved ${title} to position ${to + 1} of ${all.length}`
    void nextTick(() => current.focus())
  }

  function onKeydown (event: KeyboardEvent) {
    const current = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]')
    if (!current) {
      return
    }
    const arrow = event.key === 'ArrowLeft' ? -1 : (event.key === 'ArrowRight' ? 1 : 0)
    if (arrow && event.ctrlKey && event.shiftKey) {
      if (props.reorderable) {
        event.preventDefault()
        reorder(current, arrow)
      }
      return
    }
    const tabs = tabElements(true)
    const index = tabs.indexOf(current)
    if (arrow) {
      event.preventDefault()
      activate(tabs[(index + arrow + tabs.length) % tabs.length])
    } else if (event.key === 'Home') {
      event.preventDefault()
      activate(tabs[0])
    } else if (event.key === 'End') {
      event.preventDefault()
      activate(tabs.at(-1))
    }
  }
</script>

<style scoped>
.ah-tabs {
  --ah-tabs-height: 32px;

  display: flex;
  align-items: stretch;
  height: var(--ah-tabs-height);
  background: var(--ah-color-bg-surface);
  border-bottom: 1px solid var(--ah-color-border-default);
  font-family: var(--ah-font-family-ui);
  font-size: var(--ah-font-size-md);
  line-height: var(--ah-font-line-height-tight);
}

.ah-tabs--compact { --ah-tabs-height: 28px; }

.ah-tabs__list {
  display: flex;
  flex: 0 1 auto;
  min-width: 0;
  margin: 0;
  padding: 0;
  overflow-x: auto;
  list-style: none;
  scrollbar-width: none;
}

.ah-tabs__append {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--ah-space-1);
  padding: 0 var(--ah-space-2);
}

.ah-tabs__live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
