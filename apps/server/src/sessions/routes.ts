import {
  API_ROUTES,
  CreateSessionRequestSchema,
  SessionParamsSchema,
  type CreateSessionResponse,
  type KillSessionResponse,
  type ListSessionsResponse,
} from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import type { SessionEngine } from './engine.js'

export interface RegisterSessionsOptions {
  engine: SessionEngine
}

/** REST routes for sessions: list, create, kill. */
export function registerSessions(app: FastifyInstance, { engine }: RegisterSessionsOptions): void {
  app.get(API_ROUTES.sessions, (): ListSessionsResponse => ({ sessions: engine.list() }))

  app.post(API_ROUTES.sessions, async (request, reply): Promise<CreateSessionResponse> => {
    const input = CreateSessionRequestSchema.parse(request.body ?? {})
    const session = await engine.create(input)
    reply.code(201)
    return { session }
  })

  app.delete(API_ROUTES.session, async (request): Promise<KillSessionResponse> => {
    const { id } = SessionParamsSchema.parse(request.params)
    await engine.kill(id)
    return { id, killed: true }
  })
}
