import { parse, stringify } from 'yaml'

export interface Frontmatter {
  data: Record<string, unknown> | null
  body: string
  error?: string
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/

/** Splits a leading `---` YAML block from the markdown body. */
export function parseFrontmatter (text: string): Frontmatter {
  const match = FRONTMATTER.exec(text)
  if (!match) {
    return { data: null, body: text }
  }
  const body = text.slice(match[0].length)
  try {
    const data: unknown = parse(match[1] ?? '')
    if (data === null || data === undefined) {
      return { data: {}, body }
    }
    if (typeof data !== 'object' || Array.isArray(data)) {
      return { data: null, body, error: 'Frontmatter must be a YAML mapping' }
    }
    return { data: data as Record<string, unknown>, body }
  } catch (error) {
    return { data: null, body, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Builds a document from frontmatter data and body; empty data omits the block. */
export function stringifyFrontmatter (data: Record<string, unknown> | null, body: string): string {
  if (!data || Object.keys(data).length === 0) {
    return body
  }
  return `---\n${stringify(data).trimEnd()}\n---\n${body}`
}
