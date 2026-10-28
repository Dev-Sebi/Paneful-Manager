# Motion

Paneful Manager is a dense tool people keep open all day. Motion exists to explain a change (something appeared, moved, needs attention), never to decorate.

## Principles

1. **Fast.** Nothing exceeds `motion.duration.slow` (240ms). Most transitions use `motion.duration.fast` (100ms).
2. **Subtle.** Opacity and small translations (max `space.2`, 8px). No scaling above 1.05, no rotation, no bounce, no overshoot.
3. **Never blocks input.** Keyboard and pointer input work during and after any animation. Terminal output is never animated.
4. **Attention is spent once.** Attention animations (pulse, headShake) run a single iteration and then stay static. No infinite loops, except the indeterminate spinner (`motion.duration.spinner` per rotation).
5. **Respects `prefers-reduced-motion: reduce`.** All transitions and animate.css animations are disabled (duration 0); state changes become instant. Attention cues fall back to a static visual (color, icon or text), never to nothing.
6. **Spinner exemption.** The indeterminate spinner (`.pm-spinner`) keeps rotating under reduced motion: it is essential progress feedback, small and non-translating (WCAG 2.3.3 allows essential motion).

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| `motion.duration.fast` | 100ms | Hover, focus, small state changes, tab switch, leaving elements |
| `motion.duration.normal` | 160ms | Entering elements: tabs, menus, toasts |
| `motion.duration.slow` | 240ms | Dialogs, one-shot attention cues |
| `motion.duration.spinner` | 800ms | One rotation of the indeterminate spinner (linear, infinite); the only exception to the 240ms ceiling |
| `motion.easing.standard` | `cubic-bezier(0.2, 0, 0, 1)` | Default for state changes |
| `motion.easing.emphasized` | `cubic-bezier(0.3, 0, 0, 1)` | Attention cues |
| `motion.easing.decelerate` | `cubic-bezier(0, 0, 0, 1)` | Elements entering the screen |
| `motion.easing.accelerate` | `cubic-bezier(0.3, 0, 1, 1)` | Elements leaving the screen |

animate.css durations are overridden per element with `--animate-duration: var(--pm-motion-duration-*)` and `animation-timing-function: var(--pm-motion-easing-*)`. The default animate.css duration (1s) is never used.

## Allowed animate.css set

Only these classes may be used. **Anything not on this list is forbidden**, including every bouncing, flipping, rotating, zooming, sliding-out-of-view, light-speed, back-, attention-seeker (other than the two below) and special animation.

| Class | Purpose |
| --- | --- |
| `animate__fadeIn` | Generic enter |
| `animate__fadeOut` | Generic leave |
| `animate__fadeInUp` | Enter from below (toasts) |
| `animate__fadeInDown` | Enter from above (menus, dropdowns) |
| `animate__pulse` | One-shot attention for a status badge |
| `animate__headShake` | One-shot rejection feedback (invalid input, blocked action); keyframes overridden to `translateX` only, see below |

Modifiers: only `animate__animated`. `animate__infinite`, `animate__repeat-*`, `animate__delay-*`, `animate__slow*` and `animate__fast*` are forbidden; use the duration tokens instead.
Keyframe overrides in the generated motion CSS (the stock keyframes are not used for these):

- `fadeInUp` / `fadeInDown`: stock translates by 100%; overridden to `space.2` (8px).
- `headShake`: stock combines `translateX` with `rotateY`; overridden to `translateX` only (max `space.1`, 4px), no rotation.
- `pulse`: stock scales to 1.05, kept as is (matches the scale ceiling).

## Use cases

| Use case | Enter | Leave | Duration | Easing | Reduced motion |
| --- | --- | --- | --- | --- | --- |
| Tab open | `fadeIn` | | `motion.duration.normal` | `motion.easing.decelerate` | Instant |
| Tab close | | `fadeOut`, then siblings shift via CSS width transition | `motion.duration.fast` | `motion.easing.accelerate` | Instant |
| Tab switch | Indicator moves with CSS `transform` transition | | `motion.duration.fast` | `motion.easing.standard` | Instant |
| Tab keyboard reorder | CSS `transform` transition to new slot | | `motion.duration.fast` | `motion.easing.standard` | Instant |
| Pane focus | Border color transition to `color.border.focus` | | `motion.duration.fast` | `motion.easing.standard` | Instant |
| Dialog enter | Scrim `fadeIn`, panel `fadeInDown` (8px) | | `motion.duration.slow` | `motion.easing.decelerate` | Instant |
| Dialog leave | | Scrim + panel `fadeOut` | `motion.duration.fast` | `motion.easing.accelerate` | Instant |
| Menu / dropdown | `fadeInDown` (8px) | `fadeOut` | `motion.duration.normal` / `motion.duration.fast` | decelerate / accelerate | Instant |
| Status badge becomes `waiting` | `pulse`, one iteration, then static | | `motion.duration.slow` | `motion.easing.emphasized` | No pulse; static waiting color and icon |
| Status badge other change | Color transition | | `motion.duration.fast` | `motion.easing.standard` | Instant |
| Toast | `fadeInUp` (8px) | `fadeOut` | `motion.duration.normal` / `motion.duration.fast` | decelerate / accelerate | Instant |
| Rejected action | `headShake` (translateX only), one iteration | | `motion.duration.slow` | `motion.easing.emphasized` | No shake; error text only |
| Hover / pressed | Background color transition | | `motion.duration.fast` | `motion.easing.standard` | Instant |
| Loading spinner | CSS `rotate` 360deg, infinite | | `motion.duration.spinner` per rotation | `linear` | Keeps rotating (exempt) |

## Reduced motion implementation

```css
@media (prefers-reduced-motion: reduce) {
  *:not(.pm-spinner), *::before, *::after {
    animation-duration: 0ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0ms !important;
  }
}
```

`.pm-spinner` is the only exemption (see principle 6). Any other looping element must not exist in the first place.

The app also exposes a user setting "Reduce motion" that applies the same rule via a root class, independent of the OS setting.
