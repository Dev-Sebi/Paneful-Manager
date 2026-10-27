# AhStatusBadge

Shows the state of an agent session: working, waiting for input, error or idle. Used in tabs, pane headers, lists and team views. Contract: `index.d.ts`.

## Anatomy

```
dot:    [marker]
label:  ( [marker] Waiting for input )
```

- **Marker**: 8px (`size: sm` 6px). Shape differs per state so state is not conveyed by color alone.
- **Label pill** (variant `label`): background `color.bg.elevated`, padding x `space.2`, height 20px (`sm` 16px), gap `space.1`, radius `radius.full`.
- **Text**: `font.size.sm` (`sm`: `font.size.xs`), `font.weight.medium`, color `color.fg.primary`.

## States

| State | Marker color | Marker shape | Default label | Motion |
| --- | --- | --- | --- | --- |
| `working` | `color.status.working` | filled circle | Working | none |
| `waiting` | `color.status.waiting` | filled circle + 2px ring (halo) | Waiting for input | `pulse` once on entering the state, then static |
| `error` | `color.status.error` | filled square | Error | none |
| `idle` | `color.status.idle` | hollow circle (1.5px stroke) | Idle | none |

`color.status.success` is not a session state; it is used for toasts and completed tasks, not by this badge.

## Tokens

- Colors: `color.status.working`, `color.status.waiting`, `color.status.error`, `color.status.idle`, `color.bg.elevated`, `color.fg.primary`.
- Spacing and shape: `space.1`, `space.2`, `radius.full`.
- Font: `font.family.ui`, `font.size.xs`, `font.size.sm`, `font.weight.medium`, `font.line-height.tight`.
- Motion: pulse uses `motion.duration.slow` and `motion.easing.emphasized`; color changes use `motion.duration.fast` and `motion.easing.standard`.

## Behavior

- The pulse (`animate__animated animate__pulse`, one iteration) runs only on a transition **into** `waiting`, not on mount with an already-waiting state and never repeatedly. After `animationend` the class is removed and `attention-end` is emitted.
- State colors transition, the marker shape switches instantly.

## Accessibility

- `label` variant: text is visible, marker is `aria-hidden="true"`.
- `dot` variant: `role="img"` with `aria-label` (default label or `label` prop); tooltip shows the same text.
- `announce: true`: state changes are written to a polite live region ("api-server: waiting for input"). Use it on one badge per session (e.g. the pane header), not on every copy.
- Not focusable; it is information, not a control.
- Reduced motion: no pulse; the halo ring and color are the static cue. `attention-end` fires immediately.
- All marker colors keep at least 4.5:1 on `color.bg.surface` and `color.bg.elevated` in both themes (see design system README).

## Do / Don't

| Do | Don't |
| --- | --- |
| Pair color with marker shape or text | Rely on color alone |
| Pulse once when a session starts waiting | Loop the pulse or blink |
| Use `dot` inside tabs, `label` in headers | Put long text into the badge |
| Use `announce` on a single badge per session | Announce from every badge copy |
