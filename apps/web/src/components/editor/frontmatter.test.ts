import { describe, expect, it } from 'vitest'
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter'

describe('parseFrontmatter', () => {
  it('returns null data without a block', () => {
    expect(parseFrontmatter('# Title')).toEqual({ data: null, body: '# Title' })
  })

  it('parses data and body', () => {
    const result = parseFrontmatter('---\nname: review\ntools: [a, b]\n---\n# Body\n')
    expect(result.data).toEqual({ name: 'review', tools: ['a', 'b'] })
    expect(result.body).toBe('# Body\n')
    expect(result.error).toBeUndefined()
  })

  it('handles CRLF and an empty block', () => {
    expect(parseFrontmatter('---\r\nname: x\r\n---\r\nbody').data).toEqual({ name: 'x' })
    expect(parseFrontmatter('---\n---\nbody')).toEqual({ data: {}, body: 'body' })
  })

  it('reports invalid yaml', () => {
    const result = parseFrontmatter('---\nname: [unclosed\n---\nbody')
    expect(result.data).toBeNull()
    expect(result.error).toBeTruthy()
    expect(result.body).toBe('body')
  })

  it('requires the closing fence on its own line', () => {
    expect(parseFrontmatter('---\nname: x---\nbody')).toEqual({ data: null, body: '---\nname: x---\nbody' })
  })

  it('rejects non-mapping frontmatter', () => {
    expect(parseFrontmatter('---\n- a\n---\nbody').error).toMatch(/mapping/)
  })
})

describe('stringifyFrontmatter', () => {
  it('round-trips', () => {
    const text = stringifyFrontmatter({ name: 'review', n: 2 }, '# Body\n')
    expect(text).toBe('---\nname: review\nn: 2\n---\n# Body\n')
    expect(parseFrontmatter(text)).toEqual({ data: { name: 'review', n: 2 }, body: '# Body\n' })
  })

  it('omits the block for empty data', () => {
    expect(stringifyFrontmatter({}, 'body')).toBe('body')
    expect(stringifyFrontmatter(null, 'body')).toBe('body')
  })
})
