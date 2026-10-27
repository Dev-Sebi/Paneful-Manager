import type { AhStatusBadgeState } from '../AhStatusBadge'

/** Connection lifecycle of the underlying PTY. */
export type AhTerminalConnection = 'connecting' | 'connected' | 'exited' | 'failed'

/**
 * 'vertical': vertical divider, new pane to the right (side by side).
 * 'horizontal': horizontal divider, new pane below (stacked).
 */
export type AhTerminalSplitDirection = 'horizontal' | 'vertical'

export type AhTerminalCursorStyle = 'block' | 'bar' | 'underline'

export interface AhTerminalPaneProps {
  /** Backend session id the pane attaches to. */
  sessionId: string
  /** Header title, e.g. session or preset name. */
  title: string
  /** Working directory shown in the header (shortened with ~ for the home directory). */
  cwd?: string
  /** Agent state shown as AhStatusBadge in the header. */
  status?: AhStatusBadgeState
  /** @default 'connecting' */
  connection?: AhTerminalConnection
  /** Exit code shown in the exited overlay. */
  exitCode?: number
  /** Pane has keyboard focus within the split layout (controlled by the layout). @default false */
  focused?: boolean
  /** Pane fills the whole workspace. @default false */
  maximized?: boolean
  /** Font size as a px number (xterm needs a number). Default: numeric value of token font.size.md (13). Allowed range 10..24. */
  fontSize?: number
  /** @default 'block' */
  cursorStyle?: AhTerminalCursorStyle
  /** @default true */
  cursorBlink?: boolean
  /** Lines kept in the scrollback buffer. @default 5000 */
  scrollback?: number
  /** Input is not forwarded to the PTY (team views, replay). @default false */
  readonly?: boolean
  /** Hides the header (single-pane focus mode). @default false */
  hideHeader?: boolean
}

export interface AhTerminalResizePayload {
  cols: number
  rows: number
}

export interface AhTerminalPaneEmits {
  /** Pane received focus by click or keyboard. */
  (e: 'focus'): void
  /** Raw keyboard input for the PTY. Not emitted when readonly. */
  (e: 'input', data: string): void
  (e: 'resize', payload: AhTerminalResizePayload): void
  (e: 'split', direction: AhTerminalSplitDirection): void
  (e: 'toggle-maximize'): void
  /** User requested close; parent confirms if the agent is working or waiting. */
  (e: 'close'): void
  /** Restart request from the exited/failed overlay. */
  (e: 'restart'): void
  /** OSC title change from the running program. */
  (e: 'title-change', title: string): void
}

export interface AhTerminalPaneSlots {
  /** Extra header actions before split/maximize/close. */
  'header-actions'?: () => unknown
  /** Replaces the default overlay for connecting/exited/failed. */
  overlay?: (props: { connection: AhTerminalConnection, exitCode?: number }) => unknown
}

/** Imperative API exposed via template ref. */
export interface AhTerminalPaneExpose {
  write: (data: string) => void
  clear: () => void
  focus: () => void
  fit: () => void
  /** Selected text, empty string when nothing is selected. */
  getSelection: () => string
}
