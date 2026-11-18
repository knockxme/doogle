import type { File, Folder, Prisma } from '@prisma/client'
import type { Readable } from 'node:stream'
import { prisma } from '../../config/prisma.js'
import { verifyApiKey } from '../../middleware/api-key.middleware.js'
import { createAuditLog } from '../../utils/audit.js'
import { createFileKey } from '../crypto/file-keys.js'
import { encryptedSize, UPLOAD_CHUNK_PLAINTEXT } from '../crypto/frames.js'
import { normalizeMimeType } from '../files/content-type.js'
import { FileUnavailableError, openDecryptedStream, readableFileArgs } from '../files/decrypt-stream.js'
import { drainOrphanBlobs, purgeFileRows } from '../files/purge.js'
import { assertFolderMove, createFolder as createFolderRecord, FolderError, folderTreeIds, purgeFolderTreeRows } from '../folders/folder-service.js'
import { userAvailable } from '../storage/pool.js'
import { PoolError } from '../storage/pool-errors.js'
import { failUpload, startEncryptedUpload, UploadError, writeEncryptedChunk, type UploadedFile } from '../uploads/encrypted-upload.js'
import { DavError, type DavNode, type DavPorts, type DavUser, type UploadSession } from './ports.js'
import { TEMP_PREFIX } from './util.js'

export const DAV_SCOPE = 'dav'
const ROOT = 'root'
const FOLDER_MIME = 'httpd/unix-directory'
const CHUNK = BigInt(UPLOAD_CHUNK_PLAINTEXT)
const CHUNK_RETRIES = 3
const QUOTA_TTL_MS = 30_000
const TX = { timeout: 60_000, maxWait: 15_000 }

type Tx = Prisma.TransactionClient
type FileRow = Pick<File, 'id' | 'name' | 'folderId' | 'sizeBytes' | 'mimeType' | 'createdAt' | 'contentModifiedAt'>
type FolderRow = Pick<Folder, 'id' | 'name' | 'parentId' | 'createdAt'>

const toDb = (id: string) => (id === ROOT ? null : id)
const fromDb = (id: string | null) => id ?? ROOT

function fileNode(f: FileRow): DavNode {
  return {
    id: f.id,
    type: 'file',
    name: f.name,
    parentId: fromDb(f.folderId),
    size: Number(f.sizeBytes),
    mimeType: f.mimeType,
    createdAt: f.createdAt,
    // Content time only: updatedAt also moves on rename, which would make rclone re-download.
    modifiedAt: f.contentModifiedAt ?? f.createdAt,
  }
}

function folderNode(f: FolderRow): DavNode {
  return { id: f.id, type: 'folder', name: f.name, parentId: fromDb(f.parentId), size: 0, mimeType: FOLDER_MIME, createdAt: f.createdAt, modifiedAt: f.createdAt }
}

const rootNode = (): DavNode => ({ id: ROOT, type: 'folder', name: '', parentId: null, size: 0, mimeType: FOLDER_MIME, createdAt: new Date(0), modifiedAt: new Date(0) })

const fileSelect = { id: true, name: true, folderId: true, sizeBytes: true, mimeType: true, createdAt: true, contentModifiedAt: true } as const
const folderSelect = { id: true, name: true, parentId: true, createdAt: true } as const

/**
 * Names are stored with a case- and accent-insensitive collation (web search relies on it), so the database
 * finds candidates and the exact, case-sensitive match is picked here.
 */
async function findExact(db: Tx | typeof prisma, userId: string, parentId: string, name: string): Promise<DavNode | null> {
  const parent = toDb(parentId)
  const folders = await db.folder.findMany({ where: { userId, parentId: parent, name, deletedAt: null }, select: folderSelect, orderBy: { createdAt: 'desc' } })
  const folder = folders.find((f) => f.name === name)
  if (folder) return folderNode(folder)
  const files = await db.file.findMany({ where: { userId, folderId: parent, name, status: 'active' }, select: fileSelect, orderBy: { createdAt: 'desc' } })
  const file = files.find((f) => f.name === name)
  return file ? fileNode(file) : null
}

async function assertOwnFolder(db: Tx | typeof prisma, userId: string, folderId: string) {
  if (folderId === ROOT) return
  if ((await db.folder.count({ where: { id: folderId, userId, deletedAt: null } })) === 0) throw new DavError(409, 'Parent folder does not exist')
}

async function findNode(db: Tx | typeof prisma, userId: string, nodeId: string): Promise<DavNode | null> {
  const file = await db.file.findFirst({ where: { id: nodeId, userId, status: 'active' }, select: fileSelect })
  if (file) return fileNode(file)
  const folder = await db.folder.findFirst({ where: { id: nodeId, userId, deletedAt: null }, select: folderSelect })
  return folder ? folderNode(folder) : null
}

/** Removes a node's rows inside the transaction and returns the blobs to delete afterwards. */
async function purgeNode(tx: Tx, userId: string, node: DavNode): Promise<string[]> {
  return node.type === 'file' ? purgeFileRows(tx, userId, [node.id]) : purgeFolderTreeRows(tx, userId, node.id)
}

