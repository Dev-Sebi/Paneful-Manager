import type { PmStatusBadgeState } from '../PmStatusBadge'

/** Connection lifecycle of the underlying PTY. */
export type PmTerminalConnection = 'connecting' | 'connected' | 'exited' | 'failed'

/**
 * 'vertical': vertical divider, new pane to the right (side by side).
 * 'horizontal': horizontal divider, new pane below (stacked).
 */
export type PmTerminalSplitDirection = 'horizontal' | 'vertical'

export type PmTerminalCursorStyle = 'block' | 'bar' | 'underline'

export interface PmTerminalPaneProps {
  /** Backend session id the pane attaches to. */
  sessionId: string
  /** Header title, e.g. session or preset name. */
  title: string
  /** Working directory shown in the header (shortened with ~ for the home directory). */
  cwd?: string
  /** Agent state shown as PmStatusBadge in the header. */
  status?: PmStatusBadgeState
  /** ISO time the session entered its current state; the header shows "<state> <elapsed>" (e.g. "idle 3m") after the title. */
  stateSince?: string
  /** 'exited' and 'failed' override the pane's live binding; otherwise the binding decides. @default 'connecting' */
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
  /** Restart request from the exited overlay. The failed overlay's Retry re-attaches internally instead. */
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
  overlay?: (props: { connection: PmTerminalConnection, exitCode?: number }) => unknown
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
