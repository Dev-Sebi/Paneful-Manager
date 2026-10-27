/* eslint-disable @typescript-eslint/unified-signatures -- overloads mirror the spec contract one to one */
/** Contract types mirroring docs/design-system/components/<Name>/index.d.ts. */

/* ---------- AhButton ---------- */

export type AhButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type AhButtonSize = 'sm' | 'md' | 'lg'

export interface AhButtonProps {
  variant?: AhButtonVariant
  size?: AhButtonSize
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
  loading?: boolean
  pressed?: boolean
  prependIcon?: string
  appendIcon?: string
  icon?: string
  ariaLabel?: string
  shortcut?: string
  block?: boolean
}

export interface AhButtonEmits {
  (e: 'click', event: MouseEvent | KeyboardEvent): void
}

/* ---------- AhStatusBadge ---------- */

export type AhStatusBadgeState = 'working' | 'waiting' | 'error' | 'idle'
export type AhStatusBadgeVariant = 'dot' | 'label'
export type AhStatusBadgeSize = 'sm' | 'md'

export interface AhStatusBadgeProps {
  state: AhStatusBadgeState
  variant?: AhStatusBadgeVariant
  size?: AhStatusBadgeSize
  label?: string
  announce?: boolean
}

export interface AhStatusBadgeEmits {
  (e: 'attention-end'): void
}

/* ---------- AhTabs / AhTab / AhTabPanel ---------- */

export type AhTabsDensity = 'compact' | 'default'

export interface AhTabsProps {
  modelValue?: string
  ariaLabel: string
  reorderable?: boolean
  closable?: boolean
  addable?: boolean
  density?: AhTabsDensity
}

export interface AhTabsReorderPayload {
  value: string
  from: number
  to: number
}

export interface AhTabsEmits {
  (e: 'update:modelValue', value: string): void
  (e: 'reorder', payload: AhTabsReorderPayload): void
  (e: 'close', value: string): void
  (e: 'add'): void
}

export interface AhTabProps {
  value: string
  title: string
  status?: AhStatusBadgeState
  dirty?: boolean
  closable?: boolean
  disabled?: boolean
  icon?: string
}

export interface AhTabEmits {
  (e: 'close', value: string): void
}

export interface AhTabPanelProps {
  value: string
  keepAlive?: boolean
}

/* ---------- AhDialog ---------- */

export type AhDialogTone = 'default' | 'danger'
export type AhDialogSize = 'sm' | 'md' | 'lg'

export interface AhDialogProps {
  modelValue: boolean
  title: string
  tone?: AhDialogTone
  size?: AhDialogSize
  persistent?: boolean
  blockedMessage?: string
  confirmText?: string
  cancelText?: string
  loading?: boolean
  initialFocus?: string
  closable?: boolean
}

export type AhDialogCloseReason = 'confirm' | 'cancel' | 'escape' | 'scrim' | 'close-button'

export interface AhDialogEmits {
  (e: 'update:modelValue', value: boolean): void
  (e: 'confirm'): void
  (e: 'cancel', reason: Exclude<AhDialogCloseReason, 'confirm'>): void
  (e: 'close-blocked'): void
  (e: 'after-leave'): void
}
