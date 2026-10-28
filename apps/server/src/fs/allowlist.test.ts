import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppError } from '../errors.js'
import { createAllowlist, type Allowlist } from './allowlist.js'

let base: string
let root: string
let outside: string
let allowlist: Allowlist

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'paneful-manager-allowlist-')))
  root = join(base, 'root')
  outside = join(base, 'outside')
  mkdirSync(join(root, 'sub'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(root, 'sub', 'file.md'), 'x')
  writeFileSync(join(outside, 'secret.md'), 'x')
  symlinkSync(outside, join(root, 'escape'))
  symlinkSync(join(root, 'sub'), join(root, 'inner'))
  symlinkSync(join(outside, 'missing'), join(root, 'dangling'))
  mkdirSync(`${root}-sibling`)
  allowlist = createAllowlist([root])
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

function expectForbidden(candidate: string): void {
  try {
    allowlist.resolveInside(candidate)
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({ statusCode: 403, code: 'forbidden' })
    return
  }
  throw new Error(`expected ${candidate} to be rejected`)
}

describe('createAllowlist', () => {
  it('accepts the root itself and files inside it', () => {
    expect(allowlist.resolveInside(root)).toBe(root)
    expect(allowlist.resolveInside(join(root, 'sub', 'file.md'))).toBe(join(root, 'sub', 'file.md'))
  })

  it('rejects traversal out of the root', () => {
    expectForbidden(`${root}/../outside/secret.md`)
    expectForbidden(`${root}/sub/../../outside`)
    expectForbidden(`${root}-sibling`)
    expectForbidden('/etc/passwd')
  })

  it('normalizes .. that stays inside', () => {
    expect(allowlist.resolveInside(`${root}/sub/../sub/file.md`)).toBe(join(root, 'sub', 'file.md'))
  })

  it('rejects symlink escapes, also for files that do not exist yet', () => {
    expectForbidden(join(root, 'escape'))
    expectForbidden(join(root, 'escape', 'secret.md'))
    expectForbidden(join(root, 'escape', 'new.md'))
  })

  it('resolves symlinks that stay inside to their target', () => {
    expect(allowlist.resolveInside(join(root, 'inner', 'file.md'))).toBe(join(root, 'sub', 'file.md'))
  })

  it('accepts a not-yet-existing file in an allowed dir', () => {
    expect(allowlist.resolveInside(join(root, 'sub', 'new', 'deep.md'))).toBe(join(root, 'sub', 'new', 'deep.md'))
    expect(allowlist.resolveInside(join(root, 'inner', 'new.md'))).toBe(join(root, 'sub', 'new.md'))
  })

  it('rejects dangling links, NUL bytes, relative and empty paths', () => {
    expectForbidden(join(root, 'dangling'))
    expectForbidden(join(root, 'dangling', 'x.md'))
    expectForbidden(`${root}/sub/file.md\0.txt`)
    expectForbidden('sub/file.md')
    expectForbidden('')
  })

  it('resolves roots through symlinks and ignores missing roots', () => {
    const viaLink = createAllowlist([join(root, 'inner'), join(base, 'nope')])
    expect(viaLink.resolveInside(join(root, 'sub', 'file.md'))).toBe(join(root, 'sub', 'file.md'))
    expect(() => viaLink.resolveInside(join(base, 'nope', 'x.md'))).toThrow(AppError)
  })
})
