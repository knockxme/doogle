import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { hashPassword, verifyPassword } from '../../utils/password.js'
import { hashToken, randomToken } from '../../utils/crypto.js'
import { signAccessToken } from '../../utils/jwt.js'
import { createLoginLimiter } from '../../utils/rate-limit.js'

export const authRouter = Router()

const loginLimiter = createLoginLimiter(5, 15 * 60_000)

type SessionUser = { id: string; name: string; email: string; role: string; mustChangePassword: boolean }
function publicUser(user: SessionUser) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, mustChangePassword: user.mustChangePassword }
}

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) })
const refreshSchema = z.object({ refreshToken: z.string().min(1) })
const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8) })

async function createSession(userId: string, req: AuthRequest) {
  const refreshToken = randomToken()
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
  const session = await prisma.userSession.create({
    data: {
      userId,
      refreshTokenHash: hashToken(refreshToken),
      userAgent: req.header('User-Agent'),
      ipAddress: req.ip,
      expiresAt,
    },
  })
  return { accessToken: signAccessToken({ sub: userId, sid: session.id }), refreshToken }
}

authRouter.post('/login', async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body)
    const key = `${body.email.toLowerCase()}|${req.ip ?? ''}`
    if (!loginLimiter.check(key, Date.now())) return res.status(429).json({ code: 'AUTH_RATE_LIMITED', message: 'Too many failed attempts. Try again later.' })
    const user = await prisma.user.findUnique({ where: { email: body.email } })
    if (!user || !(await verifyPassword(user.passwordHash, body.password))) return res.status(401).json({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid email or password.' })
    if (user.status !== 'active') return res.status(403).json({ code: 'USER_DISABLED', message: 'This account is disabled.' })
    loginLimiter.reset(key)
    const tokens = await createSession(user.id, req)
    return res.json({ ...tokens, user: publicUser(user) })
  } catch (error) {
    return next(error)
  }
})

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const body = refreshSchema.parse(req.body)
    const session = await prisma.userSession.findFirst({ where: { refreshTokenHash: hashToken(body.refreshToken), revokedAt: null, expiresAt: { gt: new Date() } } })
    if (!session) return res.status(401).json({ code: 'AUTH_SESSION_EXPIRED', message: 'Refresh token expired.' })
    const owner = await prisma.user.findUnique({ where: { id: session.userId }, select: { status: true } })
    if (!owner || owner.status !== 'active') return res.status(403).json({ code: 'USER_DISABLED', message: 'This account is disabled.' })
    return res.json({ accessToken: signAccessToken({ sub: session.userId, sid: session.id }) })
  } catch (error) {
    return next(error)
  }
})

authRouter.post('/logout', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    await prisma.userSession.update({ where: { id: req.user!.sessionId }, data: { revokedAt: new Date() } })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

authRouter.get('/me', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { id: true, name: true, email: true, status: true, role: true, mustChangePassword: true } })
    return res.json({ user })
  } catch (error) {
    return next(error)
  }
})

authRouter.post('/change-password', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = changePasswordSchema.parse(req.body)
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } })
    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) return res.status(401).json({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Current password is incorrect.' })
    const passwordHash = await hashPassword(body.newPassword)
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } }),
      prisma.userSession.updateMany({ where: { userId: user.id, id: { not: req.user!.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } }),
    ])
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})
