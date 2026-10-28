import {
  API_ROUTES,
  DeleteTeamTemplateResponseSchema,
  LaunchTeamTemplateResponseSchema,
  ListTeamTemplatesResponseSchema,
  TeamTemplateParamsSchema,
  TeamTemplateResponseSchema,
  UpsertTeamTemplateRequestSchema,
  type DeleteTeamTemplateResponse,
  type LaunchTeamTemplateResponse,
  type ListTeamTemplatesResponse,
  type TeamTemplateResponse,
} from '@paneful-manager/shared'
import type { FastifyInstance } from 'fastify'
import { AppError } from '../errors.js'
import type { TeamTemplateLauncher } from './launch.js'
import type { TeamTemplateStore } from './store.js'

export interface RegisterTeamTemplatesOptions {
  store: TeamTemplateStore
  /** Without a launcher (no session engine) the launch route is not registered. */
  launcher?: TeamTemplateLauncher
  /** Live `experimental.agentTeams`; every route answers 404 while it is off. */
  enabled: () => boolean
}

/** REST routes for team templates; mutations are guarded by the security hook. */
export function registerTeamTemplates(app: FastifyInstance, { store, launcher, enabled }: RegisterTeamTemplatesOptions): void {
  app.addHook('preHandler', async request => {
    const path = request.routeOptions.url ?? ''
    if (path.startsWith(API_ROUTES.teamTemplates) && !enabled()) {
      throw new AppError('Team templates need experimental.agentTeams', 404, 'not_found')
    }
  })

  app.get(API_ROUTES.teamTemplates, async (): Promise<ListTeamTemplatesResponse> =>
    ListTeamTemplatesResponseSchema.parse({ templates: await store.list(), launches: launcher?.launches() ?? [] }))

  app.get(API_ROUTES.teamTemplate, async (request): Promise<TeamTemplateResponse> => {
    const { name } = TeamTemplateParamsSchema.parse(request.params)
    return TeamTemplateResponseSchema.parse({ template: await store.get(name) })
  })

  app.post(API_ROUTES.teamTemplates, async (request, reply): Promise<TeamTemplateResponse> => {
    const { template } = UpsertTeamTemplateRequestSchema.parse(request.body)
    reply.code(201)
    return TeamTemplateResponseSchema.parse({ template: await store.create(template) })
  })

  app.put(API_ROUTES.teamTemplate, async (request): Promise<TeamTemplateResponse> => {
    const { name } = TeamTemplateParamsSchema.parse(request.params)
    const { template } = UpsertTeamTemplateRequestSchema.parse(request.body)
    return TeamTemplateResponseSchema.parse({ template: await store.update(name, template) })
  })

  app.delete(API_ROUTES.teamTemplate, async (request): Promise<DeleteTeamTemplateResponse> => {
    const { name } = TeamTemplateParamsSchema.parse(request.params)
    await store.remove(name)
    await launcher?.forget(name)
    return DeleteTeamTemplateResponseSchema.parse({ name, deleted: true })
  })

  if (launcher !== undefined) {
    app.post(API_ROUTES.teamTemplateLaunch, async (request, reply): Promise<LaunchTeamTemplateResponse> => {
      const { name } = TeamTemplateParamsSchema.parse(request.params)
      reply.code(201)
      return LaunchTeamTemplateResponseSchema.parse(await launcher.launch(name))
    })
  }
}
