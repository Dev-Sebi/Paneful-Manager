import {
  API_ROUTES,
  ListMcpServersQuerySchema,
  ListMcpServersResponseSchema,
  McpHealthListResponseSchema,
  McpHealthQuerySchema,
  McpHealthRequestSchema,
  McpHealthResultSchema,
  RemoveMcpServerRequestSchema,
  RemoveMcpServerResponseSchema,
  UpsertMcpServerRequestSchema,
  UpsertMcpServerResponseSchema,
  type ListMcpServersResponse,
  type McpHealthListResponse,
  type McpHealthResult,
  type RemoveMcpServerResponse,
  type UpsertMcpServerResponse,
} from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import { createHealthRunner, type HealthRunner } from './health.js'
import type { McpService } from './service.js'

export interface McpDeps {
  service: McpService
  /** Defaults to a runner with 4 concurrent checks and an 8 s timeout. */
  health?: HealthRunner
}

/**
 * Registers `GET /api/mcp?projectPath=`, `PUT /api/mcp` (upsert) and `DELETE /api/mcp` (body `{ name, scope }`),
 * plus `POST /api/mcp/health` (body `{ name, scope }`) and `GET /api/mcp/health?projectPath=` (all entries).
 */
export function registerMcp(app: FastifyInstance, { service, health = createHealthRunner() }: McpDeps): void {
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

  app.post(API_ROUTES.mcpHealth, async (request): Promise<McpHealthResult> => {
    const body = McpHealthRequestSchema.parse(request.body)
    return McpHealthResultSchema.parse(await health.check(await service.entry(body.name, body.scope)))
  })

  app.get(API_ROUTES.mcpHealth, async (request): Promise<McpHealthListResponse> => {
    const query = McpHealthQuerySchema.parse(request.query)
    const entries = await service.entries(query)
    return McpHealthListResponseSchema.parse({ results: await Promise.all(entries.map(entry => health.check(entry))) })
  })
}
