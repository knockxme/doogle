import type { NextFunction, Request, Response } from 'express'
import { prisma } from '../config/prisma.js'
import { verifyAccessToken } from '../utils/jwt.js'

export type AuthRequest = Request & {
  user?: { id: string; sessionId: string; role: string }
}

const PASSWORD_CHANGE_EXEMPT = new Set(['/auth/change-password', '/auth/me', '/auth/logout'])

function requestPath(req: Request) {
  const path = req.originalUrl.split('?')[0] ?? ''
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

export function isPasswordChangeExempt(req: Request) {
  return PASSWORD_CHANGE_EXEMPT.has(requestPath(req))
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const header = req.header('Authorization')
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Bearer token required.' })
    const payload = verifyAccessToken(header.slice(7))
    const session = await prisma.userSession.findUnique({ where: { id: payload.sid } })
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.userId !== payload.sub) return res.status(401).json({ code: 'AUTH_SESSION_EXPIRED', message: 'Session expired.' })
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, role: true, status: true, mustChangePassword: true } })
    if (!user) return res.status(401).json({ code: 'AUTH_INVALID_TOKEN', message: 'Invalid token.' })
    if (user.status !== 'active') return res.status(403).json({ code: 'USER_DISABLED', message: 'This account is disabled.' })
    if (user.mustChangePassword && !isPasswordChangeExempt(req)) return res.status(403).json({ code: 'PASSWORD_CHANGE_REQUIRED', message: 'Password change required.' })
    req.user = { id: user.id, sessionId: payload.sid, role: user.role }
    return next()
  } catch {
    return res.status(401).json({ code: 'AUTH_INVALID_TOKEN', message: 'Invalid token.' })
  }
}
