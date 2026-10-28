import { UpsertMcpServerRequestSchema } from '@paneful-manager/shared'
import { describe, expect, it } from 'vitest'
import { makeMcpEntry } from '@/test/fixtures'
import { buildRequest, emptyForm, errorsFromApi, formFromEntry, hasErrors, nameError, newRow, urlError, validateForm } from './mcpForm'

describe('mcp form validation', () => {
  it('accepts valid names and rejects invalid and reserved ones inline', () => {
    expect(nameError('my_server-1')).toBeUndefined()
    expect(nameError('-flag')).toMatch(/not starting with/)
    expect(nameError('has space')).toMatch(/letters, digits/)
    expect(nameError('computer-use')).toBe('"computer-use" is reserved by Claude Code')
    expect(nameError('Claude Preview')).toMatch(/reserved/)
    expect(nameError('WORKSPACE')).toMatch(/reserved/)
  })

  it('accepts http(s) and ${VAR} urls only', () => {
    expect(urlError('https://example.com/mcp')).toBeUndefined()
    expect(urlError('${BASE}/mcp')).toBeUndefined()
    expect(urlError('ftp://example.com')).toBeDefined()
    expect(urlError('example.com')).toBeDefined()
  })

  it('requires name and command for stdio, name and url for remote', () => {
    const stdio = validateForm(emptyForm())
    expect(stdio.name).toBe('Name is required')
    expect(stdio.command).toBe('Command is required')
    const remote = validateForm({ ...emptyForm(), name: 'a', transport: 'http' })
    expect(remote.url).toBe('URL is required')
    expect(hasErrors(validateForm({ ...emptyForm(), name: 'a', command: 'x' }))).toBe(false)
  })

  it('flags duplicate keys and values without key', () => {
    const rows = [newRow('A', '1'), newRow('A', '2'), newRow('', 'x')]
    const errors = validateForm({ ...emptyForm(), name: 'a', command: 'x', rows })
    expect(errors.rows[rows[1]?.id ?? 0]).toBe('Duplicate key')
    expect(errors.rows[rows[2]?.id ?? 0]).toBe('Key is required')
  })
})

describe('mcp form request', () => {
  it('builds a stdio request with one argument per line', () => {
    const form = { ...emptyForm(), name: 'a', command: ' npx ', argsText: ' -y \n\nserver\n  ', rows: [newRow('TOKEN', 's3cret')] }
    expect(buildRequest(form)).toEqual({
      name: 'a',
      scope: { kind: 'user' },
      config: { transport: 'stdio', command: 'npx', args: ['-y', 'server'], env: { TOKEN: 's3cret' } },
    })
  })

  it('builds a remote request with the project scope', () => {
    const form = { ...emptyForm('local', '/work/app'), name: 'a', transport: 'http' as const, url: 'https://x.test', rows: [newRow('Authorization', 'Bearer t')] }
    expect(buildRequest(form)).toEqual({
      name: 'a',
      scope: { kind: 'local', projectPath: '/work/app' },
      config: { transport: 'http', url: 'https://x.test', headers: { Authorization: 'Bearer t' } },
    })
  })

  it('never prefills masked values and sends keep when left empty', () => {
    const form = formFromEntry(makeMcpEntry('a'))
    const secret = form.rows.find(row => row.key === 'API_KEY')
    const plain = form.rows.find(row => row.key === 'PATH')
    expect(secret).toMatchObject({ value: '', masked: true })
    expect(plain).toMatchObject({ value: '/usr/bin', masked: false })
    const config = buildRequest(form).config
    expect(config).toMatchObject({ env: { API_KEY: { keep: true }, PATH: '/usr/bin' } })
  })

  it('sends a typed replacement for a masked value', () => {
    const form = formFromEntry(makeMcpEntry('a'))
    const secret = form.rows.find(row => row.key === 'API_KEY')
    if (secret) {
      secret.value = 'new'
    }
    expect(buildRequest(form).config).toMatchObject({ env: { API_KEY: 'new' } })
  })

  it('leaves a cleared row out', () => {
    const form = formFromEntry(makeMcpEntry('a'))
    const secret = form.rows.find(row => row.key === 'API_KEY')
    if (secret) {
      secret.clear = true
    }
    const env = (buildRequest(form).config as { env: Record<string, unknown> }).env
    expect(env).not.toHaveProperty('API_KEY')
    expect(env).toHaveProperty('PATH')
  })

  it('keeps masked header keys of remote servers', () => {
    const entry = makeMcpEntry('r', { config: { transport: 'sse', url: 'https://x.test', headers: { Authorization: { masked: true, set: true } } } })
    expect(buildRequest(formFromEntry(entry)).config).toEqual({
      transport: 'sse',
      url: 'https://x.test',
      headers: { Authorization: { keep: true } },
    })
  })
})

describe('mcp form contract', () => {
  it('builds requests the shared schema accepts', () => {
    const stdio = { ...emptyForm(), name: 'a', command: 'npx', argsText: '-y', rows: [newRow('K', 'v')] }
    const remote = { ...emptyForm('local', '/work/app'), name: 'r', transport: 'http' as const, url: 'https://x.test', rows: [newRow('H', 'v')] }
    const masked = formFromEntry(makeMcpEntry('m'))
    for (const form of [stdio, remote, masked]) {
      expect(UpsertMcpServerRequestSchema.safeParse(buildRequest(form)).success).toBe(true)
    }
  })

  it('maps validation issues onto fields', () => {
    const errors = errorsFromApi([
      { path: ['name'], message: 'bad name' },
      { path: ['config', 'url'], message: 'bad url' },
      { path: ['config', 'headers', 'Auth'], message: 'bad header' },
      { path: ['other'], message: 'ignored' },
    ])
    expect(errors).toEqual({ name: 'bad name', url: 'bad url', keys: { Auth: 'bad header' } })
    expect(errorsFromApi(undefined)).toEqual({ keys: {} })
  })
})
