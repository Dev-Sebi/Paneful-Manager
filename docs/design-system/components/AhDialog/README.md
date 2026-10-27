# AhDialog

Modal dialog for confirmations and short forms (close dirty session, delete preset, edit MCP server). Wraps `v-dialog`. Contract: `index.d.ts`.

## Anatomy

```
scrim
└─ panel
   ├─ header:  [ tone icon (danger) | title | close (x) ]
   ├─ body:    default slot, scrolls when too tall
   └─ actions: [ cancel (secondary) | confirm (primary or danger) ]  right-aligned
```

- **Scrim**: `color.bg.scrim` at 60% opacity, layer `z.overlay`.
- **Panel**: `color.bg.elevated`, border 1px `color.border.default`, `radius.lg`, `shadow.3`, layer `z.modal`, max height 80vh, max width per `size`.
- **Header**: padding `space.4` `space.4` `space.2`, title `font.size.lg`, `font.weight.semibold`, `color.fg.primary`.
- **Body**: padding x `space.4`, text `font.size.md`, `font.line-height.normal`, secondary text `color.fg.muted`.
- **Actions**: padding `space.4`, gap `space.2`, `AhButton` size `md`.

## States and tones

| State | Visual / behavior |
| --- | --- |
| `tone: default` | Confirm is `AhButton variant="primary"` |
| `tone: danger` | Header icon in `color.danger.default`; confirm is `AhButton variant="danger"`; initial focus on cancel |
| `persistent` | Escape and scrim click emit `close-blocked` and play `headShake` once on the panel; close (x) hidden |
| `loading` | Confirm shows spinner, all close paths blocked, body `aria-busy="true"` |
| Body overflow | Body scrolls; header and actions stay fixed; divider `color.border.default` appears |

## Tokens

- Colors: `color.bg.elevated`, `color.fg.primary`, `color.fg.muted`, `color.border.default`, `color.border.focus`, `color.danger.default`, `color.bg.scrim`.
- Spacing and shape: `space.2`, `space.4`, `radius.lg`, `shadow.3`.
- Layers: `z.overlay` (scrim), `z.modal` (panel).
- Font: `font.family.ui`, `font.size.md`, `font.size.lg`, `font.weight.semibold`, `font.line-height.normal`.
- Motion: enter `motion.duration.slow` + `motion.easing.decelerate` (scrim `fadeIn`, panel `fadeInDown` 8px); leave `motion.duration.fast` + `motion.easing.accelerate` (`fadeOut`). See `Motion.md`.

## Accessibility

- Panel: `role="dialog"` (`role="alertdialog"` for `tone: danger`), `aria-modal="true"`, `aria-labelledby` = title id, `aria-describedby` = body id when the body is plain text.
- **Focus trap**: `Tab` / `Shift+Tab` cycle inside the panel; content behind is `inert`.
- **Initial focus**: `initialFocus` selector, else first focusable element in the body, else cancel (danger) or confirm (default). Never the close (x) button.
- **Focus return**: on close, focus returns to the element that opened the dialog (or the active tab if it no longer exists).
- Terminal panes behind the dialog must not receive keystrokes while it is open.

### Keyboard map

| Key | Action |
| --- | --- |
| `Escape` | Cancel (reason `escape`); persistent → `close-blocked` |
| `Tab` / `Shift+Tab` | Next / previous focusable element, wraps inside the dialog |
| `Enter` | Activates the focused button; in a single-line input it triggers confirm (not in `tone: danger`) |
| `Ctrl+Enter` | Confirm from anywhere in the dialog (not in `tone: danger`) |

### Focus order

Body fields → cancel → confirm → close (x).

### Reduced motion

No fade or shake; dialog appears and disappears instantly. `close-blocked` still fires; the blocked close is communicated by the unchanged dialog only.

## Do / Don't

| Do | Don't |
| --- | --- |
| Name the action in the confirm label ("Close session") | "OK" / "Yes" |
| Use `tone: danger` for destructive actions and focus cancel | Focus the danger button by default |
| Keep dialogs short; one task per dialog | Nest dialogs |
| Use `persistent` only while unsaved input would be lost | Make every dialog persistent |
