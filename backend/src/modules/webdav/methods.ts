import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PieceCache } from './cache.js'
import type { DavConfig } from './config.js'
import { DavError, type DavNode, type DavPorts, type DavUser } from './ports.js'
import { TEMP_PREFIX, guessMime, hrefFor, parseRange, splitPath, toPieces } from './util.js'
import { etagOf, multistatus, propResponse } from './xml.js'
import { contentDisposition } from '../files/stream-file.js'
import { setFileSecurityHeaders } from '../files/content-type.js'

export interface Ctx {
  ports: DavPorts
  cfg: DavConfig
  cache: PieceCache
}

// ---------------------------------------------------------------- path helpers

async function resolve(ctx: Ctx, user: DavUser, parts: string[]): Promise<DavNode | null> {
  let node = await ctx.ports.rootFolder(user)
  for (const name of parts) {
    if (node.type !== 'folder') return null
    const next = await ctx.ports.child(user, node.id, name)
    if (!next) return null
    node = next
  }
  return node
}

/** Parent folder of the last segment. 409 Conflict if it does not exist (RFC 4918). */
async function resolveParent(ctx: Ctx, user: DavUser, parts: string[]): Promise<{ parent: DavNode; name: string }> {
  const name = parts[parts.length - 1]
  if (!name) throw new DavError(405, 'Not allowed on the root folder')
  const parent = await resolve(ctx, user, parts.slice(0, -1))
  if (!parent || parent.type !== 'folder') throw new DavError(409, 'Parent folder does not exist')
  return { parent, name }
}

const isTemp = (n: DavNode) => n.name.startsWith(TEMP_PREFIX)

function waitDrain(res: ServerResponse): Promise<void> {
  return new Promise((done) => {
    const finish = () => {
      res.off('drain', finish)
      res.off('close', finish)
      done()
    }
    res.on('drain', finish)
    res.on('close', finish)
  })
}

// ---------------------------------------------------------------- OPTIONS

export const ALLOW = 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE'

export function options(res: ServerResponse): void {
  res.statusCode = 200
  res.setHeader('Allow', ALLOW)
  res.setHeader('MS-Author-Via', 'DAV')
  res.setHeader('Content-Length', '0')
  res.end()
}

// ---------------------------------------------------------------- PROPFIND

