import { randomBytes } from 'node:crypto'
import type { ConnectedAccount, File, Prisma, UploadSessionReplica } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { createAuditLog } from '../../utils/audit.js'
import { decryptText, encryptText } from '../../utils/crypto.js'
import { openFileKey } from '../crypto/file-keys.js'
import { encryptedSize, encryptFrame, frameCount, FRAME_PLAINTEXT, FRAME_SIZE, UPLOAD_CHUNK_PLAINTEXT } from '../crypto/frames.js'
import { markAccountUnhealthy, reserveUpload, syncQuotaForAccount } from '../storage/pool.js'
import { hasTestProvider, ProviderQuotaError, ProviderUnavailableError, providerFor, type ReplicaUploadState } from '../storage/provider.js'

const PLAIN_CHUNK = BigInt(UPLOAD_CHUNK_PLAINTEXT)
const PLAIN_FRAME = BigInt(FRAME_PLAINTEXT)
const ENCRYPTED_CHUNK = 8n * BigInt(FRAME_SIZE)
const PAUSE_MS = 24 * 60 * 60 * 1000
const MAX_TRACKED_COPIES = 2000

/** A failure with a stable client-facing code. Anything else thrown here is unexpected. */
export class UploadError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message)
  }
}

const quotaExceeded = () => new UploadError(507, 'STORAGE_ACCOUNT_QUOTA_EXCEEDED', 'A storage account is out of upload quota.')
const accountUnavailable = () => new UploadError(502, 'STORAGE_ACCOUNT_UNAVAILABLE', 'A storage account is unavailable.')
const retryChunk = () => new UploadError(502, 'UPLOAD_CHUNK_RETRY', 'Storage did not accept this chunk. Resume from the status offset.')

export type UploadedFile = Omit<File, 'wrappedFileKey' | 'encryptedSizeBytes'>

type Copy = { replica: UploadSessionReplica; account: ConnectedAccount; state: ReplicaUploadState }

// Serialises work on one session, so a retry cannot overlap the attempt it is retrying.
const sessionLocks = new Map<string, Promise<unknown>>()

function withSessionLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(sessionId) ?? Promise.resolve()
  const run = previous.then(work)
  const tail = run.then(() => undefined, () => undefined)
  sessionLocks.set(sessionId, tail)
  void tail.then(() => {
    if (sessionLocks.get(sessionId) === tail) sessionLocks.delete(sessionId)
  })
  return run
}

// Committed encrypted bytes per copy, updated only after a confirmed write. A missing entry
// means "unknown" and sends the next chunk to the provider to ask; that is also how a restart behaves.
const knownCommitted = new Map<string, bigint>()

function remember(replicaId: string, committed: bigint) {
  knownCommitted.delete(replicaId)
  knownCommitted.set(replicaId, committed)
  if (knownCommitted.size > MAX_TRACKED_COPIES) knownCommitted.delete(knownCommitted.keys().next().value as string)
}

/** Forgets tracked offsets, which is what a process restart does. */
export function resetUploadTracking() {
  knownCommitted.clear()
}

function loadSession(sessionId: string) {
  return prisma.uploadSession.findUnique({
    where: { id: sessionId },
    omit: { wrappedFileKey: false },
    include: { replicas: { orderBy: { id: 'asc' } } },
  })
}

type LoadedSession = NonNullable<Awaited<ReturnType<typeof loadSession>>>

function replicaState(replica: UploadSessionReplica): ReplicaUploadState {
  return {
    sessionUri: replica.sessionUriEncrypted ? decryptText(replica.sessionUriEncrypted) : undefined,
    s3UploadId: replica.s3UploadId ?? undefined,
    providerFileId: replica.providerFileId ?? undefined,
    partEtags: Array.isArray(replica.partEtags) ? (replica.partEtags as string[]) : undefined,
  }
}

async function loadCopies(session: LoadedSession): Promise<Copy[]> {
  const accounts = await prisma.connectedAccount.findMany({ where: { id: { in: session.replicas.map((r) => r.connectedAccountId) } } })
  return session.replicas.flatMap((replica) => {
    const account = accounts.find((a) => a.id === replica.connectedAccountId)
    return account ? [{ replica, account, state: replicaState(replica) }] : []
  })
}

