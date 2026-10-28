// @vitest-environment jsdom
import type { ClientMessageInput } from '@paneful-manager/shared'
import { enableAutoUnmount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mountWithVuetify } from '@/test/mount'
import PmTerminalPane from './PmTerminalPane.vue'

const mocks = vi.hoisted(() => {
  const sent: ClientMessageInput[] = []
  const terminals: Array<{ options: Record<string, unknown>, keyHandler?: (event: KeyboardEvent) => boolean, written: string[], disposed: boolean }> = []
  return { sent, terminals }
})

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    unicode = { activeVersion: '6' }
    textarea = undefined
    written: string[] = []
    disposed = false
    keyHandler?: (event: KeyboardEvent) => boolean
    constructor (readonly options: Record<string, unknown>) {
      mocks.terminals.push(this)
    }

    loadAddon () {}
    open () {}
    focus () {}
    write (data: string) {
      this.written.push(data)
    }

    reset () {}
    clear () {}
    resize (cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
    }

    getSelection () {
      return 'selected'
    }

    attachCustomKeyEventHandler (handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler
    }

    onData () {
      return { dispose () {} }
    }

    onTitleChange () {
      return { dispose () {} }
    }

    dispose () {
      this.disposed = true
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions () {
      return { cols: 100, rows: 30 }
    }
  },
}))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@/api/ws', () => ({
  wsClient: {
    send: (message: ClientMessageInput) => {
      mocks.sent.push(message)
      return true
    },
    on: () => () => {},
    onOpen: () => () => {},
  },
}))

enableAutoUnmount(afterEach)

function mountPane (props: Record<string, unknown> = {}) {
  return mountWithVuetify(PmTerminalPane, {
    props: { sessionId: 's1', title: 'api', ...props },
    global: { plugins: [createPinia()] },
  })
}

describe('PmTerminalPane', () => {
  beforeEach(() => {
    mocks.sent.length = 0
    mocks.terminals.length = 0
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400)
  })
  afterEach(() => vi.restoreAllMocks())

  it('shows the elapsed time in the current state next to the title', () => {
    const wrapper = mountPane({ status: 'idle', stateSince: new Date(Date.now() - 180_000).toISOString() })
    expect(wrapper.get('[data-testid="pane-state-since"]').text()).toBe('idle 3m')
    expect(mountPane({ status: 'idle' }).find('[data-testid="pane-state-since"]').exists()).toBe(false)
    const exited = mountPane({ status: 'idle', connection: 'exited', stateSince: new Date(Date.now() - 180_000).toISOString() })
    expect(exited.find('[data-testid="pane-state-since"]').exists()).toBe(false)
  })

  it('renders the header, configures xterm and attaches with the fitted size', () => {
    const wrapper = mountPane({ cwd: '/work/api', status: 'working' })
    expect(wrapper.get('[role="group"]').attributes('aria-label')).toBe('Terminal: api')
    expect(wrapper.text()).toContain('/work/api')
    const labels = wrapper.findAll('header button').map(button => button.attributes('aria-label'))
    expect(labels).toEqual(['Split vertical', 'Split horizontal', 'Maximize', 'Close pane'])
    expect(mocks.terminals[0]?.options).toMatchObject({ scrollback: 10_000, fontSize: 13, allowProposedApi: true })
    expect(mocks.sent).toEqual([{ type: 'attach', sessionId: 's1', cols: 100, rows: 30, scrollback: true }])
    expect(wrapper.text()).toContain('Connecting')
  })

  it('shows the linked team member with a role badge', () => {
    const wrapper = mountPane({ status: 'waiting', member: { name: 'tester', role: 'Lead', others: ['dev', 'qa'] } })
    const member = wrapper.get('.pm-terminal-pane__member')
    expect(member.text()).toContain('tester')
    expect(member.get('.pm-status-badge--label.pm-status-badge--idle').text()).toBe('Lead')
    expect(member.text()).toContain('+2')
    expect(member.attributes('title')).toBe('Same tmux window: dev, qa')
  })

  it('shows no member badge without a link', () => {
    expect(mountPane().find('.pm-terminal-pane__member').exists()).toBe(false)
  })

  it('does not attach while hidden', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(0)
    mountPane()
    expect(mocks.sent).toEqual([])
  })

  it('shows the read-only label and disables stdin', () => {
    const wrapper = mountPane({ readonly: true })
    expect(wrapper.text()).toContain('Read-only')
    expect(mocks.terminals[0]?.options.disableStdin).toBe(true)
  })

  it('emits pane actions from buttons and shortcuts and keeps shortcuts away from the PTY', async () => {
    const wrapper = mountPane()
    await wrapper.get('[aria-label="Maximize"]').trigger('click')
    await wrapper.get('[aria-label="Close pane"]').trigger('click')
    const shortcut = new KeyboardEvent('keydown', { code: 'Equal', altKey: true, shiftKey: true })
    expect(mocks.terminals[0]?.keyHandler?.(shortcut)).toBe(false)
    expect(mocks.terminals[0]?.keyHandler?.(new KeyboardEvent('keydown', { code: 'KeyA' }))).toBe(true)
    await wrapper.get('[role="group"]').trigger('keydown', { code: 'Equal', altKey: true, shiftKey: true })
    expect(wrapper.emitted('toggle-maximize')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.emitted('split')).toEqual([['vertical']])
  })

  it('shows the exited overlay with a restart action', async () => {
    const wrapper = mountPane({ connection: 'exited', exitCode: 3 })
    await nextTick()
    expect(wrapper.text()).toContain('Process exited (code 3)')
    await wrapper.get('.pm-terminal-pane__overlay button').trigger('click')
    expect(wrapper.emitted('restart')).toHaveLength(1)
  })

  it('detaches while hidden and re-attaches with scrollback when shown again', () => {
    const wrapper = mountPane()
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(0)
    const pane = wrapper.vm as unknown as { fit: () => void }
    pane.fit()
    expect(mocks.sent.at(-1)).toEqual({ type: 'detach', sessionId: 's1' })
    width.mockReturnValue(800)
    pane.fit()
    expect(mocks.sent.at(-1)).toEqual({ type: 'attach', sessionId: 's1', cols: 100, rows: 30, scrollback: true })
  })

  it('detaches and disposes xterm on unmount', () => {
    const wrapper = mountPane()
    wrapper.unmount()
    expect(mocks.sent.at(-1)).toEqual({ type: 'detach', sessionId: 's1' })
    expect(mocks.terminals[0]?.disposed).toBe(true)
  })
})
