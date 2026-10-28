/** Pane actions bound to app-reserved keys; everything else goes to the PTY. */
export type PaneShortcutAction = 'copy' | 'split-vertical' | 'split-horizontal' | 'toggle-maximize' | 'close' | 'cycle-focus'

export interface PaneShortcut {
  action: PaneShortcutAction
  /** `KeyboardEvent.code`, so Alt+Shift combos match regardless of the produced character. */
  code: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  /** Label for tooltips and `aria-keyshortcuts`. */
  label: string
}

/** Defaults from the PmTerminalPane spec; they avoid browser-reserved combos. Kept as data so a settings UI can override them. */
export const PANE_SHORTCUTS: readonly PaneShortcut[] = [
  { action: 'copy', code: 'Insert', ctrl: true, label: 'Control+Insert' },
  { action: 'split-vertical', code: 'Equal', alt: true, shift: true, label: 'Alt+Shift+=' },
  { action: 'split-horizontal', code: 'Minus', alt: true, shift: true, label: 'Alt+Shift+-' },
  { action: 'toggle-maximize', code: 'Enter', ctrl: true, shift: true, label: 'Control+Shift+Enter' },
  { action: 'close', code: 'KeyX', ctrl: true, shift: true, label: 'Control+Shift+X' },
  { action: 'cycle-focus', code: 'F6', ctrl: true, shift: true, label: 'Control+Shift+F6' },
]

export function matchShortcut (event: KeyboardEvent, shortcuts: readonly PaneShortcut[] = PANE_SHORTCUTS): PaneShortcut | undefined {
  return shortcuts.find(shortcut => shortcut.code === event.code
    && Boolean(shortcut.ctrl) === event.ctrlKey
    && Boolean(shortcut.alt) === event.altKey
    && Boolean(shortcut.shift) === event.shiftKey
    && !event.metaKey)
}

export function shortcutLabel (action: PaneShortcutAction): string | undefined {
  return PANE_SHORTCUTS.find(shortcut => shortcut.action === action)?.label
}
