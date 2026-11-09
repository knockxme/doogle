import type { NextFunction, Response } from 'express'
import type { AuthRequest } from './auth.middleware.js'

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') return res.status(403).json({ code: 'ADMIN_REQUIRED', message: 'Admin access required.' })
  return next()
}
