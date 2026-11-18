import { prisma } from '../../config/prisma.js'
import { failUpload } from './encrypted-upload.js'

/** An upload with no chunk for this long is given up: its reservation is released and its partial copies are aborted. */
export const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000
const SWEEP_EVERY_MS = 60 * 60 * 1000

/** Fails every in-progress upload idle for longer than STALE_UPLOAD_MS. Returns how many were failed. */
export async function sweepStaleUploads(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_UPLOAD_MS)
  const stale = await prisma.uploadSession.findMany({ where: { status: 'uploading', lastActivityAt: { lt: cutoff } }, select: { id: true } })
  for (const session of stale) await failUpload(session.id, 'Upload abandoned.').catch(() => undefined)
  return stale.length
}

type Sweep = () => Promise<unknown>

/** Runs the given sweeps now and then every hour. The timer does not keep the process alive. */
export function scheduleSweeps(sweeps: Sweep[]): NodeJS.Timeout {
  const run = () => {
    void (async () => {
      for (const sweep of sweeps) {
        await sweep().catch((error) => console.error('Cleanup sweep failed:', error instanceof Error ? error.name : 'unknown error'))
      }
    })()
  }
  run()
  const timer = setInterval(run, SWEEP_EVERY_MS)
  timer.unref()
  return timer
}
