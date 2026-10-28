import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RELEASE_VERSION } from './version.js'

describe('RELEASE_VERSION', () => {
  it('is the version of the root package.json', () => {
    const root = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(RELEASE_VERSION).toBe(root.version)
  })
})
