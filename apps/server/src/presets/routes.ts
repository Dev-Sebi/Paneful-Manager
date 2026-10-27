import {
  API_ROUTES,
  DeletePresetResponseSchema,
  LaunchPresetResponseSchema,
  ListPresetsResponseSchema,
  PresetParamsSchema,
  PresetResponseSchema,
  UpsertPresetRequestSchema,
  type DeletePresetResponse,
  type LaunchPresetResponse,
  type ListPresetsResponse,
  type PresetResponse,
} from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import type { PresetLauncher } from './launch.js'
import type { PresetStore } from './store.js'

export interface RegisterPresetsOptions {
  store: PresetStore
  /** Without a launcher (no session engine) the launch route is not registered. */
  launcher?: PresetLauncher
}

/** REST routes for workspace presets; mutations are guarded by the security hook. */
export function registerPresets(app: FastifyInstance, { store, launcher }: RegisterPresetsOptions): void {
  app.get(API_ROUTES.presets, async (): Promise<ListPresetsResponse> =>
    ListPresetsResponseSchema.parse({ presets: await store.list() }))

  app.get(API_ROUTES.preset, async (request): Promise<PresetResponse> => {
    const { name } = PresetParamsSchema.parse(request.params)
    return PresetResponseSchema.parse({ preset: await store.get(name) })
  })

  app.post(API_ROUTES.presets, async (request, reply): Promise<PresetResponse> => {
    const { preset } = UpsertPresetRequestSchema.parse(request.body)
    reply.code(201)
    return PresetResponseSchema.parse({ preset: await store.create(preset) })
  })

  app.put(API_ROUTES.preset, async (request): Promise<PresetResponse> => {
    const { name } = PresetParamsSchema.parse(request.params)
    const { preset } = UpsertPresetRequestSchema.parse(request.body)
    return PresetResponseSchema.parse({ preset: await store.update(name, preset) })
  })

  app.delete(API_ROUTES.preset, async (request): Promise<DeletePresetResponse> => {
    const { name } = PresetParamsSchema.parse(request.params)
    await store.remove(name)
    return DeletePresetResponseSchema.parse({ name, deleted: true })
  })

  if (launcher !== undefined) {
    app.post(API_ROUTES.presetLaunch, async (request, reply): Promise<LaunchPresetResponse> => {
      const { name } = PresetParamsSchema.parse(request.params)
      reply.code(201)
      return LaunchPresetResponseSchema.parse(await launcher.launch(name))
    })
  }
}
