/**
 * Running sessions whose environment carries an outdated hook token. Their hooks get `401` and change nothing
 * (fail closed) until the session is restarted; the Settings view lists them through `GET /api/hooks/status`.
 */
export class StaleHookSessions {
  private readonly ids = new Set<string>()

  /** `isLive` tells whether the session still exists and runs; other ids are never kept. */
  constructor(private readonly isLive: (id: string) => boolean) {}

  mark(ids: Iterable<string>): void {
    for (const id of ids) {
      if (this.isLive(id)) {
        this.ids.add(id)
      }
    }
  }

  /** A hook with the current token arrived for this session. */
  clear(id: string): void {
    this.ids.delete(id)
  }

  /** Live stale sessions; ids of exited or removed sessions are dropped. */
  list(): string[] {
    for (const id of this.ids) {
      if (!this.isLive(id)) {
        this.ids.delete(id)
      }
    }
    return [...this.ids]
  }
}
