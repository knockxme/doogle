import type { IncomingMessage } from 'node:http'

export interface DavConfig {
  /** Path clients use, e.g. '/api/dav'. Used for hrefs and to read the MOVE Destination header. */
  publicPrefix: string
  /** Removed from req.url when present. Empty when the router already strips the mount path (Express app.use does). */
  stripPrefix: string
  /** Largest file accepted by PUT, in bytes. */
  maxFileBytes: number
  /** RAM used to cache decrypted pieces, in bytes. */
  cacheBytes: number
  /** How many pieces to fetch ahead while a file is read. */
  readAheadPieces: number
  /**
   * The client address for the failed sign-in limit. Must not trust headers a client can set:
   * with Express use `req.ip` (which honours `trust proxy`).
   */
  clientIp(req: IncomingMessage): string
}
