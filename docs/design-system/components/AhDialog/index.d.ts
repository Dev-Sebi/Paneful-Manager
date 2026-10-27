/** danger: destructive confirmation; title icon and confirm button use danger tokens. */
export type AhDialogTone = 'default' | 'danger'

/** Max width: sm 400px, md 560px, lg 800px. */
export type AhDialogSize = 'sm' | 'md' | 'lg'

export interface AhDialogProps {
  /** Open state (v-model). */
  modelValue: boolean
  /** Visible heading; also the accessible name via aria-labelledby. */
  title: string
  /** @default 'default' */
  tone?: AhDialogTone
  /** @default 'md' */
  size?: AhDialogSize
  /** Scrim click and Escape do not close; a headShake plays instead. @default false */
  persistent?: boolean
  /** Confirm button label; omit to hide the default actions. */
  confirmText?: string
  /** @default 'Cancel' */
  cancelText?: string
  /** Shows a spinner on the confirm button and blocks closing. @default false */
  loading?: boolean
  /** CSS selector inside the dialog that receives initial focus. Defaults to the first focusable element in the body, else cancel (danger) or confirm (default). */
  initialFocus?: string
  /** Shows the close (x) button in the header. Hidden when persistent. @default true */
  closable?: boolean
}

export type AhDialogCloseReason = 'confirm' | 'cancel' | 'escape' | 'scrim' | 'close-button'

export interface AhDialogEmits {
  (e: 'update:modelValue', value: boolean): void
  (e: 'confirm'): void
  (e: 'cancel', reason: Exclude<AhDialogCloseReason, 'confirm'>): void
  /** Escape or scrim click on a persistent dialog. */
  (e: 'close-blocked'): void
  /** Leave animation finished; focus has returned to the opener. */
  (e: 'after-leave'): void
}

export interface AhDialogSlots {
  /** Body content. */
  default?: () => unknown
  /** Replaces the title text (keep it short). */
  title?: () => unknown
  /** Replaces the default actions (cancel + confirm). */
  actions?: (props: { confirm: () => void, cancel: () => void }) => unknown
}
