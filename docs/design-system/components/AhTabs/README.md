# AhTabs / AhTab

Tab bar for terminal sessions and editors. Supports closable tabs, a dirty indicator, a status dot and keyboard reordering. Contract: `index.d.ts`.

## Anatomy

```
AhTabs: [ tab | tab | tab ... ][ append: + ]
AhTab:  [ status dot / icon | title | close (x) or dirty dot ]
         ^ active indicator: 2px bar on the bottom edge
```

- **Tablist**: `color.bg.surface`, bottom border `color.border.default`, height 32px (`density: compact` 28px).
- **Tab**: padding x `space.3`, gap `space.2`, max width 240px, min width 96px.
- **Active indicator**: 2px bar `color.accent.default`, moves on tab switch.
- **Close button**: 16px icon button, `radius.sm`.
- **Dirty dot**: 8px circle `color.fg.primary`; replaced by the close button on hover or focus of the tab.
- **Status dot**: `AhStatusBadge` with `variant="dot"`.

## States

| State | Background | Text | Other |
| --- | --- | --- | --- |
| Inactive | `color.bg.surface` | `color.fg.muted` | |
| Hover | `color.bg.hover` | `color.fg.primary` | close button visible |
| Active | `color.bg.canvas` | `color.fg.primary` | indicator `color.accent.default`, `font.weight.medium` |
| Focus-visible | unchanged | unchanged | 2px inset outline `color.border.focus` |
| Dirty | unchanged | unchanged | dirty dot instead of close icon |
| Disabled | `color.bg.surface` | `color.fg.disabled` | not focusable via arrows, not closable |
| Dragging / moving | `color.bg.elevated` | `color.fg.primary` | `shadow.2` |

Inactive closable tabs show the close button only on hover or focus; the active tab always shows it.

## Tokens

- Font: `font.family.ui`, `font.size.md`, `font.line-height.tight`.
- Radius: `radius.sm` on the close button; tabs are square.
- Motion: indicator and reorder use `motion.duration.fast` + `motion.easing.standard`; tab open `motion.duration.normal` + `motion.easing.decelerate`; tab close `motion.duration.fast` + `motion.easing.accelerate` (see `Motion.md`).
- Layering: tablist is `z.sticky` when the bar is sticky.

## Accessibility

- `AhTabs` → `role="tablist"`, `aria-label` from `ariaLabel`, `aria-orientation="horizontal"`.
- `AhTab` → `role="tab"`, `aria-selected`, `aria-controls` = `panelId`, `aria-disabled` when disabled. The panel has `role="tabpanel"` and `aria-labelledby` the tab.
- Roving tabindex: only the active tab has `tabindex="0"`; others `-1`. The close button has `tabindex="-1"` (keyboard closes via `Delete`).
- Accessible name: title plus state, e.g. "api-server, waiting for input, unsaved changes".
- Reorder and close announcements go to a polite live region: "Moved api-server to position 3 of 5", "Closed api-server".

### Keyboard map (focus on a tab)

| Key | Action |
| --- | --- |
| `ArrowLeft` / `ArrowRight` | Focus and activate previous / next tab (wraps) |
| `Home` / `End` | First / last tab |
| `Enter` / `Space` | Activate focused tab |
| `Delete` | Close focused tab (if closable); focus moves to the next tab, else previous |
| `Ctrl+Shift+ArrowLeft` / `Ctrl+Shift+ArrowRight` | Move focused tab one slot (if `reorderable`) |
| `Tab` | Leaves the tablist to the active tabpanel |
| Middle click | Close (pointer only) |

### Focus order

Tablist (active tab) → append actions → active tabpanel.

### Reduced motion

Indicator, reorder and open/close transitions are instant.

## Do / Don't

| Do | Don't |
| --- | --- |
| Keep titles short; show full title in tooltip | Wrap tab titles to two lines |
| Confirm closing a dirty tab with `AhDialog` | Close dirty tabs silently |
| Use the status dot for session state | Color the whole tab by status |
| Let the parent own order (`reorder` event) | Mutate the order inside AhTabs |
