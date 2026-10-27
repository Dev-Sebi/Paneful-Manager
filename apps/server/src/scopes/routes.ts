import { API_ROUTES, type AppConfig, type ScopesResponse } from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import { discoverScopes } from './discover.js'
import type { RunFn } from './run-git.js'

export interface ScopesDeps {
  config: AppConfig
  env?: Record<string, string | undefined>
  run?: RunFn
}

/** Registers `GET /api/scopes`. */
export function registerScopes(app: FastifyInstance, deps: ScopesDeps): void {
  app.get(API_ROUTES.scopes, async (request): Promise<ScopesResponse> => ({
    scopes: await discoverScopes({ config: deps.config, env: deps.env ?? process.env, run: deps.run, logger: request.log }),
  }))
}
