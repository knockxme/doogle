import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { DavError, type DavPorts, type DavUser } from './ports.js'

const OK_TTL_MS = 60_000 // a good key is re-checked at most once a minute
const FAIL_WINDOW_MS = 15 * 60_000
const MAX_FAILS = 10
const MAX_TRACKED = 10_000

/** HTTP Basic auth: username = the member's email, password = one of their WebDAV API keys. */
export class DavAuth {
  private ok = new Map<string, { user: DavUser; until: number }>()
  private fails = new Map<string, { count: number; until: number }>()

  constructor(private readonly ports: DavPorts, private readonly clientIp: (req: IncomingMessage) => string) {}

  async check(req: IncomingMessage): Promise<DavUser> {
    const now = Date.now()
    const ip = this.clientIp(req)
    const f = this.fails.get(ip)
    if (f && f.until > now && f.count >= MAX_FAILS) throw new DavError(429, 'Too many failed sign-ins, try again later')

    const header = req.headers.authorization ?? ''
    if (!header.startsWith('Basic ')) throw new DavError(401, 'Authentication required')

    const cacheKey = createHash('sha256').update(header).digest('hex')
    const hit = this.ok.get(cacheKey)
    if (hit && hit.until > now) return hit.user

    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const sep = decoded.indexOf(':')
    const email = sep > 0 ? decoded.slice(0, sep) : ''
    const key = sep > 0 ? decoded.slice(sep + 1) : ''
    const user = email && key ? await this.ports.authenticate(email, key) : null

    if (!user) {
      const cur = f && f.until > now ? f : { count: 0, until: now + FAIL_WINDOW_MS }
      cur.count += 1
      this.fails.delete(ip)
      this.fails.set(ip, cur)
      // Drop the oldest entry, never all of them: clearing would let a flood reset every counter.
      if (this.fails.size > MAX_TRACKED) this.fails.delete(this.fails.keys().next().value as string)
      throw new DavError(401, 'Wrong email or API key')
    }

    this.fails.delete(ip)
    if (this.ok.size > 1_000) this.ok.delete(this.ok.keys().next().value as string)
    this.ok.set(cacheKey, { user, until: now + OK_TTL_MS })
    return user
  }

  /** Forget every cached good key, so the next request is checked again. */
  forgetAll(): void {
    this.ok.clear()
  }
}
