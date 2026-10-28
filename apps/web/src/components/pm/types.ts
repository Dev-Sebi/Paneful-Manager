/* eslint-disable @typescript-eslint/unified-signatures -- overloads mirror the spec contract one to one */
import type { Layout } from '@paneful-manager/shared'
/** Contract types mirroring docs/design-system/components/<Name>/index.d.ts. */

/** Visual emphasis of the button. */
export type PmButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

/** Height: sm 24px, md 28px, lg 32px. */
export type PmButtonSize = 'sm' | 'md' | 'lg'

export interface PmButtonProps {
  /** @default 'secondary' */
  variant?: PmButtonVariant
  /** @default 'md' */
  size?: PmButtonSize
  /** Native button type. @default 'button' */
  type?: 'button' | 'submit' | 'reset'
  /** @default false */
  disabled?: boolean
  /** Shows a spinner, sets aria-busy and blocks clicks while keeping focus. @default false */
  loading?: boolean
  /** Toggle state; renders aria-pressed when defined. @default undefined */
  pressed?: boolean
  /** Icon name rendered before the label. */
  prependIcon?: string
  /** Icon name rendered after the label. */
  appendIcon?: string
  /** Icon-only button; `ariaLabel` becomes required (not type-enforced; enforced as a runtime dev warning). */
  icon?: string
  /** Accessible name; required when `icon` is set. */
  ariaLabel?: string
  /** Keyboard shortcut hint shown in the tooltip and exposed via aria-keyshortcuts, e.g. 'Alt+Shift+N' (avoid browser-reserved combos such as Ctrl+T, Ctrl+W, Ctrl+Shift+T). */
  shortcut?: string
  /** Stretch to container width. @default false */
  block?: boolean
}

export interface PmButtonEmits {
  /** Not emitted while disabled or loading. */
  (e: 'click', event: MouseEvent | KeyboardEvent): void
}

export interface PmButtonSlots {
  /** Label content. */
  default?: () => unknown
  /** Replaces `prependIcon`. */
  prepend?: () => unknown
  /** Replaces `appendIcon`. */
  append?: () => unknown
}

/** Session state of an agent. */
export type PmStatusBadgeState = 'working' | 'waiting' | 'error' | 'idle'

/** dot: 8px marker only (tabs, lists). label: marker + text pill. */
export type PmStatusBadgeVariant = 'dot' | 'label'

export type PmStatusBadgeSize = 'sm' | 'md'

export interface PmStatusBadgeProps {
  state: PmStatusBadgeState
  /** @default 'label' */
  variant?: PmStatusBadgeVariant
  /** @default 'md' */
  size?: PmStatusBadgeSize
  /** Overrides the default text ('Working', 'Waiting for input', 'Error', 'Idle'). Used as aria-label for `dot`. */
  label?: string
  /** Announce state changes in a polite live region. @default false */
  announce?: boolean
}

export interface PmStatusBadgeEmits {
  /** Fired once the one-shot "waiting" pulse has finished (or immediately with reduced motion). */
  (e: 'attention-end'): void
}

export interface PmStatusBadgeSlots {
  /** Replaces the label text (variant 'label' only). */
  default?: () => unknown
}

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

/** danger: destructive confirmation; title icon and confirm button use danger tokens. */
export type PmDialogTone = 'default' | 'danger'

/** Max width: sm 400px, md 560px, lg 800px. */
export type PmDialogSize = 'sm' | 'md' | 'lg'

export interface PmDialogProps {
  /** Open state (v-model). */
  modelValue: boolean
  /** Visible heading; also the accessible name via aria-labelledby. */
  title: string
  /** @default 'default' */
  tone?: PmDialogTone
  /** @default 'md' */
  size?: PmDialogSize
  /** Scrim click and Escape do not close; the blocked-close helper line shows and a headShake plays. @default false */
  persistent?: boolean
  /** Helper line shown under the title when a close is blocked. @default 'Finish or cancel the running action first' */
  blockedMessage?: string
  /** Confirm button label; omit to hide the default actions. */
  confirmText?: string
  /** @default 'Cancel' */
  cancelText?: string
  /** Shows a spinner on the confirm button and blocks closing. @default false */
  loading?: boolean
  /** CSS selector inside the dialog that receives initial focus. Defaults to the first focusable element in the body, else cancel (danger) or confirm (default). */
  initialFocus?: string
  /** Shows the close (x) button in the header. Hidden when persistent. @default true */
  closable?: boolean
}

export type PmDialogCloseReason = 'confirm' | 'cancel' | 'escape' | 'scrim' | 'close-button'

export interface PmDialogEmits {
  (e: 'update:modelValue', value: boolean): void
  (e: 'confirm'): void
  (e: 'cancel', reason: Exclude<PmDialogCloseReason, 'confirm'>): void
  /** Escape or scrim click on a persistent dialog. */
  (e: 'close-blocked'): void
  /** Leave animation finished; focus has returned to the opener. */
  (e: 'after-leave'): void
}

