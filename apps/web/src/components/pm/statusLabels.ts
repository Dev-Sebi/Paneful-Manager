import type { PmStatusBadgeState } from './types'

/** Default visible text per session state. */
export const STATUS_LABELS: Record<PmStatusBadgeState, string> = {
  working: 'Working',
  waiting: 'Waiting for input',
  error: 'Error',
  idle: 'Idle',
}
