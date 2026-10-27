import { API_ROUTES, type ListTeamsResponse } from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import type { TeamsService } from './service.js'

export interface TeamsRouteDeps {
  service: TeamsService
}

/** GET /api/teams: read-only; with the flag off nothing is read from disk. */
export function registerTeams(app: FastifyInstance, { service }: TeamsRouteDeps): void {
  app.get(API_ROUTES.teams, async (): Promise<ListTeamsResponse> => {
    await service.sync()
    return service.list()
  })
}
