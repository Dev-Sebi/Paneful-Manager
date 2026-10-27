// @vitest-environment jsdom
import type * as ClientModule from './client'
import { z } from '@agent-hub/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '@/test/fixtures'

type Client = typeof ClientModule

const schema = z.strictObject({ ok: z.literal(true) })
const fetchMock = vi.fn<typeof fetch>()

async function load (): Promise<Client> {
  vi.resetModules()
  return import('./client')
}

function tokenHeader (call: number): string | null {
  return new Headers(fetchMock.mock.calls[call]?.[1]?.headers).get('x-agent-hub-token')
}

describe('api client', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends GET requests without fetching a token', async () => {
    const { fetchJson } = await load()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    await expect(fetchJson('/api/x', { schema })).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(tokenHeader(0)).toBeNull()
  })

  it('bootstraps the token lazily and caches it across mutations', async () => {
    const { fetchJson } = await load()
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: 't1' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    await fetchJson('/api/x', { schema, method: 'POST', body: { a: 1 } })
    await fetchJson('/api/x', { schema, method: 'DELETE' })
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/session-token', '/api/x', '/api/x'])
    expect(tokenHeader(1)).toBe('t1')
    expect(tokenHeader(2)).toBe('t1')
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe('{"a":1}')
  })

  it('refetches the token once and retries on 401', async () => {
    const { fetchJson } = await load()
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: 'old' }))
      .mockResolvedValueOnce(jsonResponse({ code: 'unauthorized', message: 'bad token' }, 401))
      .mockResolvedValueOnce(jsonResponse({ token: 'new' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    await expect(fetchJson('/api/x', { schema, method: 'POST' })).resolves.toEqual({ ok: true })
    expect(tokenHeader(1)).toBe('old')
    expect(tokenHeader(3)).toBe('new')
  })

  it('does not retry twice and throws the typed error', async () => {
    const { ApiClientError, fetchJson } = await load()
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: 'a' }))
      .mockResolvedValueOnce(jsonResponse({ code: 'forbidden', message: 'nope' }, 403))
      .mockResolvedValueOnce(jsonResponse({ token: 'b' }))
      .mockResolvedValueOnce(jsonResponse({ code: 'forbidden', message: 'still nope' }, 403))
    const error = await fetchJson('/api/x', { schema, method: 'PATCH' }).catch((error_: unknown) => error_)
    expect(error).toBeInstanceOf(ApiClientError)
    expect(error).toMatchObject({ status: 403, code: 'forbidden', message: 'still nope' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('keeps validation details from the error body', async () => {
    const { fetchJson } = await load()
    const body = { code: 'validation_failed', message: 'bad', details: [{ path: ['cwd'], message: 'required' }] }
    fetchMock.mockResolvedValueOnce(jsonResponse(body, 400))
    await expect(fetchJson('/api/x', { schema })).rejects.toMatchObject({ code: 'validation_failed', details: body.details })
  })

  it('maps an unparseable error body to an internal error', async () => {
    const { fetchJson } = await load()
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 502, statusText: 'Bad Gateway' }))
    await expect(fetchJson('/api/x', { schema })).rejects.toMatchObject({ status: 502, code: 'internal', message: 'Bad Gateway' })
  })

  it('rejects a response that violates the schema', async () => {
    const { fetchJson } = await load()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false }))
    await expect(fetchJson('/api/x', { schema })).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('reports an unreachable server as a network error', async () => {
    const { fetchJson } = await load()
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(fetchJson('/api/x', { schema })).rejects.toMatchObject({ status: 0, code: 'network' })
  })

  it('does not retry GET requests on 401', async () => {
    const { fetchJson } = await load()
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'unauthorized', message: 'no' }, 401))
    await expect(fetchJson('/api/x', { schema })).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('validates typed helpers with the shared schemas', async () => {
    const { api } = await load()
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [{ id: 'bad' }] }))
    await expect(api.listSessions()).rejects.toMatchObject({ code: 'invalid_response' })
  })
})
