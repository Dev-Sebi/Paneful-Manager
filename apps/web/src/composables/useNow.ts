import type { Ref } from 'vue'
import { getCurrentScope, onScopeDispose, ref } from 'vue'

const TICK_MS = 1000

const now = ref(Date.now())
let subscribers = 0
let timer: ReturnType<typeof setInterval> | undefined

/**
 * Shared clock for elapsed-time labels: one interval for the whole app, running only while something uses it.
 * @returns Reactive epoch milliseconds, refreshed every second.
 */
export function useNow (): Ref<number> {
  if (getCurrentScope()) {
    subscribers += 1
    now.value = Date.now()
    timer ??= setInterval(() => {
      now.value = Date.now()
    }, TICK_MS)
    onScopeDispose(() => {
      subscribers -= 1
      if (subscribers === 0 && timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    })
  }
  return now
}

/**
 * Formats a duration compactly: "12s", "3m", "1h 5m", "2d 3h".
 * @param ms - Elapsed milliseconds; negative values count as zero.
 * @returns Short label.
 */
export function formatElapsed (ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  }
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}
