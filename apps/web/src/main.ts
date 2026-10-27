/**
 * main.ts
 *
 * Turns off zod's `new Function` probe, which the server's CSP (no 'unsafe-eval') reports as a violation,
 * then loads the app. zod builds schemas while its chunk loads, so `z.config()` would run too late and the
 * app is imported dynamically after the global zod reads is set.
 */
const holder = globalThis as { __zod_globalConfig?: Record<string, unknown> }
holder.__zod_globalConfig = { ...holder.__zod_globalConfig, jitless: true }

void import('./bootstrap')
