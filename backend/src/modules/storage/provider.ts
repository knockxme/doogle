import type { ConnectedAccount } from '@prisma/client'
import type { Readable } from 'node:stream'
import { googleProvider } from './google-provider.js'
import { s3Provider } from './s3-provider.js'

export type ReplicaUploadState = { sessionUri?: string; s3UploadId?: string; providerFileId?: string; partEtags?: string[] }

export interface StorageProvider {
  beginUpload(account: ConnectedAccount, blobName: string, encryptedSize: bigint): Promise<ReplicaUploadState>
  putChunk(account: ConnectedAccount, state: ReplicaUploadState, offset: bigint, chunk: Buffer, totalSize: bigint): Promise<{ state: ReplicaUploadState; complete: boolean }>
  committedOffset(account: ConnectedAccount, state: ReplicaUploadState, totalSize: bigint): Promise<bigint>
  abortUpload(account: ConnectedAccount, state: ReplicaUploadState): Promise<void>
  readRange(account: ConnectedAccount, providerFileId: string, start: bigint, end: bigint): Promise<Readable>
  deleteBlob(account: ConnectedAccount, providerFileId: string): Promise<void>
}

export class ProviderQuotaError extends Error {}

/** notFound is true only when the blob itself is gone (404). Auth failures use notFound = false. */
export class ProviderUnavailableError extends Error {
  constructor(message: string, readonly notFound = false) {
    super(message)
  }
}

let testProvider: StorageProvider | null = null

export function setTestProvider(p: StorageProvider | null) {
  testProvider = p
}

export function providerFor(account: Pick<ConnectedAccount, 'provider'>): StorageProvider {
  if (testProvider) return testProvider
  if (account.provider === 'google_drive') return googleProvider
  if (account.provider === 's3') return s3Provider
  throw new Error(`Unsupported storage provider: ${account.provider}`)
}
