/** Session state of an agent. */
export type PmStatusBadgeState = 'working' | 'waiting' | 'error' | 'idle'

/** dot: 8px marker only (tabs, lists). label: marker + text pill. */
export type PmStatusBadgeVariant = 'dot' | 'label'

export type PmStatusBadgeSize = 'sm' | 'md'

export interface PmStatusBadgeProps {
  state: PmStatusBadgeState
  /** @default 'label' */
  variant?: PmStatusBadgeVariant
  /** @default 'md' */
  size?: PmStatusBadgeSize
  /** Overrides the default text ('Working', 'Waiting for input', 'Error', 'Idle'). Used as aria-label for `dot`. */
  label?: string
  /** Announce state changes in a polite live region. @default false */
  announce?: boolean
}

export interface PmStatusBadgeEmits {
  /** Fired once the one-shot "waiting" pulse has finished (or immediately with reduced motion). */
  (e: 'attention-end'): void
}

export interface PmStatusBadgeSlots {
  /** Replaces the label text (variant 'label' only). */
  default?: () => unknown
}
