/** Session state of an agent. */
export type AhStatusBadgeState = 'working' | 'waiting' | 'error' | 'idle'

/** dot: 8px marker only (tabs, lists). label: marker + text pill. */
export type AhStatusBadgeVariant = 'dot' | 'label'

export type AhStatusBadgeSize = 'sm' | 'md'

export interface AhStatusBadgeProps {
  state: AhStatusBadgeState
  /** @default 'label' */
  variant?: AhStatusBadgeVariant
  /** @default 'md' */
  size?: AhStatusBadgeSize
  /** Overrides the default text ('Working', 'Waiting for input', 'Error', 'Idle'). Used as aria-label for `dot`. */
  label?: string
  /** Announce state changes in a polite live region. @default false */
  announce?: boolean
}

export interface AhStatusBadgeEmits {
  /** Fired once the one-shot "waiting" pulse has finished (or immediately with reduced motion). */
  (e: 'attention-end'): void
}

export interface AhStatusBadgeSlots {
  /** Replaces the label text (variant 'label' only). */
  default?: () => unknown
}
