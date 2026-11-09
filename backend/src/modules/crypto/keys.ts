import crypto from 'node:crypto'

export function parseMasterKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64')
  if (key.length !== 32) throw new Error('Master key must be 32 bytes (base64)')
  return key
}

export function deriveUserKey(master: Buffer, userId: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from(userId, 'utf8'), 'family-drive/user/v1', 32))
}

export function newFileKey(userKey: Buffer): { fileKey: Buffer; wrapped: string } {
  const fileKey = crypto.randomBytes(32)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', userKey, iv)
  const encrypted = Buffer.concat([cipher.update(fileKey), cipher.final()])
  const tag = cipher.getAuthTag()
  return { fileKey, wrapped: `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}` }
}

export function unwrapFileKey(userKey: Buffer, wrapped: string): Buffer {
  const [ivRaw, tagRaw, encryptedRaw] = wrapped.split(':')
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error('Invalid wrapped key')
  const decipher = crypto.createDecipheriv('aes-256-gcm', userKey, Buffer.from(ivRaw, 'base64'))
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64')), decipher.final()])
}

export function masterFingerprint(master: Buffer): string {
  return crypto.createHmac('sha256', master).update('family-drive/fingerprint/v1').digest('hex')
}
