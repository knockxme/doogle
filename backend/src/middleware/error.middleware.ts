import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'
import { PoolError } from '../modules/storage/pool-errors.js'

export function errorMiddleware(error: unknown, req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid request.' })
  if (error instanceof Error && (error as { code?: unknown }).code === 'LAST_ADMIN') return res.status(409).json({ code: 'LAST_ADMIN', message: error.message })
  if (error instanceof PoolError) return res.status(error.status).json({ code: error.code, message: error.message })
  if (error instanceof Error && (error as { code?: unknown }).code === 'P2025') return res.status(404).json({ code: 'NOT_FOUND', message: 'Not found.' })
  // Only the error name reaches the log: messages from Prisma or the Google client can carry values.
  console.error(`Unhandled error on ${req.method} ${req.path}:`, error instanceof Error ? error.name : 'unknown error')
  if (res.headersSent) return res.destroy()
  return res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong on the server.' })
}
