import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { after, before, describe, it } from 'node:test'
import { DavAuth } from '../src/modules/webdav/auth.js'
import { createDavHandler, type DavHandler } from '../src/modules/webdav/index.js'
import { forgetDavLogins } from '../src/modules/webdav/logins.js'
import { DavError } from '../src/modules/webdav/ports.js'
import { parseRange, splitPath, TEMP_PREFIX } from '../src/modules/webdav/util.js'
import { esc } from '../src/modules/webdav/xml.js'
import { createMemoryPorts } from './webdav-memory-ports.js'

describe('webdav util', () => {
  it('splitPath decodes and rejects traversal', () => {
    assert.deepEqual(splitPath('/tv/My%20Show/'), ['tv', 'My Show'])
    assert.throws(() => splitPath('/a/../b'), DavError)
    assert.throws(() => splitPath('/a%2Fb'), DavError)
  })
  it('parseRange handles suffix, open and bad ranges', () => {
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
    assert.deepEqual(parseRange('bytes=95-', 100), { start: 95, end: 99 })
    assert.equal(parseRange('bytes=100-', 100), 'bad')
    assert.equal(parseRange(undefined, 100), null)
  })
  it('esc replaces characters XML cannot carry', () => {
    assert.equal(esc('a\u0001b<c>'), 'a�b&lt;c&gt;')
    assert.equal(esc('emoji 🎬'), 'emoji 🎬')
  })
})

describe('webdav auth', () => {
  const { ports } = createMemoryPorts({ email: 'm@x', apiKey: 'k' })
  const req = (ip: string, auth?: string) => ({ headers: auth ? { authorization: auth } : {}, socket: { remoteAddress: ip } }) as never
  const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`

  it('limits failures by the address the config gives, not by a header', async () => {
    const auth = new DavAuth(ports, () => 'one-client')
    for (let i = 0; i < 10; i++) await assert.rejects(auth.check(req(`spoof-${i}`, basic('m@x', 'wrong'))), (e: DavError) => e.status === 401)
    await assert.rejects(auth.check(req('spoof-new', basic('m@x', 'k'))), (e: DavError) => e.status === 429)
  })
  it('forgetDavLogins clears cached keys of every handler', async () => {
    let allowed = true
    const gated = { ...ports, authenticate: async (e: string, k: string) => (allowed ? ports.authenticate(e, k) : null) }
    const handler = createDavHandler(gated, { publicPrefix: '/api/dav', stripPrefix: '/api/dav', maxFileBytes: 1e9, cacheBytes: 0, readAheadPieces: 0, clientIp: () => 'x' })
    assert.ok(await handler.auth.check(req('x', basic('m@x', 'k'))))
    allowed = false
    assert.ok(await handler.auth.check(req('x', basic('m@x', 'k'))), 'still cached')
    forgetDavLogins()
    await assert.rejects(handler.auth.check(req('x', basic('m@x', 'k'))), (e: DavError) => e.status === 401)
    handler.close()
  })
})

describe('webdav methods', () => {
  const mem = createMemoryPorts({ email: 'm@x', apiKey: 'k', pieceSize: 1024 })
  let server: Server
  let dav: DavHandler
  let base = ''
  const auth = { Authorization: `Basic ${Buffer.from('m@x:k').toString('base64')}` }
  const call = (method: string, path: string, init: { body?: Buffer | string; headers?: Record<string, string> } = {}) =>
    fetch(base + path, { method, headers: { ...auth, ...init.headers }, body: init.body })

  before(async () => {
    dav = createDavHandler(mem.ports, { publicPrefix: '/api/dav', stripPrefix: '/api/dav', maxFileBytes: 1e9, cacheBytes: 1e6, readAheadPieces: 1, clientIp: () => 'x' })
    server = createServer((req, res) => void dav(req, res)).listen(0)
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(async () => {
    dav.close()
    await new Promise((r) => server.close(r))
  })

  test('a download never carries the stored type and cannot run in the browser', async () => {
    assert.equal((await call('PUT', '/api/dav/page.html', { body: '<script>alert(1)</script>' })).status, 201)
    const res = await call('GET', '/api/dav/page.html')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/octet-stream')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/)
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment/)
  })

  test('a failed swap keeps the old file and leaves no temp file behind', async () => {
    assert.equal((await call('PUT', '/api/dav/keep.txt', { body: 'old' })).status, 201)
    mem.hooks.failReplace = true
    try {
      assert.equal((await call('PUT', '/api/dav/keep.txt', { body: 'new content' })).status, 500)
    } finally {
      mem.hooks.failReplace = false
    }
    assert.equal(await (await call('GET', '/api/dav/keep.txt')).text(), 'old')
    assert.equal([...mem.nodes.values()].some((n) => n.name.startsWith(TEMP_PREFIX)), false)
  })

  test('a range across a piece boundary returns the right bytes', async () => {
    const body = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251))
    assert.equal((await call('PUT', '/api/dav/multi.bin', { body })).status, 201)
    const res = await call('GET', '/api/dav/multi.bin', { headers: { Range: 'bytes=1000-2100' } })
    assert.equal(res.status, 206)
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), body.subarray(1000, 2101))
  })

  test('MOVE over an existing file replaces it in one step', async () => {
    await call('PUT', '/api/dav/a.txt', { body: 'A' })
    await call('PUT', '/api/dav/b.txt', { body: 'B' })
    assert.equal((await call('MOVE', '/api/dav/a.txt', { headers: { Destination: `${base}/api/dav/b.txt` } })).status, 204)
    assert.equal(await (await call('GET', '/api/dav/b.txt')).text(), 'A')
    assert.equal((await call('GET', '/api/dav/a.txt')).status, 404)
  })
})
