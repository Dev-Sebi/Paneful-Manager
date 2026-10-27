import { API_ROUTES, ScopesResponseSchema, type AppConfig, type ScopesResponse } from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import { discoverScopes } from './discover.js'
import type { RunFn } from './run-git.js'

export interface ScopesDeps {
  getConfig: () => AppConfig
  env?: Record<string, string | undefined>
  run?: RunFn
}

/** Registers `GET /api/scopes`. */
export function registerScopes(app: FastifyInstance, deps: ScopesDeps): void {
  app.get(API_ROUTES.scopes, async (request): Promise<ScopesResponse> => {
    const scopes = await discoverScopes({
      config: deps.getConfig(),
      env: deps.env ?? process.env,
      run: deps.run,
      logger: request.log,
    })
    return ScopesResponseSchema.parse({ scopes })
  })
}
