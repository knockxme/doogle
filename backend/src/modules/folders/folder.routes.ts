import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { assertFolderMove, createFolder, deleteFolderTree, FolderError } from './folder-service.js'
import { createAuditLog } from '../../utils/audit.js'

export const folderRouter = Router()
folderRouter.use(requireAuth)

const iconUrlSchema = z.string().url().startsWith('https://api.iconify.design/lucide:').max(2048)
const colorSchema = z.string().regex(/^(#[0-9a-fA-F]{6}|text-[a-z]+-[0-9]+)$/).max(64)

const createSchema = z.object({
  name: z.string().min(1).max(255),
  color: colorSchema.optional(),
  iconUrl: iconUrlSchema.nullable().optional(),
  parentId: z.string().nullable().optional(),
})

const folderSelect = { id: true, name: true, color: true, iconUrl: true, parentId: true, createdAt: true, updatedAt: true } as const

function serializeFolder(folder: { id: string; name: string; color: string; iconUrl?: string | null; parentId?: string | null; createdAt: Date; updatedAt: Date }) {
  return { ...folder, createdAt: folder.createdAt.toISOString(), updatedAt: folder.updatedAt.toISOString() }
}

folderRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const query = z.object({ parentId: z.string().nullable().optional(), all: z.string().optional() }).parse(req.query)
    const folders = await prisma.folder.findMany({
      where: { userId: req.user!.id, deletedAt: null, ...(query.all === '1' ? {} : { parentId: query.parentId ?? null }) },
      select: folderSelect,
      orderBy: { updatedAt: 'desc' },
    })
    return res.json({ folders: folders.map(serializeFolder) })
  } catch (error) {
    if (error instanceof FolderError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

folderRouter.get('/recent', async (req: AuthRequest, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 4), 4)
    const folders = await prisma.folder.findMany({
      where: { userId: req.user!.id, deletedAt: null },
      select: folderSelect,
      orderBy: { updatedAt: 'desc' },
      take: limit,
    })
    return res.json({ folders: folders.map(serializeFolder) })
  } catch (error) {
    if (error instanceof FolderError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

folderRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const body = createSchema.parse(req.body)
    const folder = await createFolder(req.user!.id, { name: body.name, parentId: body.parentId ?? null, color: body.color, iconUrl: body.iconUrl })
    await createAuditLog(req.user!.id, 'CREATE_FOLDER', 'folder', folder.id, { name: folder.name })
    return res.status(201).json({ folder: serializeFolder(folder) })
  } catch (error) {
    if (error instanceof FolderError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

folderRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try {
    const body = createSchema.partial().parse(req.body)
    const folderId = String(req.params.id)
    await prisma.folder.findFirstOrThrow({ where: { id: folderId, userId: req.user!.id, deletedAt: null } })
    if (body.parentId !== undefined) await assertFolderMove(prisma, req.user!.id, folderId, body.parentId)

    const folder = await prisma.folder.updateMany({
      where: { id: folderId, userId: req.user!.id, deletedAt: null },
      data: { ...(body.name ? { name: body.name } : {}), ...(body.color ? { color: body.color } : {}), ...(body.iconUrl !== undefined ? { iconUrl: body.iconUrl } : {}), ...(body.parentId !== undefined ? { parentId: body.parentId } : {}) },
    })
    if (folder.count === 0) return res.status(404).json({ code: 'FOLDER_NOT_FOUND', message: 'Folder not found.' })
    const updated = await prisma.folder.findFirstOrThrow({
      where: { id: folderId, userId: req.user!.id },
      select: folderSelect,
    })
    await createAuditLog(req.user!.id, 'UPDATE_FOLDER', 'folder', updated.id, { name: updated.name, updates: body })
    return res.json({ folder: serializeFolder(updated) })
  } catch (error) {
    if (error instanceof FolderError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

folderRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const root = await prisma.folder.findFirstOrThrow({ where: { id: String(req.params.id), userId: req.user!.id, deletedAt: null } })
    // Every file in the tree goes for good, trash included, so nothing is left pointing at a deleted folder.
    await deleteFolderTree(req.user!.id, root.id)
    await createAuditLog(req.user!.id, 'DELETE_FOLDER', 'folder', root.id, { name: root.name })
    return res.json({ status: 'ok' })
  } catch (error) {
    if (error instanceof FolderError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})
