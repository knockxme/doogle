import { randomBytes } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { ConnectedAccount, Prisma, RepairJob } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { decryptText, encryptText } from '../../utils/crypto.js'
import { FRAME_SIZE } from '../crypto/frames.js'
import { markAccountUnhealthy, reserveRepairTarget } from '../storage/pool.js'
import { ProviderQuotaError, ProviderUnavailableError, providerFor, type ReplicaUploadState } from '../storage/provider.js'

const BATCH_BYTES = 8n * BigInt(FRAME_SIZE)
const PAGE = 100
const PAUSE_MS = 24 * 60 * 60 * 1000
const LIVE_STATUSES = ['active', 'deleted']
const DAY_MS = 24 * 60 * 60 * 1000
/** The hourly check looks at each copy about once a week. */
export const VERIFY_EVERY_MS = 7 * DAY_MS
const VERIFY_BATCH = 500

export class RepairError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message)
  }
}

let current: Promise<void> = Promise.resolve()

/** Resolves when no repair is running in this process. */
export function repairIdle(): Promise<void> {
  return current
}

type Held = { id: string; status: string; connectedAccount: { status: string } }
export const isUsableCopy = (r: Held) => r.status === 'healthy' && r.connectedAccount.status === 'connected'

const loadPage = (cursor: string | undefined) => prisma.file.findMany({
  // Empty files are stored without copies, so they never need one.
  where: { status: { in: LIVE_STATUSES }, sizeBytes: { gt: 0 }, ...(cursor ? { id: { gt: cursor } } : {}) },
  omit: { encryptedSizeBytes: false },
  include: { replicas: { include: { connectedAccount: { select: { status: true } } } } },
  orderBy: { id: 'asc' },
  take: PAGE,
})
type RepairFile = Awaited<ReturnType<typeof loadPage>>[number]

/** Files (active or in trash) with fewer than two usable copies, in id order, a page at a time. */
export async function* filesMissingCopy(): AsyncGenerator<RepairFile> {
  let cursor: string | undefined
  for (;;) {
    const files = await loadPage(cursor)
    if (files.length === 0) return
    cursor = files[files.length - 1]!.id
    for (const file of files) if (file.replicas.filter(isUsableCopy).length < 2) yield file
  }
}

export async function countFilesMissingCopy(): Promise<number> {
  let n = 0
  for await (const _ of filesMissingCopy()) n++
  return n
}

async function collect(stream: Readable, expected: number): Promise<Buffer> {
  const parts: Buffer[] = []
  let length = 0
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += buf.length
      if (length > expected) throw new Error('Provider returned more bytes than requested.')
      parts.push(buf)
    }
  } finally {
    stream.destroy()
  }
  if (length !== expected) throw new Error('Provider returned fewer bytes than requested.')
  return Buffer.concat(parts, length)
}

async function persistState(replicaRowId: string, state: ReplicaUploadState) {
  await prisma.uploadSessionReplica.update({
    where: { id: replicaRowId },
    data: {
      sessionUriEncrypted: state.sessionUri ? encryptText(state.sessionUri) : null,
      s3UploadId: state.s3UploadId ?? null,
      providerFileId: state.providerFileId ?? null,
      partEtags: state.partEtags ?? undefined,
    },
  })
}


/** A failure on the survivor being read, kept apart from failures on the account being written. */
class SourceError extends Error {
  constructor(readonly cause: unknown) {
    super('Source copy could not be read.')
  }
}

const reloadFile = (id: string) => prisma.file.findUnique({
  where: { id },
  omit: { encryptedSizeBytes: false },
  include: { replicas: { include: { connectedAccount: { select: { status: true } } } } },
})

