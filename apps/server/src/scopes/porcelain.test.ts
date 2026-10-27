import { describe, expect, it } from 'vitest'
import { parseWorktreeList } from './porcelain.js'

describe('parseWorktreeList', () => {
  it('parses a main checkout and two worktrees', () => {
    const out = [
      'worktree /repo\nHEAD aaa\nbranch refs/heads/main\n',
      'worktree /repo-a\nHEAD bbb\nbranch refs/heads/feat/a\n',
      'worktree /repo b\nHEAD ccc\nbranch refs/heads/b\n',
    ].join('\n')
    expect(parseWorktreeList(out).map(w => [w.path, w.branch])).toEqual([
      ['/repo', 'main'],
      ['/repo-a', 'feat/a'],
      ['/repo b', 'b'],
    ])
  })

  it('parses detached, locked, prunable and bare entries', () => {
    const out = [
      'worktree /bare\nbare\n',
      'worktree /d\nHEAD aaa\ndetached\n',
      'worktree /l\nHEAD bbb\nbranch refs/heads/l\nlocked reason here\n',
      'worktree /p\nHEAD ccc\ndetached\nprunable gitdir file points to non-existent location\n',
    ].join('\n')
    const [bare, detached, locked, prunable] = parseWorktreeList(out)
    expect(bare?.bare).toBe(true)
    expect(detached?.detached).toBe(true)
    expect(detached?.branch).toBeUndefined()
    expect(locked).toMatchObject({ locked: true, branch: 'l' })
    expect(prunable?.prunable).toBe(true)
  })

  it('handles empty output, CRLF and trailing blank lines', () => {
    expect(parseWorktreeList('')).toEqual([])
    expect(parseWorktreeList('worktree /r\r\nHEAD a\r\nbranch refs/heads/m\r\n\r\n\r\n')).toHaveLength(1)
  })
})
