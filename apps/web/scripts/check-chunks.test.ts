import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findMonacoInEntry } from './check-chunks'

let dist = ''

function fakeDist (files: Record<string, string>): string {
  dist = mkdtempSync(join(tmpdir(), 'chunks-'))
  mkdirSync(join(dist, 'assets'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dist, name), content)
  }
  return dist
}

const HTML = '<script type="module" src="/assets/index-a.js"></script><link rel="modulepreload" href="/assets/vendor-b.js">'

afterEach(() => rmSync(dist, { recursive: true, force: true }))

describe('findMonacoInEntry', () => {
  it('passes when Monaco is only behind a dynamic import', () => {
    const dir = fakeDist({
      'index.html': HTML,
      'assets/index-a.js': 'import{x}from"./vendor-b.js";import("./monacoLoader-c.js")',
      'assets/vendor-b.js': 'export const x=1',
      'assets/monacoLoader-c.js': 'self.MonacoEnvironment={}',
    })
    expect(findMonacoInEntry(dir)).toEqual([])
  })

  it('flags Monaco in a statically imported chunk', () => {
    const dir = fakeDist({
      'index.html': HTML,
      'assets/index-a.js': 'import{x}from"./vendor-b.js"',
      'assets/vendor-b.js': 'import"./deep-d.js"',
      'assets/deep-d.js': 'monaco.editor.defineTheme()',
    })
    expect(findMonacoInEntry(dir)).toEqual(['assets/deep-d.js'])
  })

  it('flags Monaco in a modulepreload chunk', () => {
    const dir = fakeDist({
      'index.html': HTML,
      'assets/index-a.js': '',
      'assets/vendor-b.js': 'self.MonacoEnvironment={}',
    })
    expect(findMonacoInEntry(dir)).toEqual(['assets/vendor-b.js'])
  })
})
