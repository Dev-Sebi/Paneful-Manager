// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { GLOBAL_SCOPE, makeClaudeMdEntry, makeSkillEntry, WORKTREE_SCOPE } from '@/test/fixtures'
import { mountWithVuetify } from '@/test/mount'
import ScopeTree from './ScopeTree.vue'

const scopes = [GLOBAL_SCOPE, WORKTREE_SCOPE]

describe('ScopeTree', () => {
  it('lists scopes with a branch badge for worktrees only', () => {
    const wrapper = mountWithVuetify(ScopeTree, { props: { scopes, entries: [], mode: 'skills' } })
    expect(wrapper.text()).toContain('Global')
    expect(wrapper.text()).toContain('feat-x')
    const badges = wrapper.findAll('.pm-status-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0]?.text()).toBe('feat/x')
    expect(wrapper.text()).toContain('No skills')
  })

  it('groups skill files by skill with SKILL.md first and emits select', async () => {
    const entries = [
      makeSkillEntry('demo', GLOBAL_SCOPE, 'notes.md'),
      makeSkillEntry('demo', GLOBAL_SCOPE, 'SKILL.md'),
      makeSkillEntry('alpha', WORKTREE_SCOPE),
    ]
    const wrapper = mountWithVuetify(ScopeTree, { props: { scopes, entries, mode: 'skills', selectedPath: entries[1]?.path } })
    const labels = wrapper.findAll('.scope-tree__file').map(button => button.text())
    expect(labels).toEqual(['SKILL.md', 'notes.md', 'SKILL.md'])
    expect(wrapper.find('[aria-current="true"]').text()).toBe('SKILL.md')
    await wrapper.findAll('.scope-tree__file')[1]?.trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual([entries[0]])
  })

  it('offers Create for missing CLAUDE.md files only', async () => {
    const entries = [makeClaudeMdEntry(GLOBAL_SCOPE, 'claude-md')]
    const wrapper = mountWithVuetify(ScopeTree, { props: { scopes: [GLOBAL_SCOPE], entries, mode: 'claude-md' } })
    expect(wrapper.findAll('.scope-tree__file').map(button => button.text())).toEqual(['CLAUDE.md'])
    const create = wrapper.findAll('button').filter(button => button.text() === 'Create')
    expect(create).toHaveLength(1)
    await create[0]?.trigger('click')
    expect(wrapper.emitted('create')?.[0]).toEqual([GLOBAL_SCOPE, 'claude-local-md'])
  })
})
