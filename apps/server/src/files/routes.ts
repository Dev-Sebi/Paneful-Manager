import {
  API_ROUTES,
  CreateFileRequestSchema,
  CreateFileResponseSchema,
  DeleteFileQuerySchema,
  DeleteFileResponseSchema,
  ListFilesQuerySchema,
  ListFilesResponseSchema,
  ReadFileQuerySchema,
  ReadFileResponseSchema,
  WriteFileRequestSchema,
  WriteFileResponseSchema,
  type CreateFileResponse,
  type DeleteFileResponse,
  type ListFilesResponse,
  type ReadFileResponse,
  type WriteFileResponse,
} from '@paneful-manager/shared'
import type { FastifyInstance } from 'fastify'
import type { FileService } from './service.js'

export interface FilesDeps {
  service: FileService
}

/** Registers the managed-file routes: list/create on `/api/files`, read/write/delete on `/api/files/content`. */
export function registerFiles(app: FastifyInstance, { service }: FilesDeps): void {
  app.get(API_ROUTES.files, async (request): Promise<ListFilesResponse> => {
    const query = ListFilesQuerySchema.parse(request.query)
    return ListFilesResponseSchema.parse({ files: await service.list(query) })
  })

  app.post(API_ROUTES.files, async (request, reply): Promise<CreateFileResponse> => {
    const body = CreateFileRequestSchema.parse(request.body)
    const response = CreateFileResponseSchema.parse({ file: await service.create(body) })
    reply.code(201)
    return response
  })

  app.get(API_ROUTES.fileContent, async (request): Promise<ReadFileResponse> => {
    const { path } = ReadFileQuerySchema.parse(request.query)
    return ReadFileResponseSchema.parse({ file: await service.read(path) })
  })

  app.put(API_ROUTES.fileContent, async (request): Promise<WriteFileResponse> => {
    const body = WriteFileRequestSchema.parse(request.body)
    return WriteFileResponseSchema.parse({ file: await service.write(body) })
  })

  app.delete(API_ROUTES.fileContent, async (request): Promise<DeleteFileResponse> => {
    const { path } = DeleteFileQuerySchema.parse(request.query)
    await service.delete(path)
    return DeleteFileResponseSchema.parse({ path, deleted: true })
  })
}
