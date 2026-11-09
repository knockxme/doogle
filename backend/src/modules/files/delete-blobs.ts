import type { ConnectedAccount, FileReplica } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { syncQuotaForAccount } from '../storage/pool.js'
import { ProviderUnavailableError, hasTestProvider, providerFor } from '../storage/provider.js'

/** What deleteFileCopies needs: every copy of the file (any status), each with its account. */
export type DeletableFile = { id: string; replicas: (Pick<FileReplica, 'connectedAccountId' | 'providerFileId'> & { connectedAccount: ConnectedAccount })[] }

/** Prisma args that load every copy of a file, including copies marked lost. */
export const deletableFileArgs = { include: { replicas: { include: { connectedAccount: true } } } } as const

/** An account may be removed only when no file depends on it as its last healthy copy. */
export function canRemoveAccount(soleCopyCount: number): boolean {
  return soleCopyCount === 0
}

/**
 * Deletes the encrypted blobs of a file. A blob that cannot be deleted is recorded as an OrphanBlob
 * for later cleanup. This never throws for provider or bookkeeping failures, and never touches File rows:
 * callers delete the File row afterwards.
 */
export async function deleteFileCopies(file: DeletableFile): Promise<void> {
  for (const replica of file.replicas) {
    try {
      await providerFor(replica.connectedAccount).deleteBlob(replica.connectedAccount, replica.providerFileId)
    } catch (error) {
      if (error instanceof ProviderUnavailableError && error.notFound) continue
      console.error(`Could not delete a copy of file ${file.id}:`, error instanceof Error ? error.name : 'error')
      await prisma.orphanBlob
        .create({ data: { connectedAccountId: replica.connectedAccountId, providerFileId: replica.providerFileId } })
        .catch((e) => console.error(`Could not record orphan blob for file ${file.id}:`, e instanceof Error ? e.name : 'error'))
    }
  }
}

/** Best-effort quota refresh for the accounts that held the given copies. Never throws. */
export function refreshQuotasAfterDelete(files: DeletableFile[]): void {
  if (hasTestProvider()) return
  const accounts = new Map<string, ConnectedAccount>()
  for (const file of files) for (const r of file.replicas) accounts.set(r.connectedAccount.id, r.connectedAccount)
  for (const account of accounts.values()) syncQuotaForAccount(account).catch(() => undefined)
}
