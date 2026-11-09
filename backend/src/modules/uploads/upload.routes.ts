import Busboy from 'busboy'
import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import type { Readable } from 'node:stream'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { UPLOAD_CHUNK_PLAINTEXT } from '../crypto/frames.js'
import { PoolError } from '../storage/pool-errors.js'
import { failUpload, resumeOffset, startEncryptedUpload, UploadError, writeEncryptedChunk, type UploadedFile } from './encrypted-upload.js'

export const uploadRouter = Router()

const CHUNK = BigInt(UPLOAD_CHUNK_PLAINTEXT)
const sizeString = z.string().regex(/^-?\d+$/)
const fileNameSchema = z.string().min(1).max(255)
const mimeTypeSchema = z.string().min(1).max(191)
const filesMetaSchema = z.array(z.object({
  fieldName: z.string(),
  fileName: fileNameSchema,
  mimeType: mimeTypeSchema,
  sizeBytes: z.union([sizeString, z.number().int()]).transform((v) => BigInt(v)),
  folderId: z.string().nullable().optional(),
}))

type UploadMeta = { fieldName: string; fileName: string; mimeType: string; sizeBytes: bigint; folderId?: string | null }

function logUpload(message: string, metadata?: Record<string, unknown>) {
  console.info('[upload]', message, metadata ?? '')
}

function serializeFile(file: UploadedFile) {
  return { ...file, sizeBytes: file.sizeBytes.toString() }
}

function chunkLength(offset: bigint, size: bigint) {
  return Number(size - offset < CHUNK ? size - offset : CHUNK)
}

async function ownedFolderExists(folderId: string, userId: string) {
  return (await prisma.folder.count({ where: { id: folderId, userId, deletedAt: null } })) > 0
}

const sizeMismatch = () => new UploadError(400, 'UPLOAD_SIZE_MISMATCH', 'Streamed byte count did not match declared size.')

/**
 * Reassembles a multipart file stream into upload chunks. Each await pauses the stream, so at most one
 * chunk is held. The last chunk waits for end of stream, so an overrun can never become a finished file.
 */
async function pumpFileStream(stream: Readable, sessionId: string, size: bigint) {
  let offset = 0n
  let received = 0n
  let filled = 0
  let chunk = Buffer.alloc(chunkLength(offset, size))
  for await (const data of stream.iterator({ destroyOnReturn: false })) {
    let piece = data as Buffer
    received += BigInt(piece.length)
    if (received > size) throw sizeMismatch()
    while (piece.length > 0) {
      const copied = piece.copy(chunk, filled)
      filled += copied
      piece = piece.subarray(copied)
      if (filled === chunk.length && offset + BigInt(chunk.length) < size) {
        await writeEncryptedChunk(sessionId, offset, chunk)
        offset += BigInt(chunk.length)
        filled = 0
        chunk = Buffer.alloc(chunkLength(offset, size))
      }
    }
  }
  if (received !== size) throw sizeMismatch()
  const result = await writeEncryptedChunk(sessionId, offset, chunk)
  if (!result.complete || !result.file) throw new Error('Upload did not complete.')
  return result.file
}

