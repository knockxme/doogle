import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { drainOrphanBlobs, purgeFileRows } from '../files/purge.js'

type Db = Prisma.TransactionClient | typeof prisma

export const DEFAULT_FOLDER_COLOR = '#3b82f6'
export const DEFAULT_FOLDER_ICON_URL = 'https://api.iconify.design/lucide:folder.svg'

export class FolderError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message)
  }
}

const folderSelect = { id: true, name: true, color: true, iconUrl: true, parentId: true, createdAt: true, updatedAt: true } as const

async function assertParent(db: Db, userId: string, parentId: string | null) {
  if (parentId && (await db.folder.count({ where: { id: parentId, userId, deletedAt: null } })) === 0) {
    throw new FolderError(404, 'FOLDER_NOT_FOUND', 'Folder not found.')
  }
}

export async function createFolder(userId: string, args: { name: string; parentId: string | null; color?: string; iconUrl?: string | null }) {
  await assertParent(prisma, userId, args.parentId)
  return prisma.folder.create({
    data: { userId, name: args.name, color: args.color ?? DEFAULT_FOLDER_COLOR, iconUrl: args.iconUrl ?? DEFAULT_FOLDER_ICON_URL, parentId: args.parentId },
    select: folderSelect,
  })
}

/** The folder and every live folder below it. */
export async function folderTreeIds(db: Db, userId: string, rootId: string): Promise<Set<string>> {
  const folders = await db.folder.findMany({ where: { userId, deletedAt: null }, select: { id: true, parentId: true } })
  const ids = new Set<string>([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const folder of folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id)
        changed = true
      }
    }
  }
  return ids
}

/** Refuses moving a folder into itself, a child folder, or a folder that does not belong to the user. */
export async function assertFolderMove(db: Db, userId: string, folderId: string, newParentId: string | null) {
  if (newParentId === folderId) throw new FolderError(400, 'FOLDER_INVALID_PARENT', 'Folder cannot be moved into itself.')
  if (!newParentId) return
  await assertParent(db, userId, newParentId)
  if ((await folderTreeIds(db, userId, folderId)).has(newParentId)) {
    throw new FolderError(400, 'FOLDER_INVALID_PARENT', 'Folder cannot be moved into itself or a child folder.')
  }
}

/**
 * Inside the caller's transaction: removes the folder tree and every file in it (trash included) for good,
 * queueing their blobs. Returns the queued blob ids for drainOrphanBlobs.
 */
export async function purgeFolderTreeRows(tx: Prisma.TransactionClient, userId: string, rootId: string): Promise<string[]> {
  const ids = [...(await folderTreeIds(tx, userId, rootId))]
  const files = await tx.file.findMany({ where: { userId, folderId: { in: ids } }, select: { id: true } })
  const orphanIds = await purgeFileRows(tx, userId, files.map((f) => f.id))
  await tx.folder.updateMany({ where: { id: { in: ids }, userId }, data: { deletedAt: new Date() } })
  return orphanIds
}

/** Deletes a folder tree and all its files for good, then deletes their blobs. */
export async function deleteFolderTree(userId: string, rootId: string): Promise<void> {
  const orphanIds = await prisma.$transaction((tx) => purgeFolderTreeRows(tx, userId, rootId), { timeout: 60_000, maxWait: 15_000 })
  await drainOrphanBlobs(orphanIds)
}