async function repairOne(snapshot: RepairFile): Promise<'repaired' | 'failed' | 'gone'> {
  // The page was read earlier; account and copy status may have changed since.
  const file = await reloadFile(snapshot.id)
  if (!file) return 'gone'
  const usable = file.replicas.filter(isUsableCopy)
  if (usable.length >= 2) return 'gone'
  const survivor = usable[0]
  if (!survivor) return 'failed'
  const total = file.encryptedSizeBytes
  const reserved = await reserveRepairTarget({ userId: file.userId, fileName: 'repair', encryptedBytes: total, excludeAccountIds: file.replicas.map((r) => r.connectedAccountId) })
  if (!reserved) return 'failed'
  const { session, account: target } = reserved
  const row = await prisma.uploadSessionReplica.findFirstOrThrow({ where: { uploadSessionId: session.id } })
  const targetProvider = providerFor(target)
  let state: ReplicaUploadState = {}
  try {
    state = await targetProvider.beginUpload(target, `${randomBytes(16).toString('hex')}.bin`, total)
    await persistState(row.id, state)
    const source = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: survivor.connectedAccountId } })
    let offset = 0n
    do {
      const end = offset + BATCH_BYTES < total ? offset + BATCH_BYTES : total
      let bytes: Buffer
      try {
        bytes = await collect(await providerFor(source).readRange(source, survivor.providerFileId, offset, end - 1n), Number(end - offset))
      } catch (err) {
        throw new SourceError(err)
      }
      const result = await targetProvider.putChunk(target, state, offset, bytes, total)
      state = result.state
      await persistState(row.id, state)
      offset = end
      if (offset === total && !result.complete) throw new Error('Provider did not finish the copy on its last chunk.')
    } while (offset < total)
    if (!state.providerFileId) throw new Error('Provider reported no file ID for the new copy.')
  } catch (err) {
    await abandon(session.id, target, state, 'Copy failed.')
    if (err instanceof SourceError) await noteSourceFailure(survivor.id, survivor.connectedAccountId, err.cause)
    else {
      if (err instanceof ProviderQuotaError) await prisma.connectedAccount.updateMany({ where: { id: target.id }, data: { pausedUntil: new Date(Date.now() + PAUSE_MS) } })
      if (err instanceof ProviderUnavailableError && !err.notFound) await markAccountUnhealthy(target.id, 'Storage provider refused access.').catch(() => undefined)
    }
    return 'failed'
  }

  const providerFileId = state.providerFileId!
  const outcome = await prisma.$transaction(async (tx) => {
    // Decide from the rows as they are now, not from the snapshot taken before the copy.
    const current = await tx.file.findUnique({ where: { id: file.id }, select: { id: true, replicas: { include: { connectedAccount: { select: { status: true } } } } } })
    if (!current) return 'gone' as const
    const nowUsable = current.replicas.filter(isUsableCopy)
    if (nowUsable.length >= 2) return 'gone' as const
    if (nowUsable.length === 0) return 'failed' as const
    for (const r of current.replicas.filter((x) => !isUsableCopy(x))) {
      await tx.fileReplica.delete({ where: { id: r.id } })
      await tx.orphanBlob.create({ data: { connectedAccountId: r.connectedAccountId, providerFileId: r.providerFileId } })
    }
    await tx.fileReplica.create({ data: { fileId: file.id, connectedAccountId: target.id, providerFileId, status: 'healthy', sizeBytes: total, lastVerifiedAt: new Date() } })
    await tx.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } })
    return 'ok' as const
  }).catch(() => 'error' as const)

  if (outcome === 'ok') return 'repaired'
  await targetProvider.deleteBlob(target, providerFileId).catch(async () => {
    await prisma.orphanBlob.create({ data: { connectedAccountId: target.id, providerFileId } }).catch(() => undefined)
  })
  const reason = outcome === 'gone' ? 'File deleted or already repaired.' : 'Could not record the new copy.'
  await prisma.uploadSession.updateMany({ where: { id: session.id, status: 'repairing' }, data: { status: 'failed', errorMessage: reason } })
  return outcome === 'gone' ? 'gone' : 'failed'
}

async function noteSourceFailure(replicaId: string, accountId: string, err: unknown) {
  if (!(err instanceof ProviderUnavailableError)) return // quota and other errors blame nobody
  if (err.notFound) await prisma.fileReplica.updateMany({ where: { id: replicaId }, data: { status: 'lost' } })
  else await markAccountUnhealthy(accountId, 'Storage provider refused access.').catch(() => undefined)
}

async function abandon(sessionId: string, account: ConnectedAccount, state: ReplicaUploadState, reason: string) {
  await prisma.uploadSession.updateMany({ where: { id: sessionId, status: 'repairing' }, data: { status: 'failed', errorMessage: reason } })
  if (state.sessionUri || state.s3UploadId || state.providerFileId) await providerFor(account).abortUpload(account, state).catch(() => undefined)
}

export type VerifyResult = { checked: number; lost: number; refusedAccounts: number }

/**
 * Checks that copies marked healthy still exist, by reading their last byte. A copy that is gone is marked lost
 * (so Health counts it and Repair rebuilds it); an account that refuses access is marked unhealthy and skipped.
 * Without this, a deleted copy is only noticed when someone happens to read that file.
 */
export async function verifyCopies(opts: { olderThanMs: number; limit?: number; now?: Date }): Promise<VerifyResult> {
  const now = opts.now ?? new Date()
  const cutoff = new Date(now.getTime() - opts.olderThanMs)
  const refused = new Set<string>()
  const result: VerifyResult = { checked: 0, lost: 0, refusedAccounts: 0 }
  let cursor: string | undefined
  for (;;) {
    const take = opts.limit === undefined ? PAGE : Math.min(PAGE, opts.limit - result.checked)
    if (take <= 0) break
    const replicas = await prisma.fileReplica.findMany({
      where: { status: 'healthy', connectedAccount: { status: 'connected' }, OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: cutoff } }], ...(cursor ? { id: { gt: cursor } } : {}) },
      include: { connectedAccount: true },
      orderBy: { id: 'asc' },
      take,
    })
    if (replicas.length === 0) break
    cursor = replicas[replicas.length - 1]!.id
    for (const replica of replicas) {
      if (refused.has(replica.connectedAccountId)) continue
      result.checked++
      const last = replica.sizeBytes - 1n
      try {
        const stream = await providerFor(replica.connectedAccount).readRange(replica.connectedAccount, replica.providerFileId, last, last)
        await collect(stream, 1)
        await prisma.fileReplica.updateMany({ where: { id: replica.id, status: 'healthy' }, data: { lastVerifiedAt: now } })
      } catch (err) {
        if (err instanceof ProviderUnavailableError && err.notFound) {
          await prisma.fileReplica.updateMany({ where: { id: replica.id, status: 'healthy' }, data: { status: 'lost' } })
          result.lost++
        } else if (err instanceof ProviderUnavailableError) {
          refused.add(replica.connectedAccountId)
          await markAccountUnhealthy(replica.connectedAccountId, 'Storage provider refused access.').catch(() => undefined)
        }
        // Anything else (network, quota) says nothing about the copy; it is checked again next time.
      }
    }
  }
  result.refusedAccounts = refused.size
  return result
}

