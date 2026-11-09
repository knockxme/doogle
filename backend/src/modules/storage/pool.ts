import { randomUUID } from 'node:crypto'
import type { ConnectedAccount, Prisma, UploadSession } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { createFileKey } from '../crypto/file-keys.js'
import { encryptedSize } from '../crypto/frames.js'
import { syncGoogleQuota } from '../google/google.service.js'
import { syncS3Quota } from '../s3/s3.service.js'
import { PoolError } from './pool-errors.js'
import { pickPair, usablePoolBytes, type Candidate } from './pool-select.js'

type Db = Prisma.TransactionClient | typeof prisma

export const SESSION_STALE_MS = 7 * 24 * 60 * 60 * 1000
const QUOTA_STALE_MS = 5 * 60 * 1000

function sessionCutoff() {
  return new Date(Date.now() - SESSION_STALE_MS)
}

/** A new account copies the install default cap; a reconnect keeps what it already has. */
export function initialCapForConnect(existing: { capBytes: bigint | null } | null, defaultCapBytes: bigint | null): bigint | null {
  return existing ? existing.capBytes : defaultCapBytes
}

export async function getDefaultCapBytes(db: Db = prisma): Promise<bigint | null> {
  const setting = await db.appSetting.findUnique({ where: { id: 1 } })
  return setting?.defaultAccountCapBytes ?? null
}

export async function syncQuotaForAccount(account: { id: string; provider: string }) {
  if (account.provider === 's3') return syncS3Quota(account.id)
  return syncGoogleQuota(account.id)
}

async function resyncStale() {
  const accounts = await prisma.connectedAccount.findMany({ where: { status: 'connected' }, include: { storageAccount: true } })
  const cutoff = Date.now() - QUOTA_STALE_MS
  const stale = accounts.filter((a) => !a.storageAccount?.lastSyncedAt || a.storageAccount.lastSyncedAt.getTime() < cutoff)
  await Promise.all(stale.map((a) => syncQuotaForAccount(a).catch(() => undefined)))
}

/** Bytes reserved by live upload sessions, per account. */
export async function reservedByAccount(db: Db = prisma): Promise<Map<string, bigint>> {
  const rows = await db.uploadSessionReplica.groupBy({
    by: ['connectedAccountId'],
    where: { uploadSession: { status: 'uploading', createdAt: { gt: sessionCutoff() } } },
    _sum: { reservedBytes: true },
  })
  return new Map(rows.map((r) => [r.connectedAccountId, r._sum.reservedBytes ?? 0n]))
}

/** Bytes of healthy replicas the app has stored, per account. */
export async function storedByAccount(db: Db = prisma): Promise<Map<string, bigint>> {
  const rows = await db.fileReplica.groupBy({ by: ['connectedAccountId'], where: { status: 'healthy' }, _sum: { sizeBytes: true } })
  return new Map(rows.map((r) => [r.connectedAccountId, r._sum.sizeBytes ?? 0n]))
}

/** All connected accounts as routing candidates. Without a transaction, stale quotas are resynced first. */
export async function loadCandidates(tx?: Prisma.TransactionClient): Promise<Candidate[]> {
  if (!tx) await resyncStale()
  const db: Db = tx ?? prisma
  const [accounts, reserved, stored] = await Promise.all([
    db.connectedAccount.findMany({ where: { status: 'connected' }, include: { storageAccount: true }, orderBy: { createdAt: 'asc' } }),
    reservedByAccount(db),
    storedByAccount(db),
  ])
  return accounts.map((a) => ({
    id: a.id,
    provider: a.provider,
    createdAt: a.createdAt,
    capBytes: a.capBytes,
    appStoredBytes: stored.get(a.id) ?? 0n,
    providerFreeBytes: a.storageAccount?.availableBytes ?? null,
    reservedBytes: reserved.get(a.id) ?? 0n,
    pausedUntil: a.pausedUntil,
  }))
}

