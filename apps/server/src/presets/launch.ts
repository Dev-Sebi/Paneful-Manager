import {
  CreateSessionRequestSchema,
  type CreateSessionRequest,
  type LaunchedTab,
  type LaunchPresetResponse,
  type WorkspacePreset,
} from '@paneful-manager/shared'
import type { BaseLogger } from 'pino'
import type { SessionEngine } from '../sessions/engine.js'
import type { LaunchLedger } from './ledger.js'
import type { PresetStore } from './store.js'

export interface PresetLauncherOptions {
  store: PresetStore
  engine: Pick<SessionEngine, 'create' | 'kill' | 'get'>
  ledger: LaunchLedger
  logger: Pick<BaseLogger, 'info' | 'warn' | 'error'>
}

export interface PresetLauncher {
  /** Starts one session per pane; a failure kills the sessions already started and rethrows. */
  launch: (name: string) => Promise<LaunchPresetResponse>
  /** Drops the launch record of a deleted preset; failures are logged, never thrown. */
  forget: (name: string) => Promise<void>
  /** Launches every `autostart` preset that has no live session from an earlier launch; never throws. */
  autostart: () => Promise<void>
}

function tabTitle(preset: WorkspacePreset, index: number): string {
  const title = preset.tabs[index]?.title
  if (title !== undefined) {
    return title
  }
  return preset.tabs.length > 1 ? `${preset.name} ${index + 1}` : preset.name
}

/** One create request per pane, validated up front so a bad pane fails before any session starts. */
function toRequests(preset: WorkspacePreset): CreateSessionRequest[][] {
  return preset.tabs.map(tab =>
    tab.panes.map(pane =>
      CreateSessionRequestSchema.parse({
        cwd: pane.cwd,
        command: pane.command,
        args: pane.args,
        ...(pane.title === undefined ? {} : { title: pane.title }),
      }),
    ),
  )
}

export function createPresetLauncher({ store, engine, ledger, logger }: PresetLauncherOptions): PresetLauncher {
  /** An exited session stays in the engine (`remain-on-exit`) but no longer counts as running. */
  function isLive(id: string): boolean {
    const session = engine.get(id)
    return session !== undefined && session.lifecycle !== 'exited'
  }

  async function launchPreset(preset: WorkspacePreset): Promise<LaunchPresetResponse> {
    const requests = toRequests(preset)
    const created: string[] = []
    try {
      const tabs: LaunchedTab[] = []
      for (const [tabIndex, tab] of preset.tabs.entries()) {
        const panes: LaunchedTab['panes'] = []
        for (const [paneIndex, pane] of tab.panes.entries()) {
          const request = requests[tabIndex]?.[paneIndex]
          if (request === undefined) {
            continue
          }
          const session = await engine.create(request)
          created.push(session.id)
          panes.push({ sessionId: session.id, ...(pane.size === undefined ? {} : { size: pane.size }) })
        }
        tabs.push({ title: tabTitle(preset, tabIndex), layout: tab.layout, panes })
      }
      await ledger.record(preset.name, created, isLive).catch((error: unknown) => {
        logger.warn({ err: error, preset: preset.name }, 'Could not record the preset launch')
      })
      return { name: preset.name, tabs }
    } catch (error) {
      const results = await Promise.allSettled(created.map(id => engine.kill(id)))
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.warn({ err: result.reason, preset: preset.name }, 'Could not roll back a preset session')
        }
      }
      throw error
    }
  }

  async function autostartOne(preset: WorkspacePreset): Promise<void> {
    if (ledger.sessionIds(preset.name).some(isLive)) {
      logger.info(`Preset ${preset.name} already has sessions, autostart skipped`)
      return
    }
    try {
      const launched = await launchPreset(preset)
      const count = launched.tabs.reduce((sum, tab) => sum + tab.panes.length, 0)
      logger.info(`Autostarted preset ${preset.name} (${count} sessions)`)
    } catch (error) {
      logger.error({ err: error, preset: preset.name }, `Autostart of preset ${preset.name} failed`)
    }
  }

  return {
    async forget(name) {
      await ledger.forget(name).catch((error: unknown) => {
        logger.warn({ err: error, preset: name }, 'Could not drop the preset launch record')
      })
    },
    async launch(name) {
      return launchPreset(await store.get(name))
    },
    async autostart() {
      try {
        for (const preset of await store.list()) {
          if (preset.autostart) {
            await autostartOne(preset)
          }
        }
      } catch (error) {
        logger.error({ err: error }, 'Preset autostart failed')
      }
    },
  }
}
