import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpHealthResult, McpServerEntry } from '@agent-hub/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkMcpHealth, createHealthRunner, expandVars } from './health.js'

const FIXTURE = fileURLToPath(new URL('./test-fixtures/fake-mcp-stdio.mjs', import.meta.url))
const SECRET = 'sk-health-0123456789'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-hub-health-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function stdioEntry(env: Record<string, string> = {}, scope: McpServerEntry['scope'] = { kind: 'user' }, name = 'fake'): McpServerEntry {
  return { name, scope, source: 'file', config: { transport: 'stdio', command: process.execPath, args: [FIXTURE], env } }
}

function remoteEntry(transport: 'http' | 'sse', url: string, headers: Record<string, string> = {}): McpServerEntry {
  return { name: 'remote', scope: { kind: 'user' }, source: 'file', config: { transport, url, headers } }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!alive(pid)) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

const dumpOf = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { cwd: string; env: Record<string, string>; pid: number }

describe('expandVars', () => {
  it('expands variables and defaults', () => {
    const env = { A: 'a', EMPTY: '' }
    expect(expandVars('x-${A}-${MISSING}-${MISSING:-d}-${EMPTY:-e}', env)).toBe('x-a--d-e')
  })
})

describe('stdio health check', () => {
  it('reports ok with latency, server info and protocol version', async () => {
    const result = await checkMcpHealth(stdioEntry({ FAKE_MCP_DELAY_MS: '100' }), { timeoutMs: 5000 })
    expect(result).toMatchObject({ status: 'ok', serverInfo: { name: 'fake-mcp', version: '1.2.3' }, protocolVersion: '2025-06-18' })
    expect(result.latencyMs).toBeGreaterThanOrEqual(90)
    expect(result.error).toBeUndefined()
  })

  it('reports error with the exit code when the server exits early', async () => {
    const result = await checkMcpHealth(stdioEntry({ FAKE_MCP_FAIL: '1' }), { timeoutMs: 5000 })
    expect(result.status).toBe('error')
    expect(result.error).toContain('exited with code 2')
  })

  it('reports error for a missing command', async () => {
    const entry = stdioEntry()
    const missing: McpServerEntry = { ...entry, config: { transport: 'stdio', command: join(dir, 'nope'), args: [], env: {} } }
    const result = await checkMcpHealth(missing, { timeoutMs: 5000 })
    expect(result.status).toBe('error')
    expect(result.error).toContain('Could not start server')
  })

  it('times out within the deadline and kills the process group', async () => {
    const dump = join(dir, 'dump.json')
    const started = Date.now()
    const result = await checkMcpHealth(stdioEntry({ FAKE_MCP_HANG: '1', FAKE_MCP_DUMP: dump }), { timeoutMs: 600 })
    expect(result.status).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(800)
    const { pid } = dumpOf(dump)
    expect(await waitGone(pid)).toBe(true)
  })

  it('kills the process group after an ok result too', async () => {
    const dump = join(dir, 'dump.json')
    await checkMcpHealth(stdioEntry({ FAKE_MCP_DUMP: dump }), { timeoutMs: 5000 })
    expect(await waitGone(dumpOf(dump).pid)).toBe(true)
  })

  it('reports error for invalid JSON and for JSON-RPC errors', async () => {
    const garbage = await checkMcpHealth(stdioEntry({ FAKE_MCP_GARBAGE: '1' }), { timeoutMs: 5000 })
    expect(garbage).toMatchObject({ status: 'error', error: 'Server wrote invalid JSON to stdout' })
    const rpc = await checkMcpHealth(stdioEntry({ FAKE_MCP_RPC_ERROR: '1' }), { timeoutMs: 5000 })
    expect(rpc.status).toBe('error')
    expect(rpc.error).toContain('-32602')
  })

  it('expands variables from the given env and passes only the base env', async () => {
    const dump = join(dir, 'dump.json')
    const entry = stdioEntry({ FAKE_MCP_DUMP: dump, TOKEN: '${HEALTH_TEST_TOKEN}', FALLBACK: '${HEALTH_TEST_MISSING:-fb}' })
    const result = await checkMcpHealth(entry, { timeoutMs: 5000, env: { PATH: process.env.PATH, HEALTH_TEST_TOKEN: 'expanded', HEALTH_TEST_OTHER: 'leak' } })
    expect(result.status).toBe('ok')
    const { env } = dumpOf(dump)
    expect(env).toMatchObject({ TOKEN: 'expanded', FALLBACK: 'fb' })
    expect(env.HEALTH_TEST_OTHER).toBeUndefined()
  })

  it('runs in the project for project and local scopes and in home for user scope', async () => {
    const project = join(dir, 'project')
    const home = join(dir, 'home')
    mkdirSync(project)
    mkdirSync(home)
    const dump = join(dir, 'dump.json')
    await checkMcpHealth(stdioEntry({ FAKE_MCP_DUMP: dump }, { kind: 'local', projectPath: project }), { timeoutMs: 5000, home })
    expect(dumpOf(dump).cwd).toBe(realpathSync(project))
    await checkMcpHealth(stdioEntry({ FAKE_MCP_DUMP: dump }), { timeoutMs: 5000, home })
    expect(dumpOf(dump).cwd).toBe(realpathSync(home))
  })

  it('scrubs env values from the error text', async () => {
    const result = await checkMcpHealth(stdioEntry({ FAKE_MCP_FAIL: '1', API_KEY: SECRET, FAKE_MCP_STDERR: `bad key ${SECRET}` }), { timeoutMs: 5000 })
    expect(result.status).toBe('error')
    expect(result.error).toContain('***')
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('limits the error to 200 characters', async () => {
    const result = await checkMcpHealth(stdioEntry({ FAKE_MCP_FAIL: '1', FAKE_MCP_STDERR: 'x'.repeat(5000) }), { timeoutMs: 5000 })
    expect(result.error?.length).toBeLessThanOrEqual(200)
  })
})

interface Seen {
  headers: IncomingMessage['headers']
  body: string
  method: string
}

describe('http and sse health checks', () => {
  let server: Server | undefined
  let seen: Seen[]
  let streams: ServerResponse[]

  const initResult = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-http', version: '9.9' } }

  async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  async function serve(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void): Promise<string> {
    const created = createServer((request, response) => {
      void readBody(request).then(body => {
        seen.push({ headers: request.headers, body, method: request.method ?? '' })
        handler(request, response, body)
      })
    })
    server = created
    await new Promise<void>(resolve => created.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(created.address() as AddressInfo).port}`
  }

  const answer = (body: string): string => JSON.stringify({ jsonrpc: '2.0', id: (JSON.parse(body) as { id: number }).id, result: initResult })

  beforeEach(() => {
    seen = []
    streams = []
  })

  afterEach(async () => {
    for (const stream of streams) {
      stream.destroy()
    }
    server?.closeAllConnections()
    await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)))
    server = undefined
  })

  it('accepts a JSON answer and sends expanded headers', async () => {
    const base = await serve((_request, response, body) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(answer(body))
    })
    const entry = remoteEntry('http', `${base}/mcp`, { Authorization: 'Bearer ${HEALTH_TEST_TOKEN}' })
    const result = await checkMcpHealth(entry, { timeoutMs: 3000, env: { HEALTH_TEST_TOKEN: SECRET } })
    expect(result).toMatchObject({ status: 'ok', serverInfo: { name: 'fake-http', version: '9.9' }, protocolVersion: '2025-06-18' })
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(seen[0]?.headers.accept).toBe('application/json, text/event-stream')
    expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({ method: 'initialize', params: { clientInfo: { name: 'agent-hub' } } })
  })

  it('accepts an SSE answer and ends the session', async () => {
    const base = await serve((request, response, body) => {
      if (request.method === 'DELETE') {
        response.writeHead(204).end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'abc' })
      response.write(`event: message\ndata: ${answer(body)}\n\n`)
    })
    const result = await checkMcpHealth(remoteEntry('http', `${base}/mcp`), { timeoutMs: 3000 })
    expect(result.status).toBe('ok')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(seen.some(call => call.method === 'DELETE' && call.headers['mcp-session-id'] === 'abc')).toBe(true)
  })

  it('reports error for a 500 without leaking the header value', async () => {
    const base = await serve((_request, response) => {
      response.writeHead(500).end(`boom ${SECRET}`)
    })
    const result = await checkMcpHealth(remoteEntry('http', base, { 'X-Key': SECRET }), { timeoutMs: 3000 })
    expect(result).toMatchObject({ status: 'error', error: 'HTTP 500' })
  })

  it('reports error for invalid JSON and for redirects', async () => {
    const base = await serve((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: 'http://127.0.0.1:1/' }).end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('nope')
    })
    expect((await checkMcpHealth(remoteEntry('http', `${base}/x`), { timeoutMs: 3000 })).error).toBe('Server sent invalid JSON')
    expect((await checkMcpHealth(remoteEntry('http', `${base}/redirect`), { timeoutMs: 3000 })).error).toBe('HTTP 302')
  })

  it('reports error when the connection is refused', async () => {
    const base = await serve(() => undefined)
    await new Promise(resolve => server?.close(resolve))
    server = undefined
    const result = await checkMcpHealth(remoteEntry('http', `${base}/mcp`), { timeoutMs: 3000 })
    expect(result.status).toBe('error')
    expect(result.error).toContain('Connection failed')
  })

  it('times out on a slow server', async () => {
    const base = await serve((_request, response) => {
      streams.push(response)
    })
    const started = Date.now()
    const result = await checkMcpHealth(remoteEntry('http', `${base}/mcp`), { timeoutMs: 300 })
    expect(result.status).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('is unsupported when the url is not http(s) after expansion', async () => {
    const result = await checkMcpHealth(remoteEntry('http', '${HEALTH_TEST_MISSING}'), { timeoutMs: 1000, env: {} })
    expect(result.status).toBe('unsupported')
  })

  it('handles legacy SSE with the answer on the event stream', async () => {
    const base = await serve((request, response, body) => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('event: endpoint\ndata: /messages?sessionId=1\n\n')
        streams.push(response)
        return
      }
      response.writeHead(202).end('Accepted')
      streams[0]?.write(`event: message\ndata: ${answer(body)}\n\n`)
    })
    const result = await checkMcpHealth(remoteEntry('sse', `${base}/sse`, { 'X-Key': 'k' }), { timeoutMs: 3000 })
    expect(result).toMatchObject({ status: 'ok', serverInfo: { name: 'fake-http' } })
    expect(seen.map(call => call.method)).toEqual(['GET', 'POST'])
    expect(seen[1]?.headers['x-key']).toBe('k')
  })

  it('handles legacy SSE with the answer in the POST body', async () => {
    const base = await serve((request, response, body) => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('event: endpoint\ndata: /messages\n\n')
        streams.push(response)
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(answer(body))
    })
    expect((await checkMcpHealth(remoteEntry('sse', `${base}/sse`), { timeoutMs: 3000 })).status).toBe('ok')
  })

  it('times out without an endpoint event and rejects a foreign endpoint', async () => {
    const quiet = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(': keep-alive\n\n')
      streams.push(response)
    })
    expect((await checkMcpHealth(remoteEntry('sse', quiet), { timeoutMs: 300 })).status).toBe('timeout')
    await new Promise(resolve => {
      for (const stream of streams) {
        stream.destroy()
      }
      server?.closeAllConnections()
      server?.close(resolve)
    })
    const foreign = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('event: endpoint\ndata: http://127.0.0.1:1/messages\n\n')
      streams.push(response)
    })
    const result = await checkMcpHealth(remoteEntry('sse', foreign), { timeoutMs: 3000 })
    expect(result).toMatchObject({ status: 'error', error: 'SSE endpoint points to another origin' })
  })
})

describe('health runner', () => {
  it('runs at most 4 checks at once and finishes all of them', async () => {
    let running = 0
    let peak = 0
    const runner = createHealthRunner({
      timeoutMs: 400,
      check: async (entry, options) => {
        running += 1
        peak = Math.max(peak, running)
        try {
          return await checkMcpHealth(entry, options)
        } finally {
          running -= 1
        }
      },
    })
    const entries = Array.from({ length: 6 }, (_, index) => stdioEntry({ FAKE_MCP_HANG: '1' }, { kind: 'user' }, `hang${index}`))
    const started = Date.now()
    const results = await Promise.all(entries.map(entry => runner.check(entry)))
    expect(results.map(result => result.status)).toEqual(Array(6).fill('timeout'))
    expect(peak).toBe(4)
    expect(Date.now() - started).toBeGreaterThanOrEqual(800)
  })

  it('shares one promise for the same name and scope', async () => {
    let calls = 0
    const runner = createHealthRunner({
      check: async entry => {
        calls += 1
        await new Promise(resolve => setTimeout(resolve, 50))
        return { name: entry.name, scope: entry.scope, status: 'ok' } satisfies McpHealthResult
      },
    })
    const entry = stdioEntry()
    const [first, second] = await Promise.all([runner.check(entry), runner.check(entry)])
    expect(first).toBe(second)
    expect(calls).toBe(1)
    await runner.check(entry)
    expect(calls).toBe(2)
    await Promise.all([runner.check(entry), runner.check({ ...entry, scope: { kind: 'project', projectPath: '/p' } })])
    expect(calls).toBe(4)
  })

  it('releases the slot when a check throws', async () => {
    const runner = createHealthRunner({
      maxConcurrent: 1,
      check: async entry => {
        if (entry.name === 'bad') {
          throw new Error('boom')
        }
        return { name: entry.name, scope: entry.scope, status: 'ok' } satisfies McpHealthResult
      },
    })
    await expect(runner.check(stdioEntry({}, { kind: 'user' }, 'bad'))).rejects.toThrow('boom')
    expect((await runner.check(stdioEntry())).status).toBe('ok')
  })
})
