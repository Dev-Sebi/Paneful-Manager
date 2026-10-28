/** Token-based accent palette; member colors from team files are never used as CSS. */
export const MEMBER_COLOR_TOKENS = [
  '--pm-color-accent-default',
  '--pm-color-status-waiting',
  '--pm-color-status-error',
  '--pm-color-status-success',
  '--pm-color-status-idle',
  '--pm-color-terminal-magenta',
  '--pm-color-terminal-cyan',
  '--pm-color-terminal-green',
] as const

/** Stable palette index for a member name (FNV-1a). */
export function memberColorIndex (name: string): number {
  let hash = 0x81_1C_9D_C5
  for (const char of name) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01_00_01_93) >>> 0
  }
  return hash % MEMBER_COLOR_TOKENS.length
}

export function memberColorVar (name: string): string {
  return `var(${MEMBER_COLOR_TOKENS[memberColorIndex(name)]})`
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400],
  ['hour', 3600],
  ['minute', 60],
]

/** "5 minutes ago" style text; seconds below a minute read "just now", `null` reads "never". */
export function relativeTime (iso: string | null, now: number = Date.now()): string {
  if (iso === null) {
    return 'never'
  }
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  if (Number.isNaN(seconds)) {
    return 'unknown'
  }
  if (Math.abs(seconds) < 60) {
    return 'just now'
  }
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) {
      return formatter.format(Math.trunc(seconds / size), unit)
    }
  }
  return 'just now'
}

/** Id usable inside an HTML id attribute. */
export function safeId (value: string): string {
  return value.replaceAll(/[^\w-]/g, '_')
}
