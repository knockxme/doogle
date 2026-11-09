import { FRAME_PLAINTEXT, FRAME_SIZE } from './frames.js'

export type ByteRange = { start: bigint; end: bigint }

const P = BigInt(FRAME_PLAINTEXT)
const F = BigInt(FRAME_SIZE)

/** Parse a single-range HTTP Range header. null = serve whole file (absent, malformed, or multi-range). */
export function parseRange(header: string | undefined, size: bigint): ByteRange | null | 'unsatisfiable' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, a, b] = m
  if (a === '' && b === '') return null
  if (a === '') {
    const n = BigInt(b)
    if (n === 0n || size === 0n) return 'unsatisfiable'
    return { start: n >= size ? 0n : size - n, end: size - 1n }
  }
  const start = BigInt(a)
  let end = b === '' ? size - 1n : BigInt(b)
  if (b !== '' && end < start) return null
  if (start >= size) return 'unsatisfiable'
  if (end >= size) end = size - 1n
  return { start, end }
}

export function frameSpan(range: ByteRange): {
  firstFrame: number
  lastFrame: number
  cipherStart: bigint
  cipherEnd: bigint
  skipHead: number
} {
  const first = range.start / P
  const last = range.end / P
  return {
    firstFrame: Number(first),
    lastFrame: Number(last),
    cipherStart: first * F,
    cipherEnd: (last + 1n) * F - 1n,
    skipHead: Number(range.start - first * P),
  }
}
