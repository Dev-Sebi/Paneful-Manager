import {
  API_ROUTES,
  ListMcpServersQuerySchema,
  ListMcpServersResponseSchema,
  RemoveMcpServerRequestSchema,
  RemoveMcpServerResponseSchema,
  UpsertMcpServerRequestSchema,
  UpsertMcpServerResponseSchema,
  type ListMcpServersResponse,
  type RemoveMcpServerResponse,
  type UpsertMcpServerResponse,
} from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import type { McpService } from './service.js'

export interface McpDeps {
  service: McpService
}

/** Registers `GET /api/mcp?projectPath=`, `PUT /api/mcp` (upsert) and `DELETE /api/mcp` (body `{ name, scope }`). */
export function registerMcp(app: FastifyInstance, { service }: McpDeps): void {
  app.get(API_ROUTES.mcp, async (request): Promise<ListMcpServersResponse> => {
    const query = ListMcpServersQuerySchema.parse(request.query)
    return ListMcpServersResponseSchema.parse(await service.list(query))
  })

  app.put(API_ROUTES.mcp, async (request): Promise<UpsertMcpServerResponse> => {
    const body = UpsertMcpServerRequestSchema.parse(request.body)
    return UpsertMcpServerResponseSchema.parse(await service.upsert(body))
  })

  app.delete(API_ROUTES.mcp, async (request): Promise<RemoveMcpServerResponse> => {
    const body = RemoveMcpServerRequestSchema.parse(request.body)
    await service.remove(body)
    return RemoveMcpServerResponseSchema.parse({ name: body.name, scope: body.scope, removed: true })
  })
}
