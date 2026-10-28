# PmTabs / PmTab / PmTabPanel

Tab bar for terminal sessions and editors. Supports closable tabs, a dirty indicator, a status dot and keyboard reordering. Contract: `index.d.ts`.

## Anatomy

```
PmTabs:      ul[role=tablist] > li[role=none] ... + append actions (outside the ul)
PmTab:       li[role=none]
             ├─ element[role=tab]  [ status dot / icon | title ]
             └─ button.close       (x) or dirty dot   <- sibling, last in DOM
                ^ active indicator: 2px bar on the bottom edge of the li
PmTabPanel:  div[role=tabpanel]
```

The close button is never inside the `role="tab"` element (a tab must not contain interactive children). It is the last child of the `li`, so DOM order equals visual order and focus order.

- **Tablist**: `color.bg.surface`, bottom border `color.border.default`, height 32px (`density: compact` 28px).
- **Tab wrapper (`li`)**: padding x `space.3`, gap `space.2`, max width 240px, min width 96px. Carries background, hover and indicator; the tab element fills it except the close button area.
- **Active indicator**: 2px bar `color.accent.default`, moves on tab switch.
- **Close button**: 16px icon button, `radius.sm`, `aria-label="Close <title>"`, `tabindex="-1"`.
- **Dirty dot**: 8px circle `color.fg.primary`; replaced by the close button on hover or focus of the tab.
- **Status dot**: `PmStatusBadge` with `variant="dot"`.

## States

| State | Background | Text | Other |
| --- | --- | --- | --- |
| Inactive | `color.bg.surface` | `color.fg.muted` | |
| Hover | `color.bg.hover` | `color.fg.primary` | close button visible |
| Active | `color.bg.canvas` | `color.fg.primary` | indicator `color.accent.default`, `font.weight.medium` |
| Focus-visible | unchanged | unchanged | 2px inset outline `color.border.focus` on the `li` (via `:focus-within` of the tab element) |
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

- `PmTabs` → `role="tablist"`, `aria-label` from `ariaLabel`, `aria-orientation="horizontal"`.
- `li` wrappers → `role="none"`, so the tablist owns the tabs directly.
- Tab element → `role="tab"`, `id="pm-tab-<value>"`, `aria-selected`, `aria-controls="pm-tabpanel-<value>"`, `aria-disabled` when disabled.
- `PmTabPanel` → `role="tabpanel"`, `id="pm-tabpanel-<value>"`, `aria-labelledby="pm-tab-<value>"`; `tabindex="0"` only when the panel has no focusable content. Inactive panels stay mounted (`keepAlive`) and get `hidden`.
- Roving tabindex: only the active tab has `tabindex="0"`; others `-1`. The close button has `tabindex="-1"` and is reached by keyboard through `Delete` / `Backspace` on the focused tab.
- Activation is automatic (arrow keys activate), because switching sessions is cheap and instant; no separate "focus without activate" mode.
- Accessible name: title plus state, e.g. "api-server, waiting for input, unsaved changes".
- Reorder and close announcements go to a polite live region: "Moved api-server to position 3 of 5", "Closed api-server".

### Keyboard map (focus on a tab)

| Key | Action |
| --- | --- |
| `ArrowLeft` / `ArrowRight` | Focus and activate previous / next tab (wraps) |
| `Home` / `End` | First / last tab |
| `Enter` / `Space` | Activate focused tab |
| `Delete` or `Backspace` | Close focused tab (if closable); focus moves to the next tab, else previous |
| `Ctrl+Shift+ArrowLeft` / `Ctrl+Shift+ArrowRight` | Move focused tab one slot (if `reorderable`) |
| `Tab` | Leaves the tablist: append actions first, then the active tabpanel |
| Middle click | Close (pointer only) |

### Focus order

Active tab (single tab stop for the whole tablist; close buttons are skipped) → append actions → active tabpanel content.

### Reduced motion

Indicator, reorder and open/close transitions are instant.

## Do / Don't

| Do | Don't |
| --- | --- |
| Keep titles short; show full title in tooltip | Wrap tab titles to two lines |
| Confirm closing a dirty tab with `PmDialog` | Close dirty tabs silently |
| Use the status dot for session state | Color the whole tab by status |
| Let the parent own order (`reorder` event) | Mutate the order inside PmTabs |
