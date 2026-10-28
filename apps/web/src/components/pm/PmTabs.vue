<template>
  <div class="pm-tabs" :class="`pm-tabs--${density}`">
    <ul
      ref="listRef"
      :aria-label="ariaLabel"
      aria-orientation="horizontal"
      class="pm-tabs__list"
      role="tablist"
      @keydown="onKeydown"
    >
      <slot />
    </ul>

    <div v-if="addable || $slots.append" class="pm-tabs__append">
      <PmButton
        v-if="addable"
        ariaLabel="New tab"
        icon="mdi-plus"
        size="sm"
        variant="ghost"
        @click="emit('add')"
      />

      <slot name="append" />
    </div>

    <div aria-live="polite" class="pm-tabs__live" role="status">{{ announcement }}</div>
  </div>
</template>

<script lang="ts" setup>
  /* eslint-disable vue/custom-event-name-casing -- v-model event name is fixed by Vue */
  import type { PmTabsContext } from './tabState'
  import type { PmTabsEmits, PmTabsProps, PmTabsSlots } from './types'
  import { nextTick, onMounted, provide, reactive, ref, toRef } from 'vue'
  import PmButton from './PmButton.vue'
  import { AH_TABS_KEY, TAB_ID_PREFIX } from './tabState'

  const props = withDefaults(defineProps<PmTabsProps>(), {
    modelValue: undefined,
    reorderable: false,
    closable: false,
    addable: false,
    density: 'default',
  })

  const emit = defineEmits<PmTabsEmits>()

  defineSlots<PmTabsSlots>()

  const listRef = ref<HTMLUListElement>()
  const announcement = ref('')
  const ready = ref(false)
  const closing = new Map<string, string>()

  const context: PmTabsContext = {
    activeValue: toRef(props, 'modelValue'),
    closable: toRef(props, 'closable'),
    ready,
    registry: reactive(new Map<string, boolean>()),
    removed: el => {
      const tabs = tabElements(true)
      const index = tabs.indexOf(el)
      const next = tabs[index + 1] ?? tabs[index - 1]
      if (next && next !== el) {
        void nextTick(() => next.focus())
      }
    },
    select: value => emit('update:modelValue', value),
    close: (value, title) => {
      closing.set(value, title)
      emit('close', value)
    },
    unmounted: value => {
      const title = closing.get(value)
      if (title !== undefined) {
        closing.delete(value)
        announcement.value = `Closed ${title}`
      }
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
.pm-tabs {
  --pm-tabs-height: 32px;

  display: flex;
  align-items: stretch;
  height: var(--pm-tabs-height);
  background: var(--pm-color-bg-surface);
  border-bottom: 1px solid var(--pm-color-border-default);
  font-family: var(--pm-font-family-ui);
  font-size: var(--pm-font-size-md);
  line-height: var(--pm-font-line-height-tight);
}

.pm-tabs--compact { --pm-tabs-height: 28px; }

.pm-tabs__list {
  display: flex;
  flex: 0 1 auto;
  min-width: 0;
  margin: 0;
  padding: 0;
  overflow-x: auto;
  list-style: none;
  scrollbar-width: none;
}

.pm-tabs__append {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--pm-space-1);
  padding: 0 var(--pm-space-2);
}

.pm-tabs__live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
