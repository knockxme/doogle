import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { syncQuotaForAccount } from '../storage/pool.js'
import { hasTestProvider, ProviderUnavailableError, providerFor } from '../storage/provider.js'

type Tx = Prisma.TransactionClient

/**
 * Deletes File rows inside the caller's transaction and queues every copy as an OrphanBlob in the same
 * transaction, so a crash never loses track of a blob. Call drainOrphanBlobs with the result after commit.
 */
export async function purgeFileRows(tx: Tx, userId: string, fileIds: string[]): Promise<string[]> {
  if (fileIds.length === 0) return []
  const replicas = await tx.fileReplica.findMany({ where: { fileId: { in: fileIds }, file: { userId } }, select: { connectedAccountId: true, providerFileId: true } })
  const orphans = replicas.map((r) => ({ id: randomUUID(), connectedAccountId: r.connectedAccountId, providerFileId: r.providerFileId }))
  if (orphans.length > 0) await tx.orphanBlob.createMany({ data: orphans })
  await tx.file.deleteMany({ where: { id: { in: fileIds }, userId } })
  return orphans.map((o) => o.id)
}

let draining: Promise<void> = Promise.resolve()

/** Resolves when every queued blob delete started so far has finished. For tests and shutdown. */
export function blobDeletesIdle(): Promise<void> {
  return draining
}

/**
 * Deletes the queued blobs. A blob that is gone counts as deleted; any other failure keeps its OrphanBlob row
 * for the hourly cleanup sweep. Never throws.
 */
export function drainOrphanBlobs(orphanIds: string[]): Promise<void> {
  const run = draining.then(() => drain(orphanIds))
  draining = run.catch(() => undefined)
  return draining
}

async function drain(orphanIds: string[]) {
  if (orphanIds.length === 0) return
  const orphans = await prisma.orphanBlob.findMany({ where: { id: { in: orphanIds } }, include: { connectedAccount: true } })
  const touched = new Map<string, (typeof orphans)[number]['connectedAccount']>()
  for (const orphan of orphans) {
    try {
      await providerFor(orphan.connectedAccount).deleteBlob(orphan.connectedAccount, orphan.providerFileId)
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError && error.notFound)) continue
    }
    await prisma.orphanBlob.deleteMany({ where: { id: orphan.id } }).catch(() => undefined)
    touched.set(orphan.connectedAccountId, orphan.connectedAccount)
  }
  if (!hasTestProvider()) for (const account of touched.values()) syncQuotaForAccount(account).catch(() => undefined)
}