export async function propfind(ctx: Ctx, req: IncomingMessage, res: ServerResponse, user: DavUser, parts: string[]) {
  req.resume() // body (prop list) is ignored: we always answer with all props
  const depthHeader = String(req.headers.depth ?? '1').toLowerCase()
  if (depthHeader === 'infinity') {
    res.statusCode = 403
    res.setHeader('Content-Type', 'application/xml; charset=utf-8')
    res.end('<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:"><d:propfind-finite-depth/></d:error>')
    return
  }
  const depth = depthHeader === '0' ? 0 : 1

  const node = await resolve(ctx, user, parts)
  if (!node || isTemp(node)) throw new DavError(404, 'Not found')

  const quota = node.type === 'folder' ? await ctx.ports.quota(user) : undefined
  const out = [propResponse(hrefFor(ctx.cfg.publicPrefix, parts, node.type === 'folder'), node, quota)]

  if (depth === 1 && node.type === 'folder') {
    for (const c of await ctx.ports.children(user, node.id)) {
      if (isTemp(c)) continue
      out.push(propResponse(hrefFor(ctx.cfg.publicPrefix, [...parts, c.name], c.type === 'folder'), c))
    }
  }

  const body = multistatus(out)
  res.statusCode = 207
  res.setHeader('Content-Type', 'application/xml; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

// ---------------------------------------------------------------- GET / HEAD

export async function get(ctx: Ctx, req: IncomingMessage, res: ServerResponse, user: DavUser, parts: string[], head: boolean) {
  const node = await resolve(ctx, user, parts)
  if (!node || isTemp(node)) throw new DavError(404, 'Not found')
  if (node.type === 'folder') throw new DavError(405, 'Use PROPFIND to list a folder')

  const etag = etagOf(node)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('ETag', etag)
  res.setHeader('Last-Modified', node.modifiedAt.toUTCString())
  // Served on the app's own address: never let a browser render or run it (same rule as normal downloads).
  setFileSecurityHeaders(res)
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Disposition', contentDisposition('attachment', node.name))

  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304
    res.end()
    return
  }

  // If-Range: only honour Range when the client's copy is still current.
  const ifRange = req.headers['if-range']
  const rangeHeader = !ifRange || ifRange === etag ? req.headers.range : undefined
  const range = parseRange(rangeHeader, node.size)

  if (range === 'bad') {
    res.statusCode = 416
    res.setHeader('Content-Range', `bytes */${node.size}`)
    res.end()
    return
  }

  const start = range ? range.start : 0
  const end = range ? range.end : node.size - 1
  res.statusCode = range ? 206 : 200
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${node.size}`)
  res.setHeader('Content-Length', String(node.size === 0 ? 0 : end - start + 1))

  if (head || node.size === 0) {
    res.end()
    return
  }

  const P = ctx.ports.pieceSize
  const first = Math.floor(start / P)
  const last = Math.floor(end / P)
  const load = (i: number) => () => ctx.ports.readPiece(user, node.id, i)

  for (let i = first; i <= last; i++) {
    const buf = await ctx.cache.get(`${node.id}:${i}`, load(i))
    for (let k = 1; k <= ctx.cfg.readAheadPieces; k++) {
      const j = i + k
      if (j * P < node.size) ctx.cache.prefetch(`${node.id}:${j}`, load(j))
    }
    const s = i === first ? start - i * P : 0
    const e = i === last ? end - i * P + 1 : buf.length
    if (res.destroyed) return
    if (!res.write(buf.subarray(s, e))) await waitDrain(res)
  }
  res.end()
}

// ---------------------------------------------------------------- PUT

export async function put(ctx: Ctx, req: IncomingMessage, res: ServerResponse, user: DavUser, parts: string[]) {
  const lenHeader = req.headers['content-length']
  // No Content-Length and no chunked body = empty body (HTTP/1.1). Chunked uploads of
  // unknown size can't reserve space up front, so they are refused.
  if (lenHeader === undefined && req.headers['transfer-encoding']) throw new DavError(411, 'Content-Length is required')
  const size = lenHeader === undefined ? 0 : Number(lenHeader)
  if (!Number.isSafeInteger(size) || size < 0) throw new DavError(400, 'Bad Content-Length')
  if (size > ctx.cfg.maxFileBytes) throw new DavError(413, `File is larger than ${ctx.cfg.maxFileBytes} bytes`)

  const { parent, name } = await resolveParent(ctx, user, parts)
  if (name.startsWith(TEMP_PREFIX)) throw new DavError(400, 'Reserved file name')
  const existing = await ctx.ports.child(user, parent.id, name)
  if (existing?.type === 'folder') throw new DavError(405, 'A folder with this name exists')

  const mtime = req.headers['x-oc-mtime']
  const mtimeSec = mtime ? Number(Array.isArray(mtime) ? mtime[0] : mtime) : NaN
  const modifiedAt = Number.isFinite(mtimeSec) && mtimeSec > 0 ? new Date(mtimeSec * 1000) : undefined

  // Upload under a hidden temp name, then swap it in. An interrupted upload
  // therefore never replaces or half-writes the existing file.
  const tempName = `${TEMP_PREFIX}${randomUUID()}`
  const session = await ctx.ports.beginUpload(user, {
    parentId: parent.id,
    name: tempName,
    size,
    mimeType: guessMime(name),
    modifiedAt,
  })

  let node: DavNode
  try {
    let index = 0
    let received = 0
    for await (const piece of toPieces(req, ctx.ports.pieceSize)) {
      received += piece.length
      if (received > size) throw new DavError(400, 'Body is longer than Content-Length')
      await session.writePiece(index++, piece) // the loop pauses the socket while this runs
    }
    if (received !== size) throw new DavError(400, 'Body is shorter than Content-Length')
    node = await session.commit()
  } catch (err) {
    await session.abort(err instanceof Error ? err.message : 'Upload failed').catch(() => undefined)
    throw err
  }

  // One transaction swaps the new file in and removes the old one, so a failure never loses either.
  const temp = node
  try {
    node = await ctx.ports.replace(user, temp.id, existing?.id ?? null, parent.id, name)
  } catch (err) {
    await ctx.ports.remove(user, temp.id).catch(() => undefined)
    throw err
  }
  if (existing) ctx.cache.invalidateFile(existing.id)

  res.statusCode = existing ? 204 : 201
  res.setHeader('ETag', etagOf(node))
  if (modifiedAt) res.setHeader('X-OC-Mtime', 'accepted')
  res.setHeader('Content-Length', '0')
  res.end()
}

// ---------------------------------------------------------------- DELETE

export async function del(ctx: Ctx, req: IncomingMessage, res: ServerResponse, user: DavUser, parts: string[]) {
  req.resume()
  if (parts.length === 0) throw new DavError(403, 'Cannot delete the root folder')
  const node = await resolve(ctx, user, parts)
  if (!node || isTemp(node)) throw new DavError(404, 'Not found')
  await ctx.ports.remove(user, node.id)
  if (node.type === 'file') ctx.cache.invalidateFile(node.id)
  res.statusCode = 204
  res.end()
}

// ---------------------------------------------------------------- MKCOL

export async function mkcol(ctx: Ctx, req: IncomingMessage, res: ServerResponse, user: DavUser, parts: string[]) {
  if (Number(req.headers['content-length'] ?? 0) > 0) {
    req.resume()
    throw new DavError(415, 'MKCOL with a body is not supported')
  }
  if (parts.length === 0) throw new DavError(405, 'Root folder already exists')
  const { parent, name } = await resolveParent(ctx, user, parts)
  if (name.startsWith(TEMP_PREFIX)) throw new DavError(400, 'Reserved folder name')
  if (await ctx.ports.child(user, parent.id, name)) throw new DavError(405, 'Already exists')
  await ctx.ports.createFolder(user, parent.id, name)
  res.statusCode = 201
  res.setHeader('Content-Length', '0')
  res.end()
}

// ---------------------------------------------------------------- MOVE

export async function move(ctx: Ctx, req: IncomingMessage, res: ServerResponse, user: DavUser, parts: string[]) {
  req.resume()
  const destHeader = req.headers.destination
  if (!destHeader || Array.isArray(destHeader)) throw new DavError(400, 'Destination header is required')

  let destPath: string
  try {
    destPath = new URL(destHeader, 'http://local').pathname
  } catch {
    throw new DavError(400, 'Bad Destination header')
  }
  const prefix = ctx.cfg.publicPrefix
  if (destPath !== prefix && !destPath.startsWith(prefix + '/')) {
    throw new DavError(502, 'Destination is outside this WebDAV share')
  }
  const destParts = splitPath(destPath.slice(prefix.length))

  if (parts.length === 0 || destParts.length === 0) throw new DavError(403, 'Cannot move the root folder')
  const src = await resolve(ctx, user, parts)
  if (!src || isTemp(src)) throw new DavError(404, 'Not found')

  const inside = destParts.length > parts.length && parts.every((p, i) => destParts[i] === p)
  if (src.type === 'folder' && inside) throw new DavError(409, 'Cannot move a folder into itself')

  const { parent, name } = await resolveParent(ctx, user, destParts)
  if (name.startsWith(TEMP_PREFIX)) throw new DavError(400, 'Reserved name')

  const overwrite = String(req.headers.overwrite ?? 'T').toUpperCase() !== 'F'
  const existing = await ctx.ports.child(user, parent.id, name)
  if (existing && existing.id === src.id) {
    res.statusCode = 204
    res.end()
    return
  }
  if (existing && !overwrite) throw new DavError(412, 'Destination exists and Overwrite is F')
  if (existing) {
    await ctx.ports.replace(user, src.id, existing.id, parent.id, name)
    if (existing.type === 'file') ctx.cache.invalidateFile(existing.id)
  } else {
    await ctx.ports.move(user, src.id, parent.id, name)
  }
  res.statusCode = existing ? 204 : 201
  res.setHeader('Content-Length', '0')
  res.end()
}