async function persistState(copy: Copy, next: ReplicaUploadState) {
  const prev = copy.state
  const data: Prisma.UploadSessionReplicaUpdateInput = {}
  if (next.sessionUri !== prev.sessionUri) data.sessionUriEncrypted = next.sessionUri ? encryptText(next.sessionUri) : null
  if (next.s3UploadId !== prev.s3UploadId) data.s3UploadId = next.s3UploadId ?? null
  if (next.providerFileId !== prev.providerFileId) data.providerFileId = next.providerFileId ?? null
  if (next.partEtags && JSON.stringify(next.partEtags) !== JSON.stringify(prev.partEtags)) data.partEtags = next.partEtags
  if (Object.keys(data).length > 0) await prisma.uploadSessionReplica.update({ where: { id: copy.replica.id }, data })
  copy.state = next
}

/** Asks the provider unless the offset is tracked. A probe can learn the provider file ID, so it is persisted. */
async function committedFor(copy: Copy, total: bigint, trustTracked: boolean) {
  const known = trustTracked ? knownCommitted.get(copy.replica.id) : undefined
  if (known !== undefined) return known
  const probe = { ...copy.state }
  const committed = await providerFor(copy.account).committedOffset(copy.account, probe, total)
  await persistState(copy, probe)
  remember(copy.replica.id, committed)
  return committed
}

async function discardCopy(copy: Copy, total: bigint) {
  const state = copy.state
  if (!state.sessionUri && !state.s3UploadId && !state.providerFileId) return
  const provider = providerFor(copy.account)
  const probe = { ...state }
  const committed = knownCommitted.get(copy.replica.id) ?? (await provider.committedOffset(copy.account, probe, total).catch(() => null))
  await provider.abortUpload(copy.account, state).catch(() => undefined)
  // A finished copy is a whole blob that aborting cannot remove. With an unknown offset, a delete of a blob that never finished is harmless.
  if (probe.providerFileId && (committed === null || committed >= total)) await provider.deleteBlob(copy.account, probe.providerFileId).catch(() => undefined)
}

async function failLocked(sessionId: string, reason: string) {
  const session = await loadSession(sessionId)
  if (!session || session.status !== 'uploading') return
  const marked = await prisma.uploadSession.updateMany({ where: { id: sessionId, status: 'uploading' }, data: { status: 'failed', errorMessage: reason } })
  if (marked.count === 0) return
  const copies = await loadCopies(session)
  await Promise.allSettled(copies.map((copy) => discardCopy(copy, encryptedSize(session.sizeBytes))))
  for (const replica of session.replicas) knownCommitted.delete(replica.id)
}

/** Marks an in-progress upload failed, aborts both copies best-effort, and releases its reservation. A finished upload is left alone. */
export function failUpload(sessionId: string, reason: string): Promise<void> {
  return withSessionLock(sessionId, () => failLocked(sessionId, reason))
}

/** An account whose provider refuses access (not a missing blob) leaves routing until it is reconnected. */
async function markRefused(failures: { reason: unknown; copy: Copy }[]) {
  const refused = failures.filter((f) => f.reason instanceof ProviderUnavailableError && !f.reason.notFound)
  await Promise.all(refused.map((f) => markAccountUnhealthy(f.copy.account.id, 'Storage provider refused access.').catch(() => undefined)))
}

/**
 * Applies the provider failure policy to settled per-copy results: quota pauses the account and fails
 * the upload, unavailability fails it, and anything else is left resumable when `resumable` is set.
 */
async function throwForFailures(sessionId: string, copies: Copy[], results: PromiseSettledResult<unknown>[], resumable: boolean) {
  const failures = results.flatMap((result, i) => (result.status === 'rejected' ? [{ reason: result.reason as unknown, copy: copies[i]! }] : []))
  if (failures.length === 0) return
  for (const { copy } of failures) knownCommitted.delete(copy.replica.id)

  await markRefused(failures)
  const quota = failures.filter((f) => f.reason instanceof ProviderQuotaError)
  if (quota.length > 0) {
    const pausedUntil = new Date(Date.now() + PAUSE_MS)
    await Promise.all(quota.map(({ copy }) => prisma.connectedAccount.updateMany({ where: { id: copy.account.id }, data: { pausedUntil } })))
    await failLocked(sessionId, 'Storage account quota exceeded.')
    throw quotaExceeded()
  }
  if (!resumable || failures.some((f) => f.reason instanceof ProviderUnavailableError)) {
    await failLocked(sessionId, 'Storage account unavailable.')
    throw accountUnavailable()
  }
  throw retryChunk()
}

