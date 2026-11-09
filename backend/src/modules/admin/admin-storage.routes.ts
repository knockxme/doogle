import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireAdmin } from '../../middleware/admin.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { countFilesMissingCopy, RepairError, startRepair } from './repair.js'
import { loadCandidates } from '../storage/pool.js'
import { effectiveFree } from '../storage/pool-select.js'

export const adminStorageRouter = Router()
adminStorageRouter.use(requireAuth, requireAdmin)

const bytesOrNull = z.union([z.coerce.bigint().nonnegative(), z.null()])
const routingModes = ['most_available', 'round_robin', 'priority'] as const

const str = (v: bigint | null) => (v === null ? null : v.toString())

adminStorageRouter.get('/accounts', async (_req, res, next) => {
  try {
    const candidates = await loadCandidates()
    const ids = candidates.map((c) => c.id)
    const [accounts, lost] = await Promise.all([
      prisma.connectedAccount.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, displayName: true, provider: true } }),
      prisma.fileReplica.groupBy({ by: ['connectedAccountId'], where: { connectedAccountId: { in: ids }, status: 'lost' }, _count: { _all: true } }),
    ])
    const info = new Map(accounts.map((a) => [a.id, a]))
    const lostBy = new Map(lost.map((l) => [l.connectedAccountId, l._count._all]))
    const now = Date.now()
    return res.json({
      accounts: candidates.map((c) => {
        const free = effectiveFree(c)
        const paused = c.pausedUntil !== null && c.pausedUntil.getTime() > now
        const full = free !== null && free <= 0n
        const a = info.get(c.id)
        return {
          id: c.id,
          provider: c.provider,
          email: a?.email ?? null,
          displayName: a?.displayName ?? null,
          capBytes: str(c.capBytes),
          storedBytes: c.appStoredBytes.toString(),
          reservedBytes: c.reservedBytes.toString(),
          providerFreeBytes: str(c.providerFreeBytes),
          effectiveFreeBytes: str(free),
          pausedUntil: c.pausedUntil,
          status: paused ? 'paused' : full ? 'full' : 'ok',
          full,
          lostCopies: lostBy.get(c.id) ?? 0,
        }
      }),
    })
  } catch (error) {
    return next(error)
  }
})

adminStorageRouter.patch('/accounts/:id', async (req, res, next) => {
  try {
    const body = z.object({ capBytes: bytesOrNull }).parse(req.body)
    const updated = await prisma.connectedAccount.updateMany({ where: { id: String(req.params.id) }, data: { capBytes: body.capBytes } })
    if (updated.count === 0) return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' })
    return res.json({ id: String(req.params.id), capBytes: str(body.capBytes) })
  } catch (error) {
    return next(error)
  }
})

async function readSettings() {
  const s = await prisma.appSetting.upsert({ where: { id: 1 }, create: { id: 1, priorityAccountIds: [] }, update: {} })
  return {
    defaultAccountCapBytes: str(s.defaultAccountCapBytes),
    routingMode: s.routingMode,
    priorityAccountIds: Array.isArray(s.priorityAccountIds) ? s.priorityAccountIds.filter((v): v is string => typeof v === 'string') : [],
  }
}

adminStorageRouter.get('/settings', async (_req, res, next) => {
  try {
    return res.json(await readSettings())
  } catch (error) {
    return next(error)
  }
})

adminStorageRouter.patch('/settings', async (req, res, next) => {
  try {
    const body = z.object({
      defaultAccountCapBytes: bytesOrNull.optional(),
      routingMode: z.enum(routingModes).optional(),
      priorityAccountIds: z.array(z.string().min(1)).max(100).optional(),
    }).parse(req.body)
    await readSettings()
    const data: Record<string, unknown> = {}
    if (body.defaultAccountCapBytes !== undefined) data.defaultAccountCapBytes = body.defaultAccountCapBytes
    if (body.routingMode !== undefined) {
      data.routingMode = body.routingMode
      if (body.routingMode !== 'round_robin') data.roundRobinCursor = 0
    }
    if (body.priorityAccountIds !== undefined) {
      const wanted = [...new Set(body.priorityAccountIds)]
      const valid = await prisma.connectedAccount.findMany({ where: { id: { in: wanted }, status: 'connected' }, select: { id: true } })
      const ok = new Set(valid.map((v) => v.id))
      data.priorityAccountIds = wanted.filter((id) => ok.has(id))
    }
    await prisma.appSetting.update({ where: { id: 1 }, data })
    return res.json(await readSettings())
  } catch (error) {
    return next(error)
  }
})

adminStorageRouter.post('/repair', async (_req, res, next) => {
  try {
    return res.status(202).json(repairJobJson(await startRepair()))
  } catch (error) {
    if (error instanceof RepairError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

adminStorageRouter.get('/repair', async (_req, res, next) => {
  try {
    const job = await prisma.repairJob.findFirst({ orderBy: { startedAt: 'desc' } })
    return res.json(job ? repairJobJson(job) : null)
  } catch (error) {
    return next(error)
  }
})

function repairJobJson(job: { id: string; status: string; processed: number; failed: number; startedAt: Date; finishedAt: Date | null }) {
  return { id: job.id, status: job.status, processed: job.processed, failed: job.failed, startedAt: job.startedAt, finishedAt: job.finishedAt }
}

adminStorageRouter.get('/health', async (_req, res, next) => {
  try {
    const [accounts, counts, candidates, filesMissingCopy] = await Promise.all([
      prisma.connectedAccount.findMany({ select: { id: true, email: true, status: true, lastError: true }, orderBy: { createdAt: 'asc' } }),
      prisma.fileReplica.groupBy({ by: ['connectedAccountId', 'status'], _count: { _all: true } }),
      loadCandidates(),
      countFilesMissingCopy(),
    ])
    const free = new Map(candidates.map((c) => [c.id, effectiveFree(c)]))
    const count = (id: string, status: string) => counts.find((c) => c.connectedAccountId === id && c.status === status)?._count._all ?? 0
    return res.json({
      accounts: accounts.map((a) => {
        const f = free.get(a.id)
        return { id: a.id, email: a.email, status: a.status, lastError: a.lastError, healthyCopies: count(a.id, 'healthy'), lostCopies: count(a.id, 'lost'), full: f !== undefined && f !== null && f <= 0n }
      }),
      filesMissingCopy,
    })
  } catch (error) {
    return next(error)
  }
})
