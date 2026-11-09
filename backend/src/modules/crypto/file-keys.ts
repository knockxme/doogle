import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { deriveUserKey, masterFingerprint, newFileKey, parseMasterKey, unwrapFileKey } from './keys.js'

const master = parseMasterKey(env.FILE_MASTER_KEY)

export function createFileKey(userId: string): { fileKey: Buffer; wrapped: string } {
  return newFileKey(deriveUserKey(master, userId))
}

export function openFileKey(userId: string, wrapped: string): Buffer {
  return unwrapFileKey(deriveUserKey(master, userId), wrapped)
}

export async function assertMasterKeyMatches(): Promise<void> {
  const fingerprint = masterFingerprint(master)
  const setting = await prisma.appSetting.upsert({
    where: { id: 1 },
    create: { id: 1, priorityAccountIds: [], masterKeyFingerprint: fingerprint },
    update: {},
  })
  if (!setting.masterKeyFingerprint) {
    // Only fills when still null, so a concurrent boot cannot overwrite a stored fingerprint.
    await prisma.appSetting.updateMany({ where: { id: 1, masterKeyFingerprint: null }, data: { masterKeyFingerprint: fingerprint } })
    const again = await prisma.appSetting.findUniqueOrThrow({ where: { id: 1 } })
    if (again.masterKeyFingerprint !== fingerprint) throw new Error('FILE_MASTER_KEY does not match the key this database was initialised with')
    return
  }
  if (setting.masterKeyFingerprint !== fingerprint) {
    throw new Error('FILE_MASTER_KEY does not match the key this database was initialised with')
  }
}
