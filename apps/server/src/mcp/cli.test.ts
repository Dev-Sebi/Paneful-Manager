import { describe, expect, it } from 'vitest'
import { appError } from '../files/test-helpers.js'
import { RunError } from '../process/exec.js'
import { CLI_CACHE_MS, createClaudeCli, scrub } from './cli.js'
import { createFakeRun } from './test-helpers.js'

describe('createClaudeCli', () => {
  it('detects the version and caches the result for 60 s', async () => {
    let time = 0
    const fake = createFakeRun('2.1.311')
    const cli = createClaudeCli({ env: {}, run: fake.run, now: () => time })
    expect(await cli.detect()).toEqual({ available: true, version: '2.1.311' })
    time = CLI_CACHE_MS - 1
    await cli.detect()
    expect(fake.calls).toHaveLength(1)
    time = CLI_CACHE_MS
    await cli.detect()
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[0]).toMatchObject({ file: 'claude', args: ['--version'] })
  })

  it('reports a missing CLI as unavailable', async () => {
    const cli = createClaudeCli({ env: {}, run: createFakeRun(null).run })
    expect(await cli.detect()).toEqual({ available: false })
  })

  it('passes argv as an array, in the scope directory, with CLAUDE_CONFIG_DIR and no shell option', async () => {
    const fake = createFakeRun('2.1.311')
    const cli = createClaudeCli({ env: { CLAUDE_CONFIG_DIR: '/cfg', SECRET: 'x' }, run: fake.run })
    await cli.addJson('files', { type: 'stdio', command: 'npx', args: ['-y', 'pkg; rm -rf ~'], env: {} }, 'local', '/p', [])
    await cli.remove('files', 'project', '/p')
    expect(fake.calls.map(call => call.args)).toEqual([
      ['mcp', 'add-json', '-s', 'local', 'files', '{"type":"stdio","command":"npx","args":["-y","pkg; rm -rf ~"],"env":{}}'],
      ['mcp', 'remove', '-s', 'project', 'files'],
    ])
    for (const call of fake.calls) {
      expect(call.file).toBe('claude')
      expect(call.options).toMatchObject({ cwd: '/p', env: { CLAUDE_CONFIG_DIR: '/cfg' } })
      expect(call.options).not.toHaveProperty('shell')
      expect(call.options.env).not.toHaveProperty('SECRET')
    }
  })

  it('turns CLI failures into 409 without leaking secrets', async () => {
    const fake = createFakeRun('2.1.311', () => {
      throw new RunError('claude exited with code 1', 'exit', 1, '', 'Invalid config {"API_KEY":"top-secret-value"}\nmore')
    })
    const cli = createClaudeCli({ env: {}, run: fake.run })
    const error = await appError(cli.addJson('x', { command: 'x' }, 'user', '/h', ['top-secret-value']))
    expect(error).toMatchObject({ statusCode: 409, code: 'conflict', details: { command: 'add-json', exitCode: 1 } })
    expect(error.message).toBe('claude mcp add-json failed: Invalid config {"API_KEY":"***"}')
  })

  it('wraps other rejections into a scrubbed 500', async () => {
    const fake = createFakeRun('2.1.311', () => {
      throw new TypeError('bad argument "top-secret-value"')
    })
    const cli = createClaudeCli({ env: {}, run: fake.run })
    const error = await appError(cli.addJson('x', { command: 'x' }, 'user', '/h', ['top-secret-value']))
    expect(error).toMatchObject({ statusCode: 500, code: 'internal' })
    expect(error.message).toBe('claude mcp add-json failed: bad argument "***"')
  })
})

describe('scrub', () => {
  it('replaces longer secrets first and ignores empty ones', () => {
    expect(scrub('abc abcdef', ['abc', 'abcdef', ''])).toBe('*** ***')
  })

  it('also replaces the JSON-escaped form', () => {
    const secret = 'pa"ss\\word'
    expect(scrub(JSON.stringify({ k: secret }), [secret])).toBe('{"k":"***"}')
  })
})