export async function handleUpload(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    logUpload('request started', { userId: req.user!.id, contentLength: req.headers['content-length'] })
    const contentType = req.headers['content-type']
    if (!contentType?.includes('multipart/form-data')) return res.status(400).json({ code: 'UPLOAD_INVALID_CONTENT_TYPE', message: 'multipart/form-data required.' })

    // One byte past the limit, so a file over it arrives long enough to fail the size check instead of being cut to fit.
    const busboy = Busboy({ headers: req.headers, limits: { files: 25, fileSize: env.MAX_UPLOAD_BYTES + 1 } })
    const fields: { sizeBytes?: bigint; fileName?: string; mimeType?: string; folderId?: string } = {}
    let batchMeta: UploadMeta[] | null = null
    let responded = false
    let fileSeen = false
    const completed: Array<Record<string, unknown>> = []
    const failed: Array<{ fileName: string; code: string; message: string }> = []
    let queue: Promise<void> = Promise.resolve()

    const fail = (status: number, code: string, message: string) => {
      if (responded) return
      responded = true
      req.unpipe(busboy)
      req.resume()
      res.status(status).json({ code, message })
      // Deferred so the parser is not torn down from inside its own callback. Unblocks any file still waiting.
      setImmediate(() => busboy.destroy())
    }

    const metaForFile = (fieldName: string, info: { filename: string; mimeType: string }): UploadMeta | null | undefined => {
      if (batchMeta) return batchMeta.find((item) => item.fieldName === fieldName)
      const sizeBytes = fields.sizeBytes
      if (!sizeBytes) return null
      return { fieldName, sizeBytes, fileName: fields.fileName || info.filename, mimeType: fields.mimeType || info.mimeType || 'application/octet-stream', folderId: fields.folderId }
    }

    const uploadOne = async (meta: UploadMeta | null | undefined, fileStream: Readable, info: { filename: string }) => {
      const fileName = meta?.fileName || info.filename
      let sessionId: string | null = null
      try {
        if (!meta?.sizeBytes || meta.sizeBytes <= 0n) {
          fileStream.resume()
          failed.push({ fileName, code: 'UPLOAD_SIZE_REQUIRED', message: 'sizeBytes field must be sent before file field.' })
          return
        }
        if (meta.sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) {
          fileStream.resume()
          failed.push({ fileName, code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })
          return
        }
        const folderId = meta.folderId || null
        if (folderId && !(await ownedFolderExists(folderId, req.user!.id))) {
          fileStream.resume()
          failed.push({ fileName, code: 'FOLDER_NOT_FOUND', message: 'Folder not found.' })
          return
        }
        if (fileStream.destroyed) {
          failed.push({ fileName, code: 'UPLOAD_FAILED', message: 'Upload was interrupted.' })
          return
        }

        const session = await startEncryptedUpload({ userId: req.user!.id, plainSize: meta.sizeBytes, fileName, mimeType: meta.mimeType, folderId })
        sessionId = session.id
        const file = await pumpFileStream(fileStream, session.id, meta.sizeBytes)
        completed.push(serializeFile(file))
        logUpload('file upload completed', { sessionId: session.id, fileId: file.id })
      } catch (error) {
        fileStream.resume()
        const known = error instanceof UploadError || error instanceof PoolError
        if (sessionId) await failUpload(sessionId, known ? error.code : 'Upload failed.').catch(() => undefined)
        logUpload('file upload failed', { sessionId, message: error instanceof Error ? error.message : 'Upload failed' })
        failed.push({ fileName, code: known ? error.code : 'UPLOAD_FAILED', message: known ? error.message : 'Upload failed.' })
      }
    }

    busboy.on('field', (name, value) => {
      if (responded) return
      if (name === 'filesMeta') {
        try {
          batchMeta = filesMetaSchema.parse(JSON.parse(value))
        } catch {
          fail(400, 'VALIDATION_ERROR', 'Invalid filesMeta.')
        }
        return
      }
      if (name === 'sizeBytes') {
        const parsed = sizeString.safeParse(value)
        if (!parsed.success) return fail(400, 'VALIDATION_ERROR', 'Invalid sizeBytes.')
        fields.sizeBytes = BigInt(parsed.data)
      }
      if (name === 'fileName') {
        if (value.length > 255) return fail(400, 'VALIDATION_ERROR', 'Invalid fileName.')
        fields.fileName = value
      }
      if (name === 'mimeType') {
        if (value.length > 191) return fail(400, 'VALIDATION_ERROR', 'Invalid mimeType.')
        fields.mimeType = value
      }
      if (name === 'folderId') fields.folderId = value
    })

    busboy.on('file', (name, fileStream, info) => {
      // Busboy destroys the current file stream with an error on disconnect, possibly while this file
      // is still queued or starting. Unheard, that error would crash the process. The upload notices
      // the destroyed stream when it next touches it.
      fileStream.on('error', (error) => logUpload('file stream failed', { message: error instanceof Error ? error.message : 'Unknown error' }))
      if (responded) {
        fileStream.resume()
        return
      }
      fileSeen = true
      // Read now: later fields must not change what this file was declared as.
      const meta = metaForFile(name, info)
      queue = queue.then(() => uploadOne(meta, fileStream, info))
    })

    busboy.on('error', (error) => {
      logUpload('multipart parser failed', { message: error instanceof Error ? error.message : 'Unknown error' })
      if (!responded) {
        responded = true
        next(error)
      }
    })

    busboy.on('finish', () => {
      if (!responded && !fileSeen) return fail(400, 'UPLOAD_FILE_REQUIRED', 'file field required.')
      queue.then(() => {
        if (responded) return
        responded = true
        logUpload('response sent', { completed: completed.length, failed: failed.length })
        if (completed.length === 0) return res.status(400).json({ code: failed[0]?.code ?? 'UPLOAD_FAILED', message: failed[0]?.message ?? 'Upload failed', failed })
        if (!batchMeta && completed.length === 1 && failed.length === 0) return res.status(201).json({ file: completed[0] })
        return res.status(201).json({ files: completed, failed })
      }).catch(next)
    })

    // A client that disconnects mid-file must not leave the file's stream waiting forever.
    req.once('close', () => {
      if (!req.complete) busboy.destroy(new Error('Upload connection closed.'))
    })

    req.pipe(busboy)
  } catch (error) {
    return next(error)
  }
}

uploadRouter.post('/', requireAuth, handleUpload)

