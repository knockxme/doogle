import { Router } from 'express'
import { prisma } from '../../config/prisma.js'
import { requireAdmin } from '../../middleware/admin.middleware.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { loadCandidates, userAvailable } from './pool.js'
import { usablePoolBytes } from './pool-select.js'

export const storageRouter = Router()
storageRouter.use(requireAuth)

type BreakdownRow = { kind: string; bytes: bigint | number | string | null }

function bytesToString(value: bigint | number | string | null | undefined) {
  if (value === null || value === undefined) return '0'
  return value.toString()
}

storageRouter.get('/summary', async (req: AuthRequest, res, next) => {
  try {
    const usage = await userAvailable(req.user!.id)
    const body: Record<string, unknown> = {
      usedBytes: usage.usedBytes.toString(),
      limitBytes: usage.limitBytes?.toString() ?? null,
      availableBytes: usage.availableBytes?.toString() ?? null,
    }
    if (req.user!.role === 'admin') {
      const usable = usablePoolBytes(await loadCandidates(), new Date())
      body.poolUsableBytes = usable?.toString() ?? null
    }
    return res.json(body)
  } catch (error) {
    return next(error)
  }
})

storageRouter.get('/breakdown', requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const rows = await prisma.$queryRaw<BreakdownRow[]>`
      SELECT
        CASE
          WHEN mime_type LIKE 'image/%' THEN 'photo'
          WHEN mime_type LIKE 'video/%' THEN 'video'
          ELSE 'document'
        END AS kind,
        COALESCE(SUM(size_bytes), 0) AS bytes
      FROM files
      WHERE user_id = ${req.user!.id} AND status = 'active'
      GROUP BY kind
    `
    const breakdown = { photo: '0', video: '0', document: '0' }
    for (const row of rows) {
      if (row.kind === 'photo' || row.kind === 'video' || row.kind === 'document') breakdown[row.kind] = bytesToString(row.bytes)
    }
    return res.json(breakdown)
  } catch (error) {
    return next(error)
  }
})
