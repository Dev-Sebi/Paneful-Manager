import type { AhStatusBadgeState } from '../AhStatusBadge'

/* ---------- AhTabs (tablist container) ---------- */

export type AhTabsDensity = 'compact' | 'default'

export interface AhTabsProps {
  /** Value of the active tab (v-model). */
  modelValue?: string
  /** Accessible name of the tablist, e.g. 'Sessions'. */
  ariaLabel: string
  /** Allows reordering by drag and by Ctrl+Shift+ArrowLeft/Right. @default false */
  reorderable?: boolean
  /** Default for child tabs that do not set `closable`. @default false */
  closable?: boolean
  /** Shows the "new tab" button in the append area. @default false */
  addable?: boolean
  /** compact 28px, default 32px tab height. @default 'default' */
  density?: AhTabsDensity
}

export interface AhTabsReorderPayload {
  value: string
  from: number
  to: number
}

export interface AhTabsEmits {
  (e: 'update:modelValue', value: string): void
  /** Parent owns the order and applies the move. */
  (e: 'reorder', payload: AhTabsReorderPayload): void
  /** Parent decides; dirty tabs should be confirmed with AhDialog first. */
  (e: 'close', value: string): void
  (e: 'add'): void
}

export interface AhTabsSlots {
  /** AhTab children. */
  default?: () => unknown
  /** Actions after the last tab (new tab, overflow menu). */
  append?: () => unknown
}

/* ---------- AhTab (single tab) ---------- */

export interface AhTabProps {
  /** Unique id within the tablist. */
  value: string
  /** Visible label; truncated with ellipsis, full text in tooltip. */
  title: string
  /** Optional session state shown as a dot badge before the title. */
  status?: AhStatusBadgeState
  /** Unsaved or unacknowledged changes; shows a dot in place of the close icon. @default false */
  dirty?: boolean
  /** Overrides AhTabs `closable`. */
  closable?: boolean
  /** @default false */
  disabled?: boolean
  /** Icon name before the title (ignored when `status` is set). */
  icon?: string
  /** id of the controlled tabpanel; generated when omitted. */
  panelId?: string
}

export interface AhTabEmits {
  (e: 'close', value: string): void
}

export interface AhTabSlots {
  /** Replaces icon / status badge. */
  prepend?: () => unknown
  /** Replaces the title text. */
  default?: () => unknown
}
