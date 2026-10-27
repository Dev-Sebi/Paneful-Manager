import type { AppTab, Layout, LayoutKind, Session, WorkspacePreset, WorkspacePresetInput } from '@agent-hub/shared'
import { DEFAULT_COMMAND, WorkspacePresetSchema } from '@agent-hub/shared'

export const LAYOUT_OPTIONS: readonly LayoutKind[] = ['single', 'row', 'column', 'grid-2x2']

/** Form model of a pane; `extra` keeps keys the form has no field for (`size`, unknown keys). */
export interface PaneForm {
  cwd: string
  command: string
  /** One argument per line. */
  args: string
  title: string
  extra: Record<string, unknown>
}

export interface TabForm {
  title: string
  layout: LayoutKind
  /** Only set for a `custom` layout, which the form cannot edit but must not lose. */
  custom?: Layout
  panes: PaneForm[]
  extra: Record<string, unknown>
}

export interface PresetForm {
  name: string
  description: string
  autostart: boolean
  tabs: TabForm[]
  extra: Record<string, unknown>
}

export interface FormIssue {
  path: string
  message: string
}

/** Deep copy that also works on reactive proxies, which `structuredClone` rejects. */
export function cloneForm (form: PresetForm): PresetForm {
  // eslint-disable-next-line unicorn/prefer-structured-clone
  return JSON.parse(JSON.stringify(form)) as PresetForm
}

export function emptyPane (): PaneForm {
  return { cwd: '', command: DEFAULT_COMMAND, args: '', title: '', extra: {} }
}

export function emptyTab (): TabForm {
  return { title: '', layout: 'row', panes: [emptyPane()], extra: {} }
}

export function emptyForm (): PresetForm {
  return { name: '', description: '', autostart: false, tabs: [emptyTab()], extra: {} }
}

export function presetToForm (preset: WorkspacePreset): PresetForm {
  const { name, description, autostart, tabs, ...extra } = preset
  return {
    name,
    description: description ?? '',
    autostart,
    extra,
    tabs: tabs.map(tab => {
      const { title, layout, panes, ...tabExtra } = tab
      return {
        title: title ?? '',
        layout: layout.kind,
        ...(layout.kind === 'custom' ? { custom: layout } : {}),
        extra: tabExtra,
        panes: panes.map(pane => {
          const { cwd, command, args, title: paneTitle, ...paneExtra } = pane
          return { cwd, command, args: args.join('\n'), title: paneTitle ?? '', extra: paneExtra }
        }),
      }
    }),
  }
}

/** Builds the preset the server expects; validation happens separately in `validateForm`. */
export function formToPreset (form: PresetForm): WorkspacePresetInput {
  return {
    ...form.extra,
    name: form.name.trim(),
    ...(form.description.trim() === '' ? {} : { description: form.description.trim() }),
    autostart: form.autostart,
    tabs: form.tabs.map(tab => ({
      ...tab.extra,
      ...(tab.title.trim() === '' ? {} : { title: tab.title.trim() }),
      layout: tab.layout === 'custom' && tab.custom ? tab.custom : { kind: tab.layout },
      panes: tab.panes.map(pane => ({
        ...pane.extra,
        cwd: pane.cwd.trim(),
        command: pane.command.trim(),
        args: pane.args.split('\n').filter(line => line.trim() !== ''),
        ...(pane.title.trim() === '' ? {} : { title: pane.title.trim() }),
      })),
    })),
  } as WorkspacePresetInput
}

/** Validates with the shared schema, the same one the server applies. */
export function validateForm (form: PresetForm): { preset: WorkspacePreset } | { issues: FormIssue[] } {
  const result = WorkspacePresetSchema.safeParse(formToPreset(form))
  if (result.success) {
    return { preset: result.data }
  }
  return { issues: result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) }
}

/** Turns open tabs into preset tabs; a tab with a placeholder pane or an unknown session is left out. */
export function tabsToForm (tabs: readonly AppTab[], sessions: ReadonlyMap<string, Session>): PresetForm {
  const form = emptyForm()
  form.tabs = tabs.flatMap((tab): TabForm[] => {
    const panes: PaneForm[] = []
    for (const pane of tab.panes) {
      const session = pane.sessionId === undefined ? undefined : sessions.get(pane.sessionId)
      if (!session) {
        return []
      }
      panes.push({
        cwd: session.cwd,
        command: session.command,
        args: session.args.join('\n'),
        title: session.title ?? '',
        extra: pane.size === undefined ? {} : { size: pane.size },
      })
    }
    return [{
      title: tab.title,
      layout: tab.layout.kind,
      ...(tab.layout.kind === 'custom' ? { custom: tab.layout } : {}),
      panes,
      extra: {},
    }]
  })
  return form
}
