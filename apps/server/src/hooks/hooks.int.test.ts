import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  API_ROUTES,
  CreateSessionResponseSchema,
  DEFAULT_CONFIG,
  ListSessionsResponseSchema,
  SESSION_TOKEN_HEADER,
  SessionTokenResponseSchema,
  type SessionState,
} from '@agent-hub/shared'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../start.js'
import { Tmux } from '../tmux/tmux.js'

function has(command: string, flag: string): boolean {
  try {
    execFileSync(command, [flag], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const WAIT_MS = 5000
const socketName = `agent-hub-hooks-${randomBytes(4).toString('hex')}`
let dir: string
let server: RunningServer

function tmux(...args: string[]): string {
  return execFileSync('tmux', ['-L', socketName, ...args], { encoding: 'utf8', env: { ...process.env, TMUX: '' } })
}

async function stateOf(id: string): Promise<SessionState | undefined> {
  const response = await fetch(`${server.url}${API_ROUTES.sessions}`)
  return ListSessionsResponseSchema.parse(await response.json()).sessions.find(session => session.id === id)?.state
}

async function waitForState(id: string, state: SessionState): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    if (await stateOf(id) === state) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${state}, last state ${await stateOf(id)}`)
}

const post = (event: string): string =>
  `curl -s -X POST -H "X-Agent-Hub-Hook-Token: $AGENT_HUB_HOOK_TOKEN" -H "X-Agent-Hub-Session-Id: $AGENT_HUB_SESSION_ID" `
  + `-H "content-type: application/json" -d '{"hook_event_name":"${event}"}' "$AGENT_HUB_URL/api/hooks"`

describe.skipIf(!has('tmux', '-V') || !has('curl', '--version'))('hook requests from inside a real tmux session', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-hub-hooks-int-'))
    const conf = join(dir, 'tmux.conf')
    await writeFile(conf, 'set -g exit-empty off\nset -g remain-on-exit on\nset -g status off\n')
    tmux('-f', conf, 'start-server')
    const env = { ...process.env, XDG_STATE_HOME: join(dir, 'state'), CLAUDE_CONFIG_DIR: join(dir, 'claude') }
    server = await startServer({ ...DEFAULT_CONFIG, port: 0 }, pino({ level: 'silent' }), { env, tmux: new Tmux({ socketName }) })
  })

  afterAll(async () => {
    await server?.shutdown()
    try {
      tmux('kill-server')
    } catch {
      // Already gone.
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('moves the session to working and back to idle through curl using the injected environment', async () => {
    const tokenResponse = await fetch(`${server.url}${API_ROUTES.sessionToken}`)
    const { token } = SessionTokenResponseSchema.parse(await tokenResponse.json())
    const gate = join(dir, 'go')
    const script = `${post('UserPromptSubmit')}; while [ ! -f '${gate}' ]; do sleep 0.05; done; ${post('Stop')}; sleep 30`
    const response = await fetch(`${server.url}${API_ROUTES.sessions}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'origin': server.url, [SESSION_TOKEN_HEADER]: token },
      body: JSON.stringify({ cwd: dir, command: 'sh', args: ['-c', script], cols: 80, rows: 24 }),
    })
    expect(response.status).toBe(201)
    const { session } = CreateSessionResponseSchema.parse(await response.json())

    await waitForState(session.id, 'working')
    await writeFile(gate, '')
    await waitForState(session.id, 'idle')
  })
})