export interface PmDialogSlots {
  /** Body content. */
  default?: () => unknown
  /** Replaces the title text (keep it short). */
  title?: () => unknown
  /** Replaces the default actions (cancel + confirm). */
  actions?: (props: { confirm: () => void, cancel: () => void }) => unknown
}

/* ---------- PmTerminalPane ---------- */

/** Connection lifecycle of the underlying PTY. */
export type PmTerminalConnection = 'connecting' | 'connected' | 'exited' | 'failed'

/**
 * 'vertical': vertical divider, new pane to the right (side by side).
 * 'horizontal': horizontal divider, new pane below (stacked).
 */
export type PmTerminalSplitDirection = 'horizontal' | 'vertical'

export type PmTerminalCursorStyle = 'block' | 'bar' | 'underline'

/** Agent-team member running in the pane. */
export interface PmTerminalPaneMember {
  name: string
  /** Shown as a label badge, e.g. 'Lead' or the agent type. */
  role: string
  /** Other members whose panes share this tmux window. */
  others?: string[]
}

export interface PmTerminalPaneProps {
  /** Backend session id the pane attaches to. */
  sessionId: string
  /** Header title, e.g. session or preset name. */
  title: string
  /** Working directory shown in the header (shortened with ~ for the home directory). */
  cwd?: string
  /** Agent state shown as PmStatusBadge in the header. */
  status?: PmStatusBadgeState
  /** ISO time the session entered its current state; the header shows the elapsed time next to the state. */
  stateSince?: string
  /** 'exited' and 'failed' override the live binding; otherwise the binding decides. @default 'connecting' */
  connection?: PmTerminalConnection
  /** Exit code shown in the exited overlay. */
  exitCode?: number
  /** Pane has keyboard focus within the split layout (controlled by the layout). @default false */
  focused?: boolean
  /** Pane fills the whole workspace. @default false */
  maximized?: boolean
  /** Font size as a px number (xterm needs a number). Default: numeric value of token font.size.md (13). Allowed range 10..24. */
  fontSize?: number
  /** @default 'block' */
  cursorStyle?: PmTerminalCursorStyle
  /** @default true */
  cursorBlink?: boolean
  /** Lines kept in the scrollback buffer; matches the server's scrollback depth. @default 10000 */
  scrollback?: number
  /** Input is not forwarded to the PTY (team views, replay). @default false */
  readonly?: boolean
  /** Hides the header (single-pane focus mode). @default false */
  hideHeader?: boolean
  /** Team member linked to the session; shows name and role badge in the header. */
  member?: PmTerminalPaneMember
}

export interface PmTerminalResizePayload {
  cols: number
  rows: number
}

export interface PmTerminalStatePayload {
  state: PmStatusBadgeState
  lifecycle: 'starting' | 'running' | 'exited'
  exitCode?: number
}

export interface PmTerminalPaneEmits {
  /** Pane received focus by click or keyboard. */
  (e: 'focus'): void
  /** Raw keyboard input for the PTY. Not emitted when readonly. */
  (e: 'input', data: string): void
  (e: 'resize', payload: PmTerminalResizePayload): void
  (e: 'split', direction: PmTerminalSplitDirection): void
  (e: 'toggle-maximize'): void
  /** User requested close; parent confirms if the agent is working or waiting. */
  (e: 'close'): void
  /** Restart request from the exited overlay. */
  (e: 'restart'): void
  /** OSC title change from the running program. */
  (e: 'title-change', title: string): void
  /** `state` frame received for this session. */
  (e: 'state', payload: PmTerminalStatePayload): void
  /** The session was removed on the server. */
  (e: 'exited'): void
}

export interface PmTerminalPaneSlots {
  /** Extra header actions before split/maximize/close. */
  'header-actions'?: () => unknown
  /** Replaces the default overlay for connecting/exited/failed. */
  'overlay'?: (props: { connection: PmTerminalConnection, exitCode?: number }) => unknown
}

/** Imperative API exposed via template ref. */
export interface PmTerminalPaneExpose {
  write: (data: string) => void
  clear: () => void
  focus: () => void
  fit: () => void
  /** Selected text, empty string when nothing is selected. */
  getSelection: () => string
}

/* ---------- PmSplitLayout ---------- */

export interface PmSplitLayoutProps {
  /** Arrangement to render; `custom` trees point at `panes[i]`. */
  layout: Layout
  /** Panes of the tab; `size` is the default weight for row and column layouts. */
  panes: ReadonlyArray<{ size?: number }>
  /** Key under which dragged sizes are persisted. */
  tabId: string
}

export interface PmSplitLayoutSlots {
  /** Content of one pane; `index` points into `panes`. */
  pane?: (props: { index: number }) => unknown
}

export interface PmSplitLayoutExpose {
  /** Drops the saved sizes of this tab and returns to the layout defaults. */
  resetSizes: () => void
}
