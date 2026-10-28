import type { APIRequestContext, Page } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, request } from '@playwright/test'
import { E2E_ACCESS_KEY } from './access'

/** Direct server origin of the e2e fixture (see playwright.config.ts). */
const SERVER = 'http://127.0.0.1:7340'
const WEB_ORIGIN = 'http://127.0.0.1:3001'
export const TABS_KEY = 'agent-hub.tabs.v1'

interface E2ePaths {
  state: string
  config: string
}

export interface AppTabFixture {
  id: string
  title: string
  layout: { kind: string }
  panes: Array<{ sessionId: string }>
}

export function readPaths (): E2ePaths {
  return JSON.parse(readFileSync(join(tmpdir(), 'ah-e2e-paths.json'), 'utf8')) as E2ePaths
}

/** Writes a one-time login code into the server's state dir, as `pnpm login-url` does, and returns it. */
export function createLoginCode (): string {
  const code = randomBytes(32).toString('base64url')
  const expiresAtSec = Math.floor(Date.now() / 1000) + 600
  writeFileSync(join(readPaths().state, 'login-code'), `${code} ${expiresAtSec}\n`, { mode: 0o600 })
  return code
}

/** Logs every browser out, as `pnpm login-url --reset` does. */
export function resetDevices (): void {
  rmSync(join(readPaths().state, 'devices.json'), { force: true })
}

export function hookToken (): string {
  return readFileSync(join(readPaths().state, 'hook-token'), 'utf8').trim()
}

/** API client that behaves like the browser app: allowed Origin, access key and the per-boot session token. */
export class ServerApi {
  private constructor (private readonly ctx: APIRequestContext, private readonly token: string) {}

  static async create (): Promise<ServerApi> {
    const ctx = await request.newContext({ baseURL: SERVER, extraHTTPHeaders: { 'origin': WEB_ORIGIN, 'x-agent-hub-key': E2E_ACCESS_KEY } })
    const response = await ctx.get('/api/session-token')
    expect(response.ok()).toBe(true)
    const { token } = await response.json() as { token: string }
    return new ServerApi(ctx, token)
  }

  async createSession (command = 'sh'): Promise<string> {
    const response = await this.ctx.post('/api/sessions', { headers: this.headers(), data: { cwd: '~/', command } })
    expect(response.ok()).toBe(true)
    const body = await response.json() as { session: { id: string } }
    return body.session.id
  }

  async killSession (id: string): Promise<void> {
    await this.ctx.delete(`/api/sessions/${id}`, { headers: this.headers() })
  }

  async patchConfig (patch: object): Promise<void> {
    const response = await this.ctx.patch('/api/config', { headers: this.headers(), data: patch })
    expect(response.ok()).toBe(true)
  }

  async deletePreset (name: string): Promise<void> {
    await this.ctx.delete(`/api/presets/${name}`, { headers: this.headers() })
  }

  async listPresets (): Promise<Array<{ name: string }>> {
    return ((await (await this.ctx.get('/api/presets')).json()) as { presets: Array<{ name: string }> }).presets
  }

  async createPreset (preset: unknown): Promise<void> {
    await this.ctx.post('/api/presets', { headers: this.headers(), data: { preset } })
  }

  async dispose (): Promise<void> {
    await this.ctx.dispose()
  }

  private headers () {
    return { 'x-agent-hub-token': this.token }
  }
}

/** Sends a Claude Code hook event the way the installed hook does: token header, no Origin. */
export async function postHook (sessionId: string, event: string): Promise<number> {
  const ctx = await request.newContext({ baseURL: SERVER })
  try {
    const response = await ctx.post('/api/hooks', {
      headers: { 'x-agent-hub-hook-token': hookToken(), 'x-agent-hub-session-id': sessionId },
      data: { hook_event_name: event },
    })
    return response.status()
  } finally {
    await ctx.dispose()
  }
}

/** Seeds the persisted tabs so the page opens straight on them. */
export async function seedTabs (page: Page, tabs: AppTabFixture[]): Promise<void> {
  await page.addInitScript(({ key, value }: { key: string, value: string }) => {
    if (!localStorage.getItem(key)) {
      localStorage.setItem(key, value)
    }
  }, { key: TABS_KEY, value: JSON.stringify({ tabs, activeId: tabs[0]?.id }) })
}
