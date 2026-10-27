import {
  API_ROUTES,
  WorktreeCopyApplyRequestSchema,
  WorktreeCopyApplyResponseSchema,
  WorktreeCopyPlanRequestSchema,
  WorktreeCopyPlanResponseSchema,
  WorktreeDiffRequestSchema,
  WorktreeDiffResponseSchema,
  type WorktreeCopyApplyResponse,
  type WorktreeCopyPlanResponse,
  type WorktreeDiffResponse,
} from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import { planCopy } from './candidates.js'
import { applyCopy, diffFile, type WorktreeDeps } from './copy.js'

export type { WorktreeDeps }

/** Registers the worktree helper routes; all are POST, so the global token check covers them. */
export function registerWorktrees(app: FastifyInstance, deps: WorktreeDeps): void {
  app.post(API_ROUTES.worktreeCopyPlan, async (request): Promise<WorktreeCopyPlanResponse> => {
    const { worktreePath } = WorktreeCopyPlanRequestSchema.parse(request.body)
    return WorktreeCopyPlanResponseSchema.parse(await planCopy(await deps.getScopes(), worktreePath, deps.run))
  })

  app.post(API_ROUTES.worktreeCopyApply, async (request): Promise<WorktreeCopyApplyResponse> => {
    const body = WorktreeCopyApplyRequestSchema.parse(request.body)
    return WorktreeCopyApplyResponseSchema.parse(await applyCopy(deps, body))
  })

  app.post(API_ROUTES.worktreeDiff, async (request): Promise<WorktreeDiffResponse> => {
    const { worktreePath, relPath } = WorktreeDiffRequestSchema.parse(request.body)
    return WorktreeDiffResponseSchema.parse(await diffFile(deps, worktreePath, relPath))
  })
}

