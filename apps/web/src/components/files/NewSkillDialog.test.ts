// @vitest-environment jsdom
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { GLOBAL_SCOPE, WORKTREE_SCOPE } from '@/test/fixtures'
import { mountWithVuetify } from '@/test/mount'
import NewSkillDialog from './NewSkillDialog.vue'

const mounted: Array<{ unmount: () => void }> = []

async function open (props: Record<string, unknown> = {}) {
  const wrapper = mountWithVuetify(NewSkillDialog, {
    props: { modelValue: true, scopes: [GLOBAL_SCOPE, WORKTREE_SCOPE], ...props },
    global: { stubs: { transition: false } },
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

function input () {
  const element = document.querySelector('input')
  if (!element) {
    throw new Error('no input')
  }
  return element
}

async function type (value: string) {
  input().value = value
  input().dispatchEvent(new Event('input'))
  await flushPromises()
}

async function confirm () {
  document.querySelector<HTMLElement>('[data-pm-confirm]')?.click()
  await flushPromises()
}

afterEach(() => {
  for (const wrapper of mounted.splice(0)) {
    wrapper.unmount()
  }
})

describe('NewSkillDialog', () => {
  it.each(['', '../evil', 'a/b', '.hidden', 'node_modules', 'a'.repeat(65)])('rejects the name %j', async name => {
    const wrapper = await open()
    await type(name)
    await confirm()
    expect(wrapper.emitted('submit')).toBeUndefined()
    expect(document.querySelector('[aria-invalid="true"]')).not.toBeNull()
  })

  it('submits a valid name with scope and the skill template', async () => {
    const wrapper = await open({ defaultScopePath: WORKTREE_SCOPE.path })
    await type('my-skill_1.0')
    await confirm()
    expect(wrapper.emitted('submit')?.[0]).toEqual([
      { scopePath: WORKTREE_SCOPE.path, kind: 'skill', name: 'my-skill_1.0', template: 'skill' },
    ])
  })

  it('lists every scope and shows a server error', async () => {
    await open({ error: 'A skill named "x" already exists in this scope' })
    expect(document.querySelectorAll('option')).toHaveLength(2)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('already exists')
  })
})