async function moveNode(tx: Tx, userId: string, node: DavNode, parentId: string, name: string): Promise<DavNode> {
  await assertOwnFolder(tx, userId, parentId)
  if (node.type === 'file') {
    return fileNode(await tx.file.update({ where: { id: node.id }, data: { name, folderId: toDb(parentId) }, select: fileSelect }))
  }
  try {
    await assertFolderMove(tx, userId, node.id, toDb(parentId))
  } catch (error) {
    if (error instanceof FolderError) throw new DavError(409, error.message)
    throw error
  }
  return folderNode(await tx.folder.update({ where: { id: node.id }, data: { name, parentId: toDb(parentId) }, select: folderSelect }))
}

function davErrorFor(error: unknown): unknown {
  if (error instanceof PoolError) return new DavError(507, error.message)
  if (error instanceof UploadError) {
    if (error.status === 507) return new DavError(507, error.message)
    if (error.status >= 500) return new DavError(503, error.message)
    return new DavError(409, error.message)
  }
  return error
}

async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const chunk of stream) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(parts)
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Empty files are stored as a row with no copies: there is nothing to encrypt or replicate. */
function emptyUpload(user: DavUser, args: { parentId: string; name: string; mimeType: string; modifiedAt?: Date }): UploadSession {
  return {
    async writePiece() {
      throw new DavError(400, 'Body is longer than Content-Length')
    },
    async commit() {
      await assertOwnFolder(prisma, user.id, args.parentId)
      const file = await prisma.file.create({
        data: {
          userId: user.id,
          folderId: toDb(args.parentId),
          name: args.name,
          mimeType: normalizeMimeType(args.mimeType),
          sizeBytes: 0n,
          wrappedFileKey: createFileKey(user.id).wrapped,
          encryptedSizeBytes: encryptedSize(0n),
          contentModifiedAt: args.modifiedAt ?? new Date(),
        },
        select: fileSelect,
      })
      await createAuditLog(user.id, 'UPLOAD_FILE', 'file', file.id, { name: file.name, size: '0' })
      return fileNode(file)
    },
    async abort() {},
  }
}

const quotaCache = new Map<string, { value: { usedBytes: number; availableBytes: number | null }; until: number }>()

