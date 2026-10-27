# AhTerminalPane

> Implemented in `apps/web/src/components/ah/AhTerminalPane.vue` on top of xterm.js.

One terminal session inside the split layout: header with title, status and actions, plus the terminal viewport. Contract: `index.d.ts`.

## Anatomy

```
┌ header ────────────────────────────────────────────────────────┐
│ [status badge] title   ~/projects/api   [extra] [⇆] [⇅] [⤢] [x] │
├ viewport (xterm) ──────────────────────────────────────────────┤
│ $ ...                                                          │
│ overlay (connecting / exited / failed), centered               │
└────────────────────────────────────────────────────────────────┘
```

- **Pane**: background `color.terminal.bg`, border 1px `color.border.default`, `radius.sm`. Panes are separated by `space.1` gutters on `color.bg.canvas`.
- **Header**: height 28px, background `color.bg.surface`, padding x `space.2`, gap `space.2`. Title `font.size.sm`, `font.weight.medium`; cwd `font.size.xs` in `font.family.mono`, `color.fg.muted`, truncated from the start.
- **Header actions**: `AhButton variant="ghost" size="sm"` icon buttons in this DOM order: split vertical, split horizontal, maximize, close.
- **Split direction**: `vertical` = vertical divider, panes side by side (new pane to the right); `horizontal` = horizontal divider, panes stacked (new pane below).
- **Viewport**: padding `space.2`, `font.family.mono`, `font.size.md` (or `fontSize` prop, a px number because xterm takes numbers; the generator exposes the numeric value of `font.size.md` as its default), `font.line-height.normal`.
- **Overlay**: centered card `color.bg.elevated`, `radius.md`, `shadow.2`, text `color.fg.primary`, action `AhButton`.

## Terminal colors

The xterm.js `ITheme` is generated from `color.terminal.*` (dark or light per active theme). Kebab-case token names convert to camelCase (`bright-black` → `brightBlack`); `fg` → `foreground`, `bg` → `background`, `selection` → `selectionBackground`.
Used tokens: `color.terminal.fg`, `color.terminal.bg`, `color.terminal.cursor`, `color.terminal.selection`, and the 16 ANSI colors `color.terminal.black` … `color.terminal.bright-white`.

## States

| State | Visual |
| --- | --- |
| Focused | border `color.border.focus`, header title `color.fg.primary`, cursor blinks |
| Unfocused | border `color.border.default`, header title `color.fg.muted`, cursor outline only |
| Connecting | overlay "Connecting…" with indeterminate spinner |
| Connected | no overlay |
| Exited | overlay "Process exited (code N)" + "Restart" (`AhButton secondary`, emits `restart`); viewport kept for reading |
| Failed | non-blocking overlay "Session unavailable" in `color.status.error` text + "Retry" (re-attaches with scrollback; no `restart` emit) |
| Hidden | inactive tab: detached from the session (xterm kept mounted); re-attached with scrollback when shown |
| Maximized | pane covers the workspace at `z.overlay`; other panes stay mounted |
| Readonly | header shows "Read-only" label in `color.fg.muted`; no cursor |

## Tokens

- Colors: `color.terminal`, `color.bg.canvas`, `color.bg.surface`, `color.bg.elevated`, `color.fg.primary`, `color.fg.muted`, `color.border.default`, `color.border.focus`, `color.status.error`.
- Spacing and shape: `space.1`, `space.2`, `radius.sm`, `radius.md`, `shadow.2`.
- Font: `font.family.mono`, `font.family.ui`, `font.size.xs`, `font.size.sm`, `font.size.md`, `font.weight.medium`, `font.line-height.normal`.
- Motion: focus border `motion.duration.fast` + `motion.easing.standard`. Terminal output is never animated.

## Accessibility

- Pane container: `role="group"`, `aria-label` = "Terminal: {title}". Status announced through `AhStatusBadge` with `announce` (one badge per session).
- Viewport uses xterm.js with `screenReaderMode` controlled by a user setting; when on, xterm's accessibility tree and live region are active.
- Header actions are buttons with `aria-label` and shortcut hints (`aria-keyshortcuts`).
- Focus: clicking anywhere in the pane focuses the viewport. The header is a separate tab stop group before the viewport.

### Keyboard map

All keys go to the PTY while the viewport has focus, except the app-reserved shortcuts below. Defaults must avoid browser-reserved combos (e.g. `Ctrl+W`, `Ctrl+T`, `Ctrl+Shift+W`, `Ctrl+Shift+C`, `Alt+ArrowLeft/Right`, `F6`) and every shortcut must be user-configurable.

| Key | Action |
| --- | --- |
| `Ctrl+Insert` / `Shift+Insert` | Copy selection / paste (plus context menu) |
| `Alt+Shift+=` / `Alt+Shift+-` | Split vertical (side by side) / split horizontal (stacked) |
| `Ctrl+Shift+Enter` | Toggle maximize |
| `Ctrl+Alt+ArrowLeft/Right/Up/Down` | Move focus to the neighboring pane |
| `Ctrl+Shift+X` | Close pane (emits `close`) |
| `Ctrl+Shift+F6` | Cycle focus viewport → pane header → viewport (escape hatch, since `Tab` goes to the PTY) |

### Focus order

Within a pane: header actions (split vertical, split horizontal, maximize, close) → viewport. Then the next pane in layout reading order (left to right, top to bottom). Inside the viewport `Tab` goes to the PTY, so leaving it uses `Ctrl+Shift+F6` or `Ctrl+Alt+Arrow`.

### Reduced motion

Cursor blink is off; focus border change is instant.

## Do / Don't

| Do | Don't |
| --- | --- |
| Generate the xterm theme from tokens | Hard-code ANSI colors in the component |
| Keep the scrollback visible after exit | Clear the viewport when the process exits |
| Provide `Ctrl+Shift+F6` as a keyboard escape from the terminal | Trap keyboard users inside the viewport |
| Confirm closing a working/waiting session with `AhDialog tone="danger"` | Kill the session on a single click |