function randomBlobName() {
  return `${randomBytes(16).toString('hex')}.bin`
}

/** Reserves space on two accounts and opens both provider uploads. */
export async function startEncryptedUpload(args: { userId: string; plainSize: bigint; fileName: string; mimeType: string; folderId: string | null }) {
  const { session, accounts } = await reserveUpload(args)
  const total = encryptedSize(args.plainSize)
  const replicas = await prisma.uploadSessionReplica.findMany({ where: { uploadSessionId: session.id } })
  const copies: Copy[] = accounts.map((account) => ({ account, replica: replicas.find((r) => r.connectedAccountId === account.id)!, state: {} }))

  const results = await Promise.allSettled(copies.map(async (copy) => {
    await persistState(copy, await providerFor(copy.account).beginUpload(copy.account, randomBlobName(), total))
    remember(copy.replica.id, 0n)
  }))
  await throwForFailures(session.id, copies, results, false)
  return session
}

function encryptChunk(fileKey: Buffer, fileId: string, plainSize: bigint, plainOffset: bigint, plaintext: Buffer) {
  const lastFrame = frameCount(plainSize) - 1n
  const frames: Buffer[] = []
  let index = plainOffset / PLAIN_FRAME
  for (let pos = 0; pos < plaintext.length; pos += FRAME_PLAINTEXT, index++) {
    frames.push(encryptFrame(fileKey, fileId, Number(index), index === lastFrame, plaintext.subarray(pos, pos + FRAME_PLAINTEXT)))
  }
  return Buffer.concat(frames)
}

/** Trims bytes this copy already holds and skips it when it holds the whole chunk. */
async function sendCopy(copy: Copy, ciphertext: Buffer, start: bigint, committed: bigint, total: bigint) {
  const end = start + BigInt(ciphertext.length)
  if (committed >= end) return
  const result = await providerFor(copy.account).putChunk(copy.account, copy.state, committed, ciphertext.subarray(Number(committed - start)), total)
  await persistState(copy, result.state)
  if (end === total && !result.complete) throw new Error('Provider did not finish the upload on its last chunk.')
  remember(copy.replica.id, end)
}

async function createFile(session: LoadedSession, copies: Copy[], total: bigint) {
  if (!session.wrappedFileKey) throw new UploadError(409, 'UPLOAD_NOT_ACTIVE', 'This upload is no longer active.')
  const [file] = await prisma.$transaction([
    prisma.file.create({
      data: {
        id: session.fileId!,
        userId: session.userId,
        folderId: session.folderId,
        name: session.fileName,
        mimeType: session.mimeType,
        sizeBytes: session.sizeBytes,
        wrappedFileKey: session.wrappedFileKey,
        encryptedSizeBytes: total,
        contentModifiedAt: new Date(),
        replicas: { create: copies.map((copy) => ({ connectedAccountId: copy.account.id, providerFileId: copy.state.providerFileId!, sizeBytes: total })) },
      },
    }),
    prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } }),
  ])
  return file
}

function refreshQuotasInBackground(copies: Copy[]) {
  if (hasTestProvider()) return
  for (const { account } of copies) {
    syncQuotaForAccount(account).catch((error) => console.info('[upload] quota sync failed', { accountId: account.id, message: error instanceof Error ? error.message : 'Unknown error' }))
  }
}

function assertWritable(session: LoadedSession) {
  if (session.status !== 'uploading' || !session.fileId || !session.wrappedFileKey || session.replicas.length !== 2) {
    throw new UploadError(409, 'UPLOAD_NOT_ACTIVE', 'This upload is no longer active.')
  }
}

function assertAligned(session: LoadedSession, plainOffset: bigint, length: number) {
  const expected = session.sizeBytes - plainOffset < PLAIN_CHUNK ? session.sizeBytes - plainOffset : PLAIN_CHUNK
  if (plainOffset < 0n || plainOffset >= session.sizeBytes || plainOffset % PLAIN_CHUNK !== 0n || BigInt(length) !== expected) {
    throw new UploadError(400, 'CHUNK_NOT_ALIGNED', 'Chunk is not aligned to the upload chunk size.')
  }
}