/** Hourly: checks the copies that have gone longest without a check, a batch at a time. */
export function sweepCopyChecks(): Promise<VerifyResult> {
  return verifyCopies({ olderThanMs: VERIFY_EVERY_MS, limit: VERIFY_BATCH })
}

/** Retries deletion of every queued blob on a reachable account. Runs after Repair and from the hourly cleanup. */
export async function sweepOrphans() {
  const orphans = await prisma.orphanBlob.findMany({ where: { connectedAccount: { status: 'connected' } }, include: { connectedAccount: true } })
  for (const orphan of orphans) {
    try {
      await providerFor(orphan.connectedAccount).deleteBlob(orphan.connectedAccount, orphan.providerFileId)
    } catch (err) {
      if (!(err instanceof ProviderUnavailableError && err.notFound)) continue
    }
    await prisma.orphanBlob.deleteMany({ where: { id: orphan.id } })
  }
}

async function runJob(jobId: string) {
  try {
    // First check every copy, so ones that vanished without anyone reading them get rebuilt too.
    await verifyCopies({ olderThanMs: 0 }).catch((err) => console.error('[repair] copy check failed', { error: err instanceof Error ? err.name : 'error' }))
    for await (const file of filesMissingCopy()) {
      let result: Awaited<ReturnType<typeof repairOne>>
      try {
        result = await repairOne(file)
      } catch (err) {
        console.error('[repair] file failed', { fileId: file.id, error: err instanceof Error ? err.name : 'error' })
        result = 'failed'
      }
      await prisma.repairJob.update({ where: { id: jobId }, data: { processed: { increment: 1 }, ...(result === 'failed' ? { failed: { increment: 1 } } : {}) } })
    }
    await sweepOrphans().catch(() => undefined)
    await prisma.repairJob.update({ where: { id: jobId }, data: { status: 'completed', finishedAt: new Date() } })
  } catch (err) {
    console.error('[repair] job failed', { error: err instanceof Error ? err.name : 'error' })
    await prisma.repairJob.update({ where: { id: jobId }, data: { status: 'failed', finishedAt: new Date() } }).catch(() => undefined)
  }
}

function launch(jobId: string) {
  current = runJob(jobId)
}

export async function startRepair(): Promise<RepairJob> {
  await prisma.appSetting.upsert({ where: { id: 1 }, create: { id: 1, priorityAccountIds: [] }, update: {} })
  // The same row lock that serialises reservations makes check-and-create atomic.
  const job = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM app_settings WHERE id = 1 FOR UPDATE`
    if (await tx.repairJob.findFirst({ where: { status: 'running' } })) throw new RepairError(409, 'REPAIR_RUNNING', 'A repair is already running.')
    return tx.repairJob.create({ data: { status: 'running' } })
  })
  launch(job.id)
  return job
}

/** Fails repair sessions a crash left open, then carries on a job that was running. */
export async function resumeRepairOnBoot(): Promise<void> {
  const stale = await prisma.uploadSession.findMany({ where: { status: 'repairing' }, include: { replicas: true } })
  const accounts = new Map((await prisma.connectedAccount.findMany({ where: { id: { in: stale.flatMap((x) => x.replicas.map((r) => r.connectedAccountId)) } } })).map((a) => [a.id, a]))
  for (const session of stale) {
    await prisma.uploadSession.updateMany({ where: { id: session.id, status: 'repairing' }, data: { status: 'failed', errorMessage: 'Interrupted by restart.' } })
    for (const r of session.replicas) {
      const state: ReplicaUploadState = {
        sessionUri: r.sessionUriEncrypted ? decryptText(r.sessionUriEncrypted) : undefined,
        s3UploadId: r.s3UploadId ?? undefined,
        providerFileId: r.providerFileId ?? undefined,
        partEtags: Array.isArray(r.partEtags) ? (r.partEtags as string[]) : undefined,
      }
      const account = accounts.get(r.connectedAccountId)
      if (account && (state.sessionUri || state.s3UploadId || state.providerFileId)) await providerFor(account).abortUpload(account, state).catch(() => undefined)
    }
  }
  const job = await prisma.repairJob.findFirst({ where: { status: 'running' }, orderBy: { startedAt: 'desc' } })
  if (job) launch(job.id)
}
