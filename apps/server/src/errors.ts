import type { ApiErrorCode } from '@paneful-manager/shared'

/** Error whose message is safe to show to API clients. */
export class AppError extends Error {
  override readonly name = 'AppError'

  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    readonly details?: unknown,
  ) {
    super(message)
  }
}