async function writeLocked(sessionId: string, plainOffset: bigint, plaintext: Buffer): Promise<{ complete: boolean; file?: UploadedFile }> {
  const session = await loadSession(sessionId)
  if (!session) throw new UploadError(404, 'UPLOAD_SESSION_NOT_FOUND', 'Upload session not found.')
  if (session.status === 'completed' && session.fileId) {
    // The response to the last chunk can be lost; the client's retry must still get the file.
    const file = await prisma.file.findUnique({ where: { id: session.fileId } })
    if (!file) throw new UploadError(409, 'UPLOAD_NOT_ACTIVE', 'This upload is no longer active.')
    return { complete: true, file }
  }
  assertWritable(session)
  assertAligned(session, plainOffset, plaintext.length)
  // The stale-upload sweep measures inactivity from here.
  await prisma.uploadSession.updateMany({ where: { id: sessionId, status: 'uploading' }, data: { lastActivityAt: new Date() } })

  const copies = await loadCopies(session)
  if (copies.length !== 2) {
    await failLocked(sessionId, 'Storage account removed during upload.')
    throw accountUnavailable()
  }

  const total = encryptedSize(session.sizeBytes)
  const start = (plainOffset / PLAIN_CHUNK) * ENCRYPTED_CHUNK
  const fileKey = openFileKey(session.userId, session.wrappedFileKey!)
  const ciphertext = encryptChunk(fileKey, session.fileId!, session.sizeBytes, plainOffset, plaintext)
  const end = start + BigInt(ciphertext.length)

  const probes = await Promise.allSettled(copies.map((copy) => committedFor(copy, total, true)))
  await throwForFailures(sessionId, copies, probes, true)
  const committed = probes.map((probe) => (probe as PromiseFulfilledResult<bigint>).value)
  if (committed.some((offset) => offset < start)) {
    throw new UploadError(409, 'CHUNK_OUT_OF_ORDER', 'Chunk is ahead of what storage holds. Resume from the status offset.')
  }

  const sends = await Promise.allSettled(copies.map((copy, i) => sendCopy(copy, ciphertext, start, committed[i]!, total)))
  await throwForFailures(sessionId, copies, sends, true)
  if (end !== total) return { complete: false }

  if (copies.some((copy) => !copy.state.providerFileId)) {
    await failLocked(sessionId, 'Storage did not report a file ID for a finished copy.')
    throw accountUnavailable()
  }
  const file = await createFile(session, copies, total)
  for (const { replica } of copies) knownCommitted.delete(replica.id)
  await createAuditLog(session.userId, 'UPLOAD_FILE', 'file', file.id, { name: file.name, size: file.sizeBytes.toString() })
  refreshQuotasInBackground(copies)
  return { complete: true, file }
}

/** Encrypts one upload chunk and writes it to both copies. Creates the File once both copies hold the whole blob. */
export function writeEncryptedChunk(sessionId: string, plainOffset: bigint, plaintext: Buffer) {
  return withSessionLock(sessionId, () => writeLocked(sessionId, plainOffset, plaintext))
}

/** Plaintext offset to resume from: the lower of both copies, rounded down to a whole chunk. */
export function resumeOffset(sessionId: string): Promise<bigint> {
  return withSessionLock(sessionId, async () => {
    const session = await loadSession(sessionId)
    if (!session) throw new UploadError(404, 'UPLOAD_SESSION_NOT_FOUND', 'Upload session not found.')
    if (session.status === 'completed') return session.sizeBytes
    if (session.status !== 'uploading' || session.replicas.length !== 2) return 0n
    const copies = await loadCopies(session)
    if (copies.length !== 2) throw accountUnavailable()

    const total = encryptedSize(session.sizeBytes)
    const probes = await Promise.allSettled(copies.map((copy) => committedFor(copy, total, false)))
    const rejected = probes.flatMap((probe, i) => (probe.status === 'rejected' ? [{ reason: probe.reason as unknown, copy: copies[i]! }] : []))
    if (rejected.length > 0) {
      await markRefused(rejected)
      for (const { copy } of rejected) knownCommitted.delete(copy.replica.id)
      throw rejected.some((r) => r.reason instanceof ProviderQuotaError || r.reason instanceof ProviderUnavailableError) ? accountUnavailable() : retryChunk()
    }
    const lowest = probes.map((probe) => (probe as PromiseFulfilledResult<bigint>).value).reduce((a, b) => (a < b ? a : b))
    const offset = (lowest / ENCRYPTED_CHUNK) * PLAIN_CHUNK
    // Both copies can be whole while the File is not yet created; the last chunk must be re-sent to finish it.
    return offset >= session.sizeBytes ? ((session.sizeBytes - 1n) / PLAIN_CHUNK) * PLAIN_CHUNK : offset
  })
}
