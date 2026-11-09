import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'

export function errorMiddleware(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid request.' })
  if (error instanceof Error && (error as { code?: unknown }).code === 'LAST_ADMIN') return res.status(409).json({ code: 'LAST_ADMIN', message: error.message })
  const message = error instanceof Error ? error.message : 'Internal server error'
  return res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message })
}
