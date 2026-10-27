// Fake stdio MCP server for health check tests; behavior is controlled through env variables.
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'

const delay = Number(process.env.FAKE_MCP_DELAY_MS ?? 0)
const { FAKE_MCP_FAIL, FAKE_MCP_HANG, FAKE_MCP_GARBAGE, FAKE_MCP_DUMP, FAKE_MCP_STDERR, FAKE_MCP_RPC_ERROR } = process.env

if (FAKE_MCP_DUMP) {
  writeFileSync(FAKE_MCP_DUMP, JSON.stringify({ cwd: process.cwd(), env: process.env, pid: process.pid }))
}
if (FAKE_MCP_STDERR) {
  process.stderr.write(`${FAKE_MCP_STDERR}\n`)
}
if (process.env.FAKE_MCP_ECHO_ARGS) {
  process.stderr.write(`args: ${process.argv.slice(2).join(' ')}\n`)
}
if (FAKE_MCP_FAIL === '1') {
  process.exit(2)
}

const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  if (FAKE_MCP_HANG === '1') {
    return
  }
  const message = JSON.parse(line)
  if (message.method !== 'initialize') {
    return
  }
  setTimeout(() => {
    if (process.env.FAKE_MCP_REQUEST_FIRST === '1') {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, method: 'ping' })}\n`)
    }
    if (FAKE_MCP_GARBAGE === '1') {
      process.stdout.write('this is not json\n')
    } else if (FAKE_MCP_RPC_ERROR === '1') {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unsupported protocol version' } })}\n`)
    } else {
      const result = { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: 'fake-mcp', version: '1.2.3' } }
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })}\n`)
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
    }
  }, delay)
})
