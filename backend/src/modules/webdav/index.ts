import type { IncomingMessage, ServerResponse } from 'node:http'
import { DavAuth } from './auth.js'
import { PieceCache } from './cache.js'
import type { DavConfig } from './config.js'
import { onForgetDavLogins } from './logins.js'
import { ALLOW, del, get, mkcol, move, options, propfind, put, type Ctx } from './methods.js'
import { DavError, type DavPorts } from './ports.js'
import { splitPath, stripPrefix } from './util.js'

export type { DavConfig } from './config.js'
export { DavError, type DavNode, type DavPorts, type DavUser, type UploadSession } from './ports.js'

export type DavHandler = ((req: IncomingMessage, res: ServerResponse) => Promise<void>) & { auth: DavAuth; cache: PieceCache; close(): void }

/**
 * Builds the WebDAV request handler on plain Node req/res. Mount it before any body parser and before
 * cors(): PUT bodies must arrive untouched, and cors() would answer OPTIONS itself.
 */
export function createDavHandler(ports: DavPorts, cfg: DavConfig, log: (msg: string, err?: unknown) => void = defaultLog): DavHandler {
  const auth = new DavAuth(ports, cfg.clientIp)
  const cache = new PieceCache(cfg.cacheBytes)
  const ctx: Ctx = { ports, cfg, cache }
  const unregister = onForgetDavLogins(() => auth.forgetAll())

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const method = (req.method ?? 'GET').toUpperCase()
    try {
      res.setHeader('DAV', '1')
      if (method === 'OPTIONS') return options(res)

      const user = await auth.check(req)
      const parts = splitPath(stripPrefix(req.url ?? '/', cfg.stripPrefix))

      switch (method) {
        case 'PROPFIND':
          return await propfind(ctx, req, res, user, parts)
        case 'GET':
          return await get(ctx, req, res, user, parts, false)
        case 'HEAD':
          return await get(ctx, req, res, user, parts, true)
        case 'PUT':
          return await put(ctx, req, res, user, parts)
        case 'DELETE':
          return await del(ctx, req, res, user, parts)
        case 'MKCOL':
          return await mkcol(ctx, req, res, user, parts)
        case 'MOVE':
          return await move(ctx, req, res, user, parts)
        default:
          // COPY, LOCK, UNLOCK, PROPPATCH are not needed by rclone.
          throw new DavError(405, `${method} is not supported`)
      }
    } catch (err) {
      sendError(res, err, method, log)
    }
  }

  return Object.assign(handler, { auth, cache, close: unregister })
}

// The URL is left out: it holds file and folder names.
function defaultLog(msg: string, err?: unknown) {
  console.error(msg, err instanceof Error ? err.name : '')
}

function sendError(res: ServerResponse, err: unknown, method: string, log: (m: string, e?: unknown) => void) {
  const status = err instanceof DavError ? err.status : 500
  const message = err instanceof DavError ? err.message : 'Internal server error'
  if (status >= 500) log(`[webdav] ${method} failed with ${status}`, err)

  if (res.headersSent) {
    res.destroy() // mid-stream failure: cut the connection so the client retries
    return
  }
  res.statusCode = status
  if (status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="Family Drive", charset="UTF-8"')
  if (status === 405) res.setHeader('Allow', ALLOW)
  if (method === 'PUT') res.setHeader('Connection', 'close') // don't wait for an unread upload body
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(message + '\n')
}
