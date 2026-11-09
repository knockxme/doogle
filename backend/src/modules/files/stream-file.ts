import type { Response } from 'express'
import { pipeline } from 'node:stream'
import { parseRange } from '../crypto/range.js'
import { FileUnavailableError, openDecryptedStream, type FileWithReplicas } from './decrypt-stream.js'

export type { FileWithReplicas } from './decrypt-stream.js'
type StreamOptions = { disposition?: 'inline' | 'attachment' }

export function contentDisposition(type: 'inline' | 'attachment', fileName: string) {
  const clean = fileName.replace(/[\r\n"]/g, '')
  const fallback = clean.replace(/[^\x20-\x7e]/g, '_').replace(/\\/g, '_')
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

export async function streamProviderFile(file: FileWithReplicas, range: string | undefined, res: Response, options: StreamOptions = {}) {
  const size = file.sizeBytes
  const parsed = parseRange(range, size)
  if (parsed === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${size}`)
    return res.status(416).json({ code: 'RANGE_NOT_SATISFIABLE', message: 'Requested range not satisfiable.' })
  }

  let stream
  try {
    stream = await openDecryptedStream(file, parsed)
  } catch (error) {
    if (!(error instanceof FileUnavailableError)) console.error(`Could not open file ${file.id}:`, error instanceof Error ? error.name : 'error')
    return res.status(502).json({ code: 'FILE_UNAVAILABLE', message: 'File is temporarily unavailable.' })
  }

  const length = parsed ? parsed.end - parsed.start + 1n : size
  res.status(parsed ? 206 : 200)
  res.setHeader('Content-Type', file.mimeType)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Length', length.toString())
  if (parsed) res.setHeader('Content-Range', `bytes ${parsed.start}-${parsed.end}/${size}`)
  if (options.disposition) res.setHeader('Content-Disposition', contentDisposition(options.disposition, file.name))

  await new Promise<void>((resolve) => {
    pipeline(stream, res, (err) => {
      if (err) {
        console.error(`Stream of file ${file.id} ended early:`, err instanceof Error ? err.name : 'error')
        res.destroy()
      }
      resolve()
    })
  })
}
