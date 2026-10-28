import { createRequire } from 'node:module'

/** The release version lives in the root `package.json` (see docs/releasing.md); the workspace packages stay `0.0.0`. */
export const RELEASE_VERSION = (createRequire(import.meta.url)('../../../package.json') as { version: string }).version
