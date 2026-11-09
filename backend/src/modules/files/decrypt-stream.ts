import type { ConnectedAccount, File, FileReplica } from '@prisma/client'
import { Readable } from 'node:stream'
import { prisma } from '../../config/prisma.js'
import { openFileKey } from '../crypto/file-keys.js'
import { decryptFrame, encryptedSize, frameCount, FRAME_SIZE, FrameAuthError } from '../crypto/frames.js'
import { frameSpan, type ByteRange } from '../crypto/range.js'
import { ProviderUnavailableError, providerFor } from '../storage/provider.js'

export type FileWithReplicas = File & { replicas: (FileReplica & { connectedAccount: ConnectedAccount })[] }

/** Prisma args that load everything the read path needs (the client omits the key and size by default). */
export const readableFileArgs = {
  omit: { wrappedFileKey: false, encryptedSizeBytes: false },
  include: { replicas: { where: { status: 'healthy' }, include: { connectedAccount: true } } },
} as const

export class FileUnavailableError extends Error {
  constructor() {
    super('File is unavailable.')
    this.name = 'FileUnavailableError'
  }
}

const BATCH_FRAMES = 8

async function collect(stream: Readable, expected: number, onStream: (s: Readable | null) => void): Promise<Buffer> {
  onStream(stream)
  try {
    const parts: Buffer[] = []
    let length = 0
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += buf.length
      if (length > expected) throw new Error('Provider returned more bytes than requested.')
      parts.push(buf)
    }
    if (length !== expected) throw new Error('Provider returned fewer bytes than requested.')
    return Buffer.concat(parts, length)
  } finally {
    onStream(null)
    stream.destroy()
  }
}

/**
 * Decrypts a file (or a plaintext byte range) on the fly. The first frame batch is read and authenticated
 * before this resolves, so a caller can still answer with an error status. Later batches are pulled as the
 * consumer drains the stream. Each batch is tried on the current copy, then on the other one.
 */
export async function openDecryptedStream(file: FileWithReplicas, range: ByteRange | null): Promise<Readable> {
  if (!file.wrappedFileKey || file.encryptedSizeBytes === null || file.encryptedSizeBytes === undefined) throw new FileUnavailableError()
  const size = file.sizeBytes
  const encSize = file.encryptedSizeBytes
  const total = frameCount(size)
  if (encSize !== encryptedSize(size)) throw new FileUnavailableError()
  const fileKey = openFileKey(file.userId, file.wrappedFileKey)

  const replicas = file.replicas
    .filter((r) => r.status === 'healthy')
    .sort((a, b) => Number(b.connectedAccountId === file.connectedAccountId) - Number(a.connectedAccountId === file.connectedAccountId) || a.createdAt.getTime() - b.createdAt.getTime())
  if (replicas.length === 0) throw new FileUnavailableError()

  const want: ByteRange = range ?? { start: 0n, end: size - 1n }
  const span = size === 0n ? { firstFrame: 0, lastFrame: 0, cipherStart: 0n, cipherEnd: 0n, skipHead: 0 } : frameSpan(want)
  let remaining = size === 0n ? 0n : want.end - want.start + 1n
  let nextFrame = span.firstFrame
  let skip = span.skipHead
  let current = 0
  let activeSource: Readable | null = null
  let aborted = false
  const setActive = (s: Readable | null) => {
    activeSource = s
    if (aborted) s?.destroy()
  }

  async function readBatch(): Promise<Buffer[] | null> {
    if (nextFrame > span.lastFrame) return null
    const first = nextFrame
    const last = Math.min(first + BATCH_FRAMES - 1, span.lastFrame)
    const start = BigInt(first) * BigInt(FRAME_SIZE)
    const maxEnd = (BigInt(last) + 1n) * BigInt(FRAME_SIZE) - 1n
    const end = maxEnd < encSize - 1n ? maxEnd : encSize - 1n
    const expected = Number(end - start + 1n)
    for (let attempt = 0; attempt < replicas.length; attempt++) {
      if (aborted) throw new Error('Stream closed.')
      const idx = (current + attempt) % replicas.length
      const replica = replicas[idx]!
      try {
        const source = await providerFor(replica.connectedAccount).readRange(replica.connectedAccount, replica.providerFileId, start, end)
        const bytes = await collect(source, expected, setActive)
        const pieces: Buffer[] = []
        for (let i = first; i <= last; i++) {
          const off = (i - first) * FRAME_SIZE
          const frame = bytes.subarray(off, Math.min(off + FRAME_SIZE, bytes.length))
          pieces.push(decryptFrame(fileKey, file.id, i, BigInt(i) === total - 1n, frame))
        }
        current = idx
        nextFrame = last + 1
        const out: Buffer[] = []
        for (const piece of pieces) {
          let part = piece
          if (skip > 0) {
            part = part.subarray(Math.min(skip, part.length))
            skip = Math.max(0, skip - piece.length)
          }
          if (BigInt(part.length) > remaining) part = part.subarray(0, Number(remaining))
          remaining -= BigInt(part.length)
          if (part.length > 0) out.push(part)
        }
        return out
      } catch (err) {
        if (err instanceof ProviderUnavailableError && err.notFound) {
          await prisma.fileReplica.update({ where: { id: replica.id }, data: { status: 'lost' } }).catch(() => undefined)
          console.error(`Replica ${replica.id} of file ${file.id} is missing from its provider; marked lost.`)
        } else if (err instanceof FrameAuthError) {
          console.error(`Replica ${replica.id} of file ${file.id} failed frame authentication.`)
        } else {
          console.error(`Replica ${replica.id} of file ${file.id} read failed: ${err instanceof Error ? err.name : 'error'}`)
        }
      }
    }
    throw new FileUnavailableError()
  }

  let pending = await readBatch()
  let busy = false
  return new Readable({
    read() {
      if (busy) return
      busy = true
      void (async () => {
        try {
          let batch = pending ?? (await readBatch())
          pending = null
          while (batch !== null && batch.length === 0 && nextFrame <= span.lastFrame) batch = await readBatch()
          busy = false
          if (batch === null || batch.length === 0) this.push(null)
          else for (const part of batch) this.push(part)
        } catch (err) {
          busy = false
          this.destroy(err as Error)
        }
      })()
    },
    destroy(err, cb) {
      aborted = true
      activeSource?.destroy()
      cb(err)
    },
  })
}
