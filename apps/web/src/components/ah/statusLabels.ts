import type { AhStatusBadgeState } from './types'

/** Default visible text per session state. */
export const STATUS_LABELS: Record<AhStatusBadgeState, string> = {
  working: 'Working',
  waiting: 'Waiting for input',
  error: 'Error',
  idle: 'Idle',
}
