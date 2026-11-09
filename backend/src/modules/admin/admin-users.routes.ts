import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireAdmin } from '../../middleware/admin.middleware.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { hashPassword } from '../../utils/password.js'
import { assertNotLastAdmin } from './admin-rules.js'

export const adminUsersRouter = Router()
adminUsersRouter.use(requireAuth, requireAdmin)

const limitSchema = z.union([z.coerce.bigint().nonnegative(), z.null()])
const createSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  temporaryPassword: z.string().min(8),
  storageLimitBytes: limitSchema.default(null),
})
const patchSchema = z.object({
  storageLimitBytes: limitSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
})
const resetSchema = z.object({ temporaryPassword: z.string().min(8) })

function serialize(user: { id: string; name: string; email: string; role: string; status: string; mustChangePassword: boolean; storageLimitBytes: bigint | null; createdAt: Date }, usedBytes = 0n, fileCount = 0) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    storageLimitBytes: user.storageLimitBytes === null ? null : user.storageLimitBytes.toString(),
    usedBytes: usedBytes.toString(),
    fileCount,
    createdAt: user.createdAt,
  }
}

function countActiveAdmins() {
  return prisma.user.count({ where: { role: 'admin', status: 'active' } })
}

adminUsersRouter.get('/', async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } })
    const usage = await prisma.file.groupBy({ by: ['userId'], where: { status: { not: 'deleted' } }, _sum: { sizeBytes: true }, _count: { _all: true } })
    const byUser = new Map(usage.map((row) => [row.userId, row]))
    return res.json({ users: users.map((u) => serialize(u, byUser.get(u.id)?._sum.sizeBytes ?? 0n, byUser.get(u.id)?._count._all ?? 0)) })
  } catch (error) {
    return next(error)
  }
})

adminUsersRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body)
    const existing = await prisma.user.findUnique({ where: { email: body.email } })
    if (existing) return res.status(409).json({ code: 'USER_EMAIL_TAKEN', message: 'Email already in use.' })
    const user = await prisma.user.create({
      data: { name: body.name, email: body.email, passwordHash: await hashPassword(body.temporaryPassword), role: 'member', mustChangePassword: true, storageLimitBytes: body.storageLimitBytes },
    })
    return res.status(201).json({ user: serialize(user) })
  } catch (error) {
    return next(error)
  }
})

adminUsersRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try {
    const body = patchSchema.parse(req.body)
    const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } })
    if (!target) return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'User not found.' })
    if (body.status === 'disabled') assertNotLastAdmin(await countActiveAdmins(), target)
    const data: { status?: string; storageLimitBytes?: bigint | null } = {}
    if (body.status !== undefined) data.status = body.status
    if (body.storageLimitBytes !== undefined) data.storageLimitBytes = body.storageLimitBytes
    const user = await prisma.user.update({ where: { id: target.id }, data })
    return res.json({ user: serialize(user) })
  } catch (error) {
    return next(error)
  }
})

adminUsersRouter.post('/:id/reset-password', async (req, res, next) => {
  try {
    const body = resetSchema.parse(req.body)
    const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } })
    if (!target) return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'User not found.' })
    await prisma.$transaction([
      prisma.user.update({ where: { id: target.id }, data: { passwordHash: await hashPassword(body.temporaryPassword), mustChangePassword: true } }),
      prisma.userSession.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ])
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

adminUsersRouter.delete('/:id', async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } })
    if (!target) return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'User not found.' })
    assertNotLastAdmin(await countActiveAdmins(), target)
    // Permanent file removal is wired in Task 9; until then refuse deleting users who own files.
    if ((await prisma.file.count({ where: { userId: target.id } })) > 0) return res.status(409).json({ code: 'USER_HAS_FILES', message: 'User still owns files and cannot be deleted yet.' })
    if ((await prisma.connectedAccount.count({ where: { userId: target.id } })) > 0) return res.status(409).json({ code: 'USER_HAS_CONNECTED_ACCOUNTS', message: 'User still owns connected accounts and cannot be deleted.' })
    await prisma.user.delete({ where: { id: target.id } })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})