export const familyPorts: DavPorts = {
  pieceSize: UPLOAD_CHUNK_PLAINTEXT,

  async authenticate(email, apiKey) {
    const check = await verifyApiKey(apiKey, DAV_SCOPE)
    if (!check.ok || !check.user.davEnabled) return null
    if (check.user.email.toLowerCase() !== email.trim().toLowerCase()) return null
    return { id: check.user.id, email: check.user.email }
  },

  async rootFolder() {
    return rootNode()
  },

  async child(user, parentId, name) {
    return findExact(prisma, user.id, parentId, name)
  },

  async children(user, folderId) {
    const parent = toDb(folderId)
    const [folders, files] = await Promise.all([
      prisma.folder.findMany({ where: { userId: user.id, parentId: parent, deletedAt: null }, select: folderSelect, orderBy: { createdAt: 'desc' } }),
      prisma.file.findMany({ where: { userId: user.id, folderId: parent, status: 'active' }, select: fileSelect, orderBy: { createdAt: 'desc' } }),
    ])
    // One entry per exact name, by the same rule as child(): folders first, then the newest file.
    const byName = new Map<string, DavNode>()
    for (const f of folders) if (!byName.has(f.name)) byName.set(f.name, folderNode(f))
    for (const f of files) if (!byName.has(f.name)) byName.set(f.name, fileNode(f))
    return [...byName.values()]
  },

  async createFolder(user, parentId, name) {
    try {
      const folder = await createFolderRecord(user.id, { name, parentId: toDb(parentId) })
      await createAuditLog(user.id, 'CREATE_FOLDER', 'folder', folder.id, { name: folder.name })
      return folderNode(folder)
    } catch (error) {
      if (error instanceof FolderError) throw new DavError(409, 'Parent folder does not exist')
      throw error
    }
  },

  async beginUpload(user, args) {
    if (args.size === 0) return emptyUpload(user, args)
    await assertOwnFolder(prisma, user.id, args.parentId)
    let session: { id: string }
    try {
      session = await startEncryptedUpload({ userId: user.id, plainSize: BigInt(args.size), fileName: args.name, mimeType: normalizeMimeType(args.mimeType), folderId: toDb(args.parentId) })
    } catch (error) {
      throw davErrorFor(error)
    }
    let file: UploadedFile | undefined
    return {
      async writePiece(index, data) {
        for (let attempt = 0; ; attempt++) {
          try {
            const result = await writeEncryptedChunk(session.id, BigInt(index) * CHUNK, data)
            if (result.complete) file = result.file
            return
          } catch (error) {
            // Safe to resend: the pipeline trims bytes a copy already holds.
            if (error instanceof UploadError && error.code === 'UPLOAD_CHUNK_RETRY' && attempt < CHUNK_RETRIES) {
              await wait(500 * 2 ** attempt)
              continue
            }
            throw davErrorFor(error)
          }
        }
      },
      async commit() {
        if (!file) throw new DavError(500, 'Upload did not complete')
        const stored = await prisma.file.update({ where: { id: file.id }, data: { contentModifiedAt: args.modifiedAt ?? file.createdAt }, select: fileSelect })
        quotaCache.delete(user.id)
        return fileNode(stored)
      },
      async abort(reason) {
        await failUpload(session.id, reason.slice(0, 200))
      },
    }
  },

  async readPiece(user, fileId, index) {
    const file = await prisma.file.findFirst({ where: { id: fileId, userId: user.id, status: 'active' }, ...readableFileArgs })
    if (!file) throw new DavError(404, 'Not found')
    const start = BigInt(index) * CHUNK
    if (start >= file.sizeBytes) throw new DavError(416, 'Piece out of range')
    const end = (start + CHUNK < file.sizeBytes ? start + CHUNK : file.sizeBytes) - 1n
    try {
      return await collect(await openDecryptedStream(file, { start, end }))
    } catch (error) {
      if (error instanceof FileUnavailableError) throw new DavError(503, 'File is temporarily unavailable')
      throw error
    }
  },

  async remove(user, nodeId) {
    const node = await findNode(prisma, user.id, nodeId)
    if (!node) throw new DavError(404, 'Not found')
    const orphanIds = await prisma.$transaction((tx) => purgeNode(tx, user.id, node), TX)
    quotaCache.delete(user.id)
    await createAuditLog(user.id, node.type === 'file' ? 'PERMANENT_DELETE_FILE' : 'DELETE_FOLDER', node.type, node.id, { name: node.name })
    // The rows are gone and the space is free; the blobs are deleted in the background.
    void drainOrphanBlobs(orphanIds)
  },

  async move(user, nodeId, newParentId, newName) {
    const node = await prisma.$transaction(async (tx) => {
      const current = await findNode(tx, user.id, nodeId)
      if (!current) throw new DavError(404, 'Not found')
      return moveNode(tx, user.id, current, newParentId, newName)
    }, TX)
    await createAuditLog(user.id, node.type === 'file' ? 'UPDATE_FILE' : 'UPDATE_FOLDER', node.type, node.id, { name: node.name })
    return node
  },

  async replace(user, nodeId, existingId, parentId, name) {
    const { node, orphanIds, replaced } = await prisma.$transaction(async (tx) => {
      const current = await findNode(tx, user.id, nodeId)
      if (!current) throw new DavError(404, 'Not found')
      const existing = existingId ? await findNode(tx, user.id, existingId) : null
      if (existing?.type === 'folder') {
        // Replacing a folder that contains the thing being moved would delete it first.
        const tree = await folderTreeIds(tx, user.id, existing.id)
        if (tree.has(current.id) || (current.parentId !== null && tree.has(current.parentId))) throw new DavError(409, 'Cannot replace a folder with something inside it')
      }
      const orphanIds = existing ? await purgeNode(tx, user.id, existing) : []
      const node = await moveNode(tx, user.id, current, parentId, name)
      // The upload was logged under its temporary name.
      if (current.name.startsWith(TEMP_PREFIX)) {
        await tx.auditLog.updateMany({ where: { entityId: current.id, action: 'UPLOAD_FILE' }, data: { metadata: JSON.stringify({ name, size: String(node.size) }) } })
      }
      return { node, orphanIds, replaced: existing }
    }, TX)
    quotaCache.delete(user.id)
    if (replaced) await createAuditLog(user.id, replaced.type === 'file' ? 'PERMANENT_DELETE_FILE' : 'DELETE_FOLDER', replaced.type, replaced.id, { name: replaced.name })
    void drainOrphanBlobs(orphanIds)
    return node
  },

  async quota(user) {
    const cached = quotaCache.get(user.id)
    if (cached && cached.until > Date.now()) return cached.value
    const usage = await userAvailable(user.id)
    const value = { usedBytes: Number(usage.usedBytes), availableBytes: usage.availableBytes === null ? null : Number(usage.availableBytes) }
    if (quotaCache.size > 1_000) quotaCache.clear()
    quotaCache.set(user.id, { value, until: Date.now() + QUOTA_TTL_MS })
    return value
  },
}

/** Upload leftovers: a crash between the upload and its rename leaves a hidden temp file. Removes those older than a day. */
export async function sweepDavTempFiles(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const leftovers = await prisma.file.findMany({ where: { name: { startsWith: TEMP_PREFIX }, createdAt: { lt: cutoff } }, select: { id: true, userId: true } })
  for (const file of leftovers) {
    const orphanIds = await prisma.$transaction((tx) => purgeFileRows(tx, file.userId, [file.id]), TX)
    await drainOrphanBlobs(orphanIds)
  }
  return leftovers.length
}
