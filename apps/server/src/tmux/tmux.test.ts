import { describe, expect, it } from 'vitest'
import { RunError } from '../process/exec.js'
import {
  idFromTmuxName,
  type RunFn,
  paneTarget,
  parsePaneList,
  parseSessionList,
  sessionTarget,
  Tmux,
  tmuxEnv,
  TmuxSessionNotFoundError,
  TmuxUnavailableError,
} from './tmux.js'

function fakeRun(respond: (args: readonly string[]) => string | RunError): { run: RunFn, calls: string[][] } {
  const calls: string[][] = []
  const run: RunFn = async (_file, args) => {
    calls.push([...args])
    const result = respond(args)
    if (result instanceof RunError) {
      throw result
    }
    return { stdout: result, stderr: '' }
  }
  return { run, calls }
}

describe('targets and names', () => {
  it('uses exact-match targets', () => {
    expect(sessionTarget('abc')).toBe('=ah-abc')
    expect(paneTarget('abc')).toBe('=ah-abc:')
  })

  it('extracts ids only from valid ah- names', () => {
    expect(idFromTmuxName('ah-Ab_9-x')).toBe('Ab_9-x')
    expect(idFromTmuxName('main')).toBeUndefined()
    expect(idFromTmuxName('ah-')).toBeUndefined()
    expect(idFromTmuxName('ah-a.b')).toBeUndefined()
  })

  it('removes TMUX variables from the environment', () => {
    expect(tmuxEnv({ TMUX: '/tmp/x,1,0', TMUX_PANE: '%1', HOME: '/home/dev' })).toEqual({ HOME: '/home/dev' })
  })
})

describe('parseSessionList', () => {
  it('parses live, dead and foreign sessions', () => {
    const stdout = [
      'ah-a1\t1793090986\t/tmp\t1\t3\tsh -c "exit 3"',
      'ah-a2\t1793090987\t/home/dev/git/p1\t0\t\tenv -- claude',
      'scratch\t1793090988\t/home/dev\t0\t\tbash',
      '',
    ].join('\n')
    const [dead, live, foreign] = parseSessionList(stdout)
    expect(dead).toMatchObject({ name: 'ah-a1', id: 'a1', path: '/tmp', dead: true, exitStatus: 3, startCommand: 'sh -c "exit 3"' })
    expect(dead?.createdAt.toISOString()).toBe('2026-10-27T08:49:46.000Z')
    expect(live).toMatchObject({ id: 'a2', dead: false, exitStatus: undefined })
    expect(foreign?.id).toBeUndefined()
  })

  it('keeps tabs inside the start command and skips malformed lines', () => {
    const [info, ...rest] = parseSessionList('ah-a1\t1\t/tmp\t0\t\tprintf "a\tb"\nbroken\n')
    expect(info?.startCommand).toBe('printf "a\tb"')
    expect(rest).toEqual([])
  })
})

describe('parsePaneList', () => {
  it('parses dead status only for dead panes', () => {
    expect(parsePaneList('1\t3\n0\t\n1\t\n')).toEqual([
      { dead: true, exitStatus: 3 },
      { dead: false, exitStatus: undefined },
      { dead: true, exitStatus: undefined },
    ])
  })
})

describe('Tmux', () => {
  it('builds new-session without a shell', async () => {
    const { run, calls } = fakeRun(() => '')
    const tmux = new Tmux({ socketName: 'test-sock', run })
    await tmux.newSession({ id: 'a1', cwd: '/tmp', command: 'claude', args: ['--resume'], env: { AGENT_HUB_SESSION_ID: 'a1' }, cols: 120, rows: 30 })
    expect(calls[0]).toEqual([
      '-N', '-L', 'test-sock', 'new-session', '-d', '-s', 'ah-a1', '-c', '/tmp', '-x', '120', '-y', '30',
      '-e', 'AGENT_HUB_SESSION_ID=a1', '--', 'env', '--', 'claude', '--resume',
    ])
    expect(tmux.attachArgs('a1')).toEqual(['-L', 'test-sock', 'attach-session', '-t', '=ah-a1'])
  })

  it('adds the alternate-screen override only once', async () => {
    let overrides = ''
    const { run, calls } = fakeRun(args => {
      if (args.includes('set-option')) {
        overrides = `${args.at(-1)?.slice(1)}\n`
      }
      return args.includes('show-options') ? overrides : ''
    })
    const tmux = new Tmux({ run })
    await tmux.ensureNoAlternateScreen()
    await tmux.ensureNoAlternateScreen()
    expect(calls.filter(call => call.includes('set-option'))).toEqual([
      ['-N', '-L', 'agent-hub', 'set-option', '-s', '-a', 'terminal-overrides', ',xterm-256color:smcup@:rmcup@'],
    ])
  })

  it('maps a missing server to TmuxUnavailableError', async () => {
    const { run } = fakeRun(() => new RunError('failed', 'exit', 1, '', 'error connecting to /tmp/tmux-1000/agent-hub (No such file or directory)\n'))
    const tmux = new Tmux({ run })
    await expect(tmux.listSessions()).rejects.toBeInstanceOf(TmuxUnavailableError)
    await expect(tmux.hasServer()).resolves.toBe(false)
    await expect(tmux.listSessions()).rejects.toMatchObject({ code: 'tmux_unavailable', statusCode: 503 })
  })

  it('maps a missing binary to TmuxUnavailableError', async () => {
    const { run } = fakeRun(() => new RunError('tmux could not be started', 'spawn', null, '', ''))
    await expect(new Tmux({ run }).listSessions()).rejects.toBeInstanceOf(TmuxUnavailableError)
  })

  it('maps a missing session to TmuxSessionNotFoundError', async () => {
    const { run } = fakeRun(() => new RunError('failed', 'exit', 1, '', "can't find session: ah-zz\n"))
    await expect(new Tmux({ run }).killSession('zz')).rejects.toBeInstanceOf(TmuxSessionNotFoundError)
  })

  it('captures only existing history lines', async () => {
    let history = '0'
    const { run, calls } = fakeRun(args => (args.includes('display-message') ? `${history}\n` : 'line\n'))
    const tmux = new Tmux({ run })
    await expect(tmux.capturePane('a1', 5000)).resolves.toBe('')
    expect(calls).toHaveLength(1)
    history = '42'
    await expect(tmux.capturePane('a1', 5000)).resolves.toBe('line\n')
    expect(calls[2]).toEqual(['-N', '-L', 'agent-hub', 'capture-pane', '-p', '-e', '-J', '-S', '-42', '-E', '-1', '-t', '=ah-a1:'])
  })

  it('lists client ttys and panes with exact targets', async () => {
    const { run, calls } = fakeRun(args => (args.includes('list-clients') ? '/dev/pts/3\n' : '1\t0\n'))
    const tmux = new Tmux({ run })
    await expect(tmux.listClients('a1')).resolves.toEqual(['/dev/pts/3'])
    await expect(tmux.listPanes('a1')).resolves.toEqual([{ dead: true, exitStatus: 0 }])
    await tmux.refreshClient('/dev/pts/3')
    await tmux.resizeWindow('a1', 100, 40)
    expect(calls.map(call => call.slice(3))).toEqual([
      ['list-clients', '-t', '=ah-a1:', '-F', '#{client_tty}'],
      ['list-panes', '-t', '=ah-a1:', '-F', '#{pane_dead}\t#{pane_dead_status}'],
      ['refresh-client', '-t', '/dev/pts/3'],
      ['resize-window', '-t', '=ah-a1:', '-x', '100', '-y', '40'],
    ])
  })
})
