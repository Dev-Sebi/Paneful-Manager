import type { PmStatusBadgeState } from '../PmStatusBadge'

/*
 * Id convention (wired by the components, never passed by hand):
 *   tab element:      id="pm-tab-<value>"       aria-controls="pm-tabpanel-<value>"
 *   PmTabPanel:       id="pm-tabpanel-<value>"  aria-labelledby="pm-tab-<value>"
 * `value` must be unique per page and contain only [A-Za-z0-9_-].
 */

/* ---------- PmTabs (tablist container) ---------- */

export type PmTabsDensity = 'compact' | 'default'

export interface PmTabsProps {
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
  density?: PmTabsDensity
}

export interface PmTabsReorderPayload {
  value: string
  from: number
  to: number
}

export interface PmTabsEmits {
  (e: 'update:modelValue', value: string): void
  /** Parent owns the order and applies the move. */
  (e: 'reorder', payload: PmTabsReorderPayload): void
  /** Parent decides; dirty tabs should be confirmed with PmDialog first. */
  (e: 'close', value: string): void
  (e: 'add'): void
}

export interface PmTabsSlots {
  /** PmTab children. */
  default?: () => unknown
  /** Actions after the last tab (new tab, overflow menu); outside the tablist element. */
  append?: () => unknown
}

/* ---------- PmTab (one tab: wrapper li > tab element + close button) ---------- */

export interface PmTabProps {
  /** Unique id; drives `pm-tab-<value>` / `pm-tabpanel-<value>`. */
  value: string
  /** Visible label; truncated with ellipsis, full text in tooltip. */
  title: string
  /** Optional session state shown as a dot badge before the title. */
  status?: PmStatusBadgeState
  /** Unsaved or unacknowledged changes; shows a dot in place of the close icon. @default false */
  dirty?: boolean
  /** Overrides PmTabs `closable`. */
  closable?: boolean
  /** @default false */
  disabled?: boolean
  /** Icon name before the title (ignored when `status` is set). */
  icon?: string
}

export interface PmTabEmits {
  (e: 'close', value: string): void
}

export interface PmTabSlots {
  /** Replaces icon / status badge. */
  prepend?: () => unknown
  /** Replaces the title text. */
  default?: () => unknown
}

/* ---------- PmTabPanel (content controlled by a tab) ---------- */

export interface PmTabPanelProps {
  /** Same value as the controlling PmTab. */
  value: string
  /** Keep the panel mounted while inactive (terminal panes must stay mounted). @default true */
  keepAlive?: boolean
}

export interface PmTabPanelSlots {
  default?: () => unknown
}