export async function userStorage(userId: string, db: Db = prisma): Promise<{ usedBytes: bigint; limitBytes: bigint | null; availableBytes: bigint | null }> {
  const [user, files, sessions] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { storageLimitBytes: true } }),
    db.file.aggregate({ where: { userId, status: { not: 'purged' } }, _sum: { sizeBytes: true } }),
    db.uploadSession.aggregate({ where: { userId, status: 'uploading', createdAt: { gt: sessionCutoff() } }, _sum: { sizeBytes: true } }),
  ])
  const usedBytes = (files._sum.sizeBytes ?? 0n) + (sessions._sum.sizeBytes ?? 0n)
  const limitBytes = user.storageLimitBytes
  const availableBytes = limitBytes === null ? null : (limitBytes > usedBytes ? limitBytes - usedBytes : 0n)
  return { usedBytes, limitBytes, availableBytes }
}

/** What a user may still upload: the lower of their limit remaining and the pool's usable space. null only when both are unlimited. */
export async function userAvailable(userId: string): Promise<{ usedBytes: bigint; limitBytes: bigint | null; availableBytes: bigint | null }> {
  const usage = await userStorage(userId)
  const pool = usablePoolBytes(await loadCandidates(), new Date())
  const availableBytes = usage.availableBytes === null ? pool : pool === null ? usage.availableBytes : (usage.availableBytes < pool ? usage.availableBytes : pool)
  return { ...usage, availableBytes }
}

function normalizeIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export async function reserveUpload(args: { userId: string; plainSize: bigint; fileName: string; mimeType: string; folderId: string | null }): Promise<{ session: UploadSession; fileKey: Buffer; accounts: [ConnectedAccount, ConnectedAccount] }> {
  await prisma.appSetting.upsert({ where: { id: 1 }, create: { id: 1, priorityAccountIds: [] }, update: {} })
  await resyncStale()
  const need = encryptedSize(args.plainSize)
  const fileId = randomUUID()
  const { fileKey, wrapped } = createFileKey(args.userId)

  return prisma.$transaction(async (tx) => {
    // Serialises every reservation: candidates are read only after this lock is held.
    await tx.$queryRaw`SELECT id FROM app_settings WHERE id = 1 FOR UPDATE`
    const setting = await tx.appSetting.findUniqueOrThrow({ where: { id: 1 } })

    const usage = await userStorage(args.userId, tx)
    if (usage.availableBytes !== null && args.plainSize > usage.availableBytes) {
      throw new PoolError('USER_STORAGE_LIMIT_REACHED', 'Your storage limit has been reached.', 413)
    }

    const mode = (['most_available', 'round_robin', 'priority'] as const).find((m) => m === setting.routingMode) ?? 'most_available'
    const candidates = await loadCandidates(tx)
    const pair = pickPair(candidates, need, { mode, priorityAccountIds: normalizeIds(setting.priorityAccountIds), cursor: setting.roundRobinCursor }, new Date())
    if (!pair) throw new PoolError('NO_ACCOUNT_WITH_ENOUGH_SPACE', 'No two storage accounts have enough free space.', 507)

    const session = await tx.uploadSession.create({
      omit: { wrappedFileKey: false },
      data: {
        userId: args.userId,
        folderId: args.folderId,
        fileName: args.fileName,
        mimeType: args.mimeType,
        sizeBytes: args.plainSize,
        status: 'uploading',
        fileId,
        wrappedFileKey: wrapped,
        replicas: { create: pair.map((connectedAccountId) => ({ connectedAccountId, reservedBytes: need })) },
      },
    })
    if (mode === 'round_robin') await tx.appSetting.update({ where: { id: 1 }, data: { roundRobinCursor: setting.roundRobinCursor + 1 } })

    const rows = await tx.connectedAccount.findMany({ where: { id: { in: pair } } })
    const byId = new Map(rows.map((r) => [r.id, r]))
    return { session, fileKey, accounts: [byId.get(pair[0])!, byId.get(pair[1])!] as [ConnectedAccount, ConnectedAccount] }
  }, { timeout: 15_000, maxWait: 15_000 })
}
