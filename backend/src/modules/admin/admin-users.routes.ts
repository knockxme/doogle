import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireAdmin } from '../../middleware/admin.middleware.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { deletableFileArgs, deleteFileCopies, refreshQuotasAfterDelete } from '../files/delete-blobs.js'
import { failUpload } from '../uploads/encrypted-upload.js'
import { hashPassword } from '../../utils/password.js'
import { assertNotLastAdmin } from './admin-rules.js'
import { forgetDavLogins } from '../webdav/logins.js'
import { DAV_SCOPE } from '../webdav/family-ports.js'

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
  davEnabled: z.boolean().optional(),
})
const resetSchema = z.object({ temporaryPassword: z.string().min(8) })

function serialize(user: { id: string; name: string; email: string; role: string; status: string; mustChangePassword: boolean; davEnabled: boolean; storageLimitBytes: bigint | null; createdAt: Date }, usedBytes = 0n, fileCount = 0, totalBytes = 0n, totalFileCount = 0) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    davEnabled: user.davEnabled,
    storageLimitBytes: user.storageLimitBytes === null ? null : user.storageLimitBytes.toString(),
    usedBytes: usedBytes.toString(),
    fileCount,
    // Everything a delete would remove, trash included.
    totalBytes: totalBytes.toString(),
    totalFileCount,
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
    const all = await prisma.file.groupBy({ by: ['userId'], _sum: { sizeBytes: true }, _count: { _all: true } })
    const byUser = new Map(usage.map((row) => [row.userId, row]))
    const totals = new Map(all.map((row) => [row.userId, row]))
    return res.json({ users: users.map((u) => serialize(u, byUser.get(u.id)?._sum.sizeBytes ?? 0n, byUser.get(u.id)?._count._all ?? 0, totals.get(u.id)?._sum.sizeBytes ?? 0n, totals.get(u.id)?._count._all ?? 0)) })
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
    const data: { status?: string; storageLimitBytes?: bigint | null; davEnabled?: boolean } = {}
    if (body.status !== undefined) data.status = body.status
    if (body.storageLimitBytes !== undefined) data.storageLimitBytes = body.storageLimitBytes
    if (body.davEnabled !== undefined) data.davEnabled = body.davEnabled
    const user = await prisma.user.update({ where: { id: target.id }, data })
    if (body.davEnabled === false) {
      // Turning WebDAV off revokes the keys that used it.
      const keys = await prisma.apiKey.findMany({ where: { userId: target.id, revokedAt: null }, select: { id: true, scopes: true } })
      const davKeys = keys.filter((k) => Array.isArray(k.scopes) && k.scopes.includes(DAV_SCOPE)).map((k) => k.id)
      if (davKeys.length > 0) await prisma.apiKey.updateMany({ where: { id: { in: davKeys } }, data: { status: 'revoked', revokedAt: new Date() } })
    }
    if (body.status === 'disabled' || body.davEnabled === false) forgetDavLogins()
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
    // Keys stop working until the new password is chosen; drop any cached WebDAV login now.
    forgetDavLogins()
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
    if ((await prisma.connectedAccount.count({ where: { userId: target.id } })) > 0) return res.status(409).json({ code: 'USER_HAS_CONNECTED_ACCOUNTS', message: 'User still owns connected accounts and cannot be deleted.' })
    // Stop new activity, then abort in-flight uploads so their provider sessions and blobs are cleaned up before any cascade.
    await prisma.user.update({ where: { id: target.id }, data: { status: 'disabled' } })
    const sessions = await prisma.uploadSession.findMany({ where: { userId: target.id, status: 'uploading' }, select: { id: true } })
    for (const session of sessions) await failUpload(session.id, 'User was deleted.')
    // Files go next, with both copies. A file whose delete fails stops the user delete so nothing is left unowned.
    const files = await prisma.file.findMany({ where: { userId: target.id }, ...deletableFileArgs })
    for (const file of files) {
      await deleteFileCopies(file)
      await prisma.file.delete({ where: { id: file.id } })
    }
    await prisma.user.delete({ where: { id: target.id } })
    forgetDavLogins()
    refreshQuotasAfterDelete(files)
    return res.json({ status: 'ok', deletedFiles: files.length })
  } catch (error) {
    return next(error)
  }
})
