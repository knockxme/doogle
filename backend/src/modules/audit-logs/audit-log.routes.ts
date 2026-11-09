import { Router } from 'express'
import { prisma } from '../../config/prisma.js'
import { requireAdmin } from '../../middleware/admin.middleware.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'

export const auditLogRouter = Router()

auditLogRouter.get('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 100
    })
    return res.json({ logs })
  } catch (error) {
    return next(error)
  }
})

/** Admin overview: what happened and who did it, never what it was about. No metadata, no entity id. */
auditLogRouter.get('/all', requireAuth, requireAdmin, async (_req: AuthRequest, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany({
      select: { action: true, entityType: true, createdAt: true, user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    return res.json({ logs })
  } catch (error) {
    return next(error)
  }
})
