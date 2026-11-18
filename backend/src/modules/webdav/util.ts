import { DavError } from './ports.js'

/** Hidden name used while an upload is in progress. Filtered out of listings. */
export const TEMP_PREFIX = '.dav-upload-'

export function stripPrefix(url: string, prefix: string): string {
  const path = url.split('?')[0] ?? '/'
  if (!prefix) return path
  if (path === prefix) return '/'
  if (path.startsWith(prefix + '/')) return path.slice(prefix.length)
  return path
}

/** '/tv/My%20Show/' → ['tv', 'My Show']. Rejects '.', '..', NUL and encoded slashes. */
export function splitPath(path: string): string[] {
  const out: string[] = []
  for (const raw of path.split('/')) {
    if (!raw) continue
    let seg: string
    try {
      seg = decodeURIComponent(raw)
    } catch {
      throw new DavError(400, 'Bad path encoding')
    }
    if (seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\') || seg.includes('\0')) {
      throw new DavError(400, 'Bad path segment')
    }
    if (seg.length > 255) throw new DavError(400, 'Name too long')
    out.push(seg)
  }
  return out
}

export function hrefFor(publicPrefix: string, parts: string[], isFolder: boolean): string {
  const tail = parts.map(encodeURIComponent).join('/')
  if (!tail) return `${publicPrefix}/`
  return `${publicPrefix}/${tail}${isFolder ? '/' : ''}`
}

/** Parse a single byte range. null = no/ignored range, 'bad' = 416. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'bad' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)\s*(?:,.*)?$/.exec(header.trim())
  if (!m) return null
  const [, a = '', b = ''] = m
  if (a === '' && b === '') return null
  let start: number
  let end: number
  if (a === '') {
    const n = Number(b)
    if (n === 0) return 'bad'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(a)
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  }
  if (size === 0 || start >= size || start > end) return 'bad'
  return { start, end }
}

/** Re-cut any incoming byte stream into fixed-size pieces (last one may be shorter). */
export async function* toPieces(src: AsyncIterable<Buffer | string>, pieceSize: number): AsyncGenerator<Buffer> {
  let parts: Buffer[] = []
  let len = 0
  for await (const chunk of src) {
    let c = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    while (c.length > 0) {
      const take = Math.min(pieceSize - len, c.length)
      parts.push(c.subarray(0, take))
      len += take
      c = c.subarray(take)
      if (len === pieceSize) {
        yield Buffer.concat(parts, len)
        parts = []
        len = 0
      }
    }
  }
  if (len > 0) yield Buffer.concat(parts, len)
}

const MIME: Record<string, string> = {
  mkv: 'video/x-matroska',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  ts: 'video/mp2t',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  srt: 'application/x-subrip',
  ass: 'text/x-ssa',
  vtt: 'text/vtt',
  nfo: 'text/xml',
  xml: 'text/xml',
  txt: 'text/plain',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
}

export function guessMime(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return MIME[ext] ?? 'application/octet-stream'
}
