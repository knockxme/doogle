import type { Response } from 'express'

export const FALLBACK_MIME_TYPE = 'application/octet-stream'

// RFC 6838 restricted-name characters: no spaces, parameters or control characters.
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i

// Types a browser may render on the app origin. SVG and HTML can run script, so they are never here.
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf'])

/** A strict `type/subtype` (lowercased), or application/octet-stream for anything else. Never rejects. */
export function normalizeMimeType(value: unknown): string {
  if (typeof value !== 'string') return FALLBACK_MIME_TYPE
  const trimmed = value.trim()
  return MIME_TYPE.test(trimmed) ? trimmed.toLowerCase() : FALLBACK_MIME_TYPE
}

export function isInlineMimeType(mimeType: string): boolean {
  const type = mimeType.toLowerCase()
  if (!MIME_TYPE.test(type)) return false
  return INLINE_TYPES.has(type) || type.startsWith('video/') || type.startsWith('audio/')
}

/** The Content-Type and disposition a stored file is served with: inline only for allowlisted types. */
export function servedAs(mimeType: string, requested: 'inline' | 'attachment' | undefined): { contentType: string; disposition: 'inline' | 'attachment' } {
  if (!isInlineMimeType(mimeType)) return { contentType: FALLBACK_MIME_TYPE, disposition: 'attachment' }
  return { contentType: mimeType.toLowerCase(), disposition: requested ?? 'attachment' }
}

/** Set on every response that carries file bytes, so the browser never sniffs or runs them. */
export function setFileSecurityHeaders(res: Pick<Response, 'setHeader'> | { setHeader(name: string, value: string): unknown }) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
}
