import crypto from 'node:crypto'

export const FRAME_SIZE = 1048576
export const NONCE_SIZE = 12
export const TAG_SIZE = 16
export const FRAME_OVERHEAD = NONCE_SIZE + TAG_SIZE
export const FRAME_PLAINTEXT = FRAME_SIZE - FRAME_OVERHEAD
export const UPLOAD_CHUNK_PLAINTEXT = 8 * FRAME_PLAINTEXT

export class FrameAuthError extends Error {
  constructor(message = 'Frame authentication failed') {
    super(message)
    this.name = 'FrameAuthError'
  }
}

const P = BigInt(FRAME_PLAINTEXT)

/** Number of frames for a plaintext size. An empty file still has one (empty, final) frame. */
export function frameCount(plainSize: bigint): bigint {
  if (plainSize <= 0n) return 1n
  return (plainSize + P - 1n) / P
}

export function encryptedSize(plainSize: bigint): bigint {
  return (plainSize < 0n ? 0n : plainSize) + frameCount(plainSize) * BigInt(FRAME_OVERHEAD)
}

function hkdf(fileKey: Buffer, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', fileKey, Buffer.alloc(0), info, 32))
}

function indexBytes(index: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(index, 0)
  return b
}

function aad(fileId: string, index: number, isFinal: boolean): Buffer {
  return Buffer.concat([Buffer.from(fileId, 'utf8'), indexBytes(index), Buffer.from([isFinal ? 1 : 0])])
}

export function encryptFrame(fileKey: Buffer, fileId: string, index: number, isFinal: boolean, plaintext: Buffer): Buffer {
  if (plaintext.length > FRAME_PLAINTEXT) throw new Error('Frame plaintext too large')
  const nonce = crypto
    .createHmac('sha256', hkdf(fileKey, 'nonce'))
    .update(indexBytes(index))
    .update(plaintext)
    .digest()
    .subarray(0, NONCE_SIZE)
  const cipher = crypto.createCipheriv('aes-256-gcm', hkdf(fileKey, 'data'), nonce)
  cipher.setAAD(aad(fileId, index, isFinal))
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, ct, cipher.getAuthTag()])
}

export function decryptFrame(fileKey: Buffer, fileId: string, index: number, isFinal: boolean, frame: Buffer): Buffer {
  if (frame.length < FRAME_OVERHEAD || frame.length > FRAME_SIZE) throw new FrameAuthError('Invalid frame length')
  const nonce = frame.subarray(0, NONCE_SIZE)
  const tag = frame.subarray(frame.length - TAG_SIZE)
  const ct = frame.subarray(NONCE_SIZE, frame.length - TAG_SIZE)
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', hkdf(fileKey, 'data'), nonce)
    decipher.setAAD(aad(fileId, index, isFinal))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()])
  } catch {
    throw new FrameAuthError()
  }
}
