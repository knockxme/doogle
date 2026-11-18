import type { DavNode } from './ports.js'

// Characters XML 1.0 does not allow. One in a file name would break the whole listing for the client.
const INVALID_XML = /[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu

export const esc = (s: string) =>
  s.replace(INVALID_XML, '�').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const etagOf = (n: DavNode) => `"${n.id}-${n.modifiedAt.getTime()}-${n.size}"`

export function propResponse(href: string, n: DavNode, quota?: { usedBytes: number; availableBytes: number | null }): string {
  const isDir = n.type === 'folder'
  let p = ''
  p += `<d:displayname>${esc(n.name)}</d:displayname>`
  p += `<d:resourcetype>${isDir ? '<d:collection/>' : ''}</d:resourcetype>`
  if (!isDir) {
    p += `<d:getcontentlength>${n.size}</d:getcontentlength>`
    p += `<d:getcontenttype>${esc(n.mimeType)}</d:getcontenttype>`
  }
  p += `<d:getlastmodified>${n.modifiedAt.toUTCString()}</d:getlastmodified>`
  p += `<d:creationdate>${n.createdAt.toISOString()}</d:creationdate>`
  p += `<d:getetag>${esc(etagOf(n))}</d:getetag>`
  if (isDir && quota) {
    p += `<d:quota-used-bytes>${quota.usedBytes}</d:quota-used-bytes>`
    if (quota.availableBytes !== null) p += `<d:quota-available-bytes>${quota.availableBytes}</d:quota-available-bytes>`
  }
  return `<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop>${p}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
}

export function multistatus(responses: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`
}