function respondWithError(res: Response, error: unknown, next: NextFunction) {
  if (error instanceof UploadError) return res.status(error.status).json({ code: error.code, message: error.message })
  return next(error)
}

const sessionNotFound = (res: Response) => res.status(404).json({ code: 'UPLOAD_SESSION_NOT_FOUND', message: 'Upload session not found.' })

uploadRouter.post('/resumable/init', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      fileName: fileNameSchema,
      mimeType: mimeTypeSchema,
      sizeBytes: sizeString,
      folderId: z.string().nullable().optional(),
    }).parse(req.body)

    const sizeBytes = BigInt(body.sizeBytes)
    if (sizeBytes <= 0n) return res.status(400).json({ code: 'UPLOAD_SIZE_REQUIRED', message: 'Valid sizeBytes required.' })
    if (sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) return res.status(400).json({ code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })

    const folderId = body.folderId || null
    if (folderId && !(await ownedFolderExists(folderId, req.user!.id))) return res.status(404).json({ code: 'FOLDER_NOT_FOUND', message: 'Folder not found.' })

    const session = await startEncryptedUpload({ userId: req.user!.id, plainSize: sizeBytes, fileName: body.fileName, mimeType: body.mimeType, folderId })
    return res.status(201).json({ sessionId: session.id, provider: 'encrypted', offset: 0, chunkSize: String(UPLOAD_CHUNK_PLAINTEXT) })
  } catch (error) {
    return respondWithError(res, error, next)
  }
})

uploadRouter.get('/resumable/status/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const session = await prisma.uploadSession.findFirst({ where: { id: String(req.params.id), userId: req.user!.id } })
    if (!session) return sessionNotFound(res)
    if (session.status === 'completed') return res.json({ status: 'completed', offset: session.sizeBytes.toString() })
    if (session.status !== 'uploading') return res.json({ status: session.status, offset: '0' })
    return res.json({ status: 'uploading', offset: (await resumeOffset(session.id)).toString() })
  } catch (error) {
    return respondWithError(res, error, next)
  }
})

type BodyResult = Buffer | 'too-large' | 'short'

/** Reads exactly `length` bytes, stopping at the first byte past it. What is left is discarded unread by Node once the response ends. */
function readChunkBody(req: AuthRequest, length: number): Promise<BodyResult> {
  if (Number(req.headers['content-length']) > length) return Promise.resolve('too-large')
  if (req.readableEnded) return Promise.resolve('short')
  return new Promise((resolve) => {
    const body = Buffer.alloc(length)
    let filled = 0
    const finish = (result: BodyResult) => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onGone)
      req.off('close', onGone)
      resolve(result)
    }
    const onData = (piece: Buffer) => {
      if (filled + piece.length > length) return finish('too-large')
      piece.copy(body, filled)
      filled += piece.length
    }
    const onEnd = () => finish(filled === length ? body : 'short')
    const onGone = () => finish('short')
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onGone)
    req.once('close', onGone)
  })
}

uploadRouter.put('/resumable/chunk/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const session = await prisma.uploadSession.findFirst({ where: { id: String(req.params.id), userId: req.user!.id } })
    if (!session) return sessionNotFound(res)

    const rangeHeader = req.headers['content-range']
    if (!rangeHeader || typeof rangeHeader !== 'string') return res.status(400).json({ code: 'MISSING_CONTENT_RANGE', message: 'Content-Range header is required.' })
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(rangeHeader)
    if (!match) return res.status(400).json({ code: 'INVALID_CONTENT_RANGE', message: 'Invalid Content-Range format.' })

    const start = BigInt(match[1]!)
    const end = BigInt(match[2]!)
    const total = BigInt(match[3]!)
    const size = session.sizeBytes
    if (total !== size || start >= size || start % CHUNK !== 0n || end < start || end - start + 1n !== BigInt(chunkLength(start, size))) {
      return res.status(400).json({ code: 'CHUNK_NOT_ALIGNED', message: 'Chunk is not aligned to the upload chunk size.' })
    }
    if (session.status === 'failed') return res.status(409).json({ code: 'UPLOAD_NOT_ACTIVE', message: 'This upload is no longer active.' })

    const body = await readChunkBody(req, chunkLength(start, size))
    if (body === 'too-large') return res.status(413).json({ code: 'CHUNK_TOO_LARGE', message: 'Chunk body is larger than declared.' })
    if (body === 'short') return res.status(400).json({ code: 'CHUNK_LENGTH_MISMATCH', message: 'Chunk body does not match its declared length.' })

    const result = await writeEncryptedChunk(session.id, start, body)
    if (result.complete && result.file) return res.status(201).json({ status: 'completed', file: serializeFile(result.file) })
    return res.json({ status: 'uploading', offset: (end + 1n).toString() })
  } catch (error) {
    return respondWithError(res, error, next)
  }
})
