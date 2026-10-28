/** Visual emphasis of the button. */
export type PmButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

/** Height: sm 24px, md 28px, lg 32px. */
export type PmButtonSize = 'sm' | 'md' | 'lg'

export interface PmButtonProps {
  /** @default 'secondary' */
  variant?: PmButtonVariant
  /** @default 'md' */
  size?: PmButtonSize
  /** Native button type. @default 'button' */
  type?: 'button' | 'submit' | 'reset'
  /** @default false */
  disabled?: boolean
  /** Shows a spinner, sets aria-busy and blocks clicks while keeping focus. @default false */
  loading?: boolean
  /** Toggle state; renders aria-pressed when defined. @default undefined */
  pressed?: boolean
  /** Icon name rendered before the label. */
  prependIcon?: string
  /** Icon name rendered after the label. */
  appendIcon?: string
  /** Icon-only button; `ariaLabel` becomes required (not type-enforced; enforced as a runtime dev warning). */
  icon?: string
  /** Accessible name; required when `icon` is set. */
  ariaLabel?: string
  /** Keyboard shortcut hint shown in the tooltip and exposed via aria-keyshortcuts, e.g. 'Alt+Shift+N' (avoid browser-reserved combos such as Ctrl+T, Ctrl+W, Ctrl+Shift+T). */
  shortcut?: string
  /** Stretch to container width. @default false */
  block?: boolean
}

export interface PmButtonEmits {
  /** Not emitted while disabled or loading. */
  (e: 'click', event: MouseEvent | KeyboardEvent): void
}

export interface PmButtonSlots {
  /** Label content. */
  default?: () => unknown
  /** Replaces `prependIcon`. */
  prepend?: () => unknown
  /** Replaces `appendIcon`. */
  append?: () => unknown
}
