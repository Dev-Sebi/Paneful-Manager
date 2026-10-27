import type { z } from 'zod'

/** Returns the issue paths of a failed parse, joined with dots. */
export function issuePaths(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input)
  if (result.success) {
    throw new Error('expected parse to fail')
  }
  return result.error.issues.map(issue => issue.path.map(String).join('.'))
}
