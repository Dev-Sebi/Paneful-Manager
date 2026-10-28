# AhButton

Triggers an action. Wraps `v-btn` with Agent Hub variants and sizes. Contract: `index.d.ts`.

## Anatomy

```
[ prepend icon | label | append icon ]   (icon-only: [ icon ])
```

- **Container**: fill, border, radius, focus ring.
- **Prepend / append icon**: 16px, inherits label color.
- **Label**: single line, never wraps, truncates with ellipsis.
- **Spinner** (loading): replaces prepend icon, label stays for stable width.

## Variants

| Variant | Use | Fill | Text | Border |
| --- | --- | --- | --- | --- |
| `primary` | One main action per view or dialog | `color.accent.default` | `color.fg.on-accent` | none |
| `secondary` | Default, any other action | `color.bg.elevated` | `color.fg.primary` | `color.border.default` |
| `ghost` | Toolbars, tab bar actions, low emphasis | transparent | `color.fg.primary` | none |
| `danger` | Destructive actions (close session, delete preset) | `color.danger.default` | `color.fg.on-danger` | none |

## Sizes

| Size | Height | Padding x | Font size | Icon-only width |
| --- | --- | --- | --- | --- |
| `sm` | 24px (`space.6`) | `space.2` | `font.size.sm` | 24px |
| `md` | 28px | `space.3` | `font.size.md` | 28px |
| `lg` | 32px (`space.8`) | `space.4` | `font.size.md` | 32px |

## States

| State | Visual |
| --- | --- |
| Hover | primary: `color.accent.hover`; secondary and ghost: `color.bg.hover`; danger: `color.danger.hover` |
| Focus-visible | 2px outline `color.border.focus`, offset 2px |
| Pressed (`pressed: true`) | secondary/ghost fill `color.bg.selected` |
| Disabled | whole button at `opacity.disabled`, colors unchanged (no extra `color.fg.disabled`, to avoid double dimming), cursor not-allowed |
| Loading | `.ah-spinner` (one rotation per `motion.duration.spinner`), `aria-busy="true"`, clicks ignored |

## Tokens

- Radius: `radius.md`; gap between icon and label: `space.1` (sm) or `space.2` (md, lg).
- Font: `font.family.ui`, `font.weight.medium`, `font.line-height.tight`.
- Transition: background and border color, `motion.duration.fast`, `motion.easing.standard`.
- Elevation: `shadow.0` (buttons are flat).
- Disabled: `opacity.disabled`. Spinner: `motion.duration.spinner`.

## Accessibility

- Renders a native `<button>`; never a `div` with a click handler.
- Icon-only buttons require `ariaLabel`; the tooltip shows the same text.
- `pressed` defined → `aria-pressed`. `loading` → `aria-busy="true"`. `shortcut` → `aria-keyshortcuts`.
- Disabled uses the native `disabled` attribute. If the button must stay discoverable (explained by tooltip), use `aria-disabled="true"` and keep it focusable instead.
- Keyboard: `Enter` and `Space` activate. Focus order follows DOM order.
- Minimum hit area 24x24px (WCAG 2.5.8), satisfied by `sm`.
- Reduced motion: color transitions are instant; the spinner keeps rotating (explicit exemption in `Motion.md`, essential progress feedback).

## Do / Don't

| Do | Don't |
| --- | --- |
| One `primary` per dialog or view | Several primary buttons side by side |
| `danger` only for destructive, confirmed actions | `danger` for "Cancel" |
| Verb labels: "Start session", "Save preset" | "OK", "Yes" without context |
| `ghost` icon buttons in dense toolbars | Icon-only buttons without `ariaLabel` |
| Reference tokens for colors | Raw hex or Vuetify palette colors like `blue-darken-2` |
