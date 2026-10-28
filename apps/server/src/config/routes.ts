import {
  API_ROUTES,
  GetConfigResponseSchema,
  PatchConfigRequestSchema,
  PatchConfigResponseSchema,
  type GetConfigResponse,
  type PatchConfigResponse,
} from '@paneful-manager/shared'
import type { FastifyInstance } from 'fastify'
import type { ConfigStore } from './store.js'

/** Registers `GET` and `PATCH /api/config`. */
export function registerConfig(app: FastifyInstance, { store }: { store: ConfigStore }): void {
  app.get(API_ROUTES.config, (): GetConfigResponse => GetConfigResponseSchema.parse({ config: store.get() }))
  app.patch(API_ROUTES.config, async (request): Promise<PatchConfigResponse> => {
    const patch = PatchConfigRequestSchema.parse(request.body)
    return PatchConfigResponseSchema.parse(await store.patch(patch))
  })
}
