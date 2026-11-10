import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { request, type Server } from 'node:http'
import type { Readable } from 'node:stream'
import type { AddressInfo } from 'node:net'
import test, { after, before, beforeEach } from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { app } from '../../src/app.js'
import { prisma } from '../../src/config/prisma.js'
import { FRAME_PLAINTEXT, FRAME_SIZE, UPLOAD_CHUNK_PLAINTEXT } from '../../src/modules/crypto/frames.js'
import { compareReplicas } from '../../src/modules/files/decrypt-stream.js'
import { getBlob, memoryProvider, memoryTestHooks, resetMemoryProvider } from '../../src/modules/storage/memory-provider.js'
import { setTestProvider } from '../../src/modules/storage/provider.js'
import { hashToken } from '../../src/utils/crypto.js'
import { hashPassword } from '../../src/utils/password.js'

const P = FRAME_PLAINTEXT
const C = UPLOAD_CHUNK_PLAINTEXT
const run = randomUUID().slice(0, 8)
const PW = 'password-123'
let server: Server
let base = ''
const userIds: string[] = []
let accountIds: string[] = []
let owner = { id: '', token: '' }
let data: Buffer
let fileId = ''

async function seedUser(name: string) {
  const user = await prisma.user.create({ data: { name, email: `${name}-${run}@read.test`, passwordHash: await hashPassword(PW), role: 'member' } })
  userIds.push(user.id)
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password: PW }) })
  return { id: user.id, token: ((await res.json()) as { accessToken: string }).accessToken }
}

async function seedAccount(tag: string) {
  const account = await prisma.connectedAccount.create({ data: { userId: owner.id, provider: 's3', providerAccountId: `${tag}-${randomUUID()}`, email: `${tag}@read.test`, scopes: [] } })
  const free = 10n ** 12n
  await prisma.storageAccount.create({ data: { connectedAccountId: account.id, totalBytes: free, usedBytes: 0n, availableBytes: free, lastSyncedAt: new Date() } })
  accountIds.push(account.id)
  return account
}

const auth = () => ({ Authorization: `Bearer ${owner.token}` })

async function upload(bytes: Buffer, fileName = 'holiday-photo.jpg', mimeType = 'image/jpeg') {
  const init = await fetch(`${base}/uploads/resumable/init`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ fileName, mimeType, sizeBytes: String(bytes.length) }) })
  const started = (await init.json()) as { sessionId: string }
  assert.equal(init.status, 201)
  let last: any
  for (let start = 0; start < bytes.length || start === 0; start += C) {
    const end = Math.min(start + C, bytes.length)
    const res = await fetch(`${base}/uploads/resumable/chunk/${started.sessionId}`, {
      method: 'PUT',
      headers: { ...auth(), 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}` },
      body: new Uint8Array(bytes.subarray(start, end)),
    })
    last = await res.json()
    assert.ok(res.status === 200 || res.status === 201, JSON.stringify(last))
  }
  return last.file.id as string
}

async function replicasOf(id: string) {
  const replicas = (await prisma.fileReplica.findMany({ where: { fileId: id } })).sort(compareReplicas)
  return { primary: replicas[0]!, secondary: replicas[1]! }
}

function tamper(accountId: string, providerFileId: string, offset: number) {
  const blob = getBlob(accountId, providerFileId)!
  blob[offset] = blob[offset]! ^ 0xff
}

before(async () => {
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  await prisma.appSetting.upsert({ where: { id: 1 }, create: { id: 1, priorityAccountIds: [] }, update: {} })
  owner = await seedUser('reader')
  setTestProvider(memoryProvider)
})

beforeEach(async () => {
  await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  accountIds = []
  resetMemoryProvider()
  await prisma.appSetting.update({ where: { id: 1 }, data: { routingMode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 } })
  await seedAccount('a')
  await seedAccount('b')
  data = randomBytes(10 * P + 100)
  fileId = await upload(data)
})

after(async () => {
  setTestProvider(null)
  await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
  await new Promise((r) => server.close(r))
})

const get = (path: string, headers: Record<string, string> = {}, authed = true) => fetch(base + path, { headers: { ...(authed ? auth() : {}), ...headers } })

test('range seeks at frame and batch boundaries return exact bytes', async () => {
  const n = data.length
  const cases: [string, number, number][] = [
    ['bytes=0-0', 0, 0],
    ['bytes=0-9', 0, 9],
    [`bytes=${P - 1}-${P - 1}`, P - 1, P - 1],
    [`bytes=${P}-${P}`, P, P],
    [`bytes=${P - 1}-${P}`, P - 1, P],
    [`bytes=${P - 5}-${2 * P + 5}`, P - 5, 2 * P + 5],
    [`bytes=${8 * P - 1}-${8 * P + 1}`, 8 * P - 1, 8 * P + 1],
    [`bytes=${8 * P}-`, 8 * P, n - 1],
    [`bytes=${n - 1}-${n - 1}`, n - 1, n - 1],
    [`bytes=${10 * P}-${10 * P + 5000}`, 10 * P, n - 1],
    ['bytes=-50', n - 50, n - 1],
  ]
  for (const [header, a, b] of cases) {
    const res = await get(`/files/${fileId}/download`, { Range: header })
    assert.equal(res.status, 206, header)
    assert.equal(res.headers.get('content-range'), `bytes ${a}-${b}/${n}`, header)
    assert.equal(res.headers.get('content-length'), String(b - a + 1), header)
    assert.equal(res.headers.get('accept-ranges'), 'bytes')
    const body = Buffer.from(await res.arrayBuffer())
    assert.ok(body.equals(data.subarray(a, b + 1)), header)
  }
})

test('full download is 200 with real mime type and filename', async () => {
  const res = await get(`/files/${fileId}/download`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/jpeg')
  assert.equal(res.headers.get('content-length'), String(data.length))
  assert.equal(res.headers.get('accept-ranges'), 'bytes')
  assert.match(res.headers.get('content-disposition')!, /^attachment; filename="holiday-photo\.jpg"/)
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(data))
})

test('non-ASCII filenames do not break the header', async () => {
  const id = await upload(randomBytes(100), 'résumé 日本"\r\nX-Evil: 1.pdf', 'application/pdf')
  const res = await get(`/files/${id}/download`)
  assert.equal(res.status, 200)
  const cd = res.headers.get('content-disposition')!
  assert.match(cd, /^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/)
  assert.ok(!/[\r\n]/.test(cd))
  assert.ok(cd.includes('r%C3%A9sum%C3%A9'))
  assert.equal(res.headers.get('x-evil'), null)
  await res.arrayBuffer()
})

test('range past EOF is 416 with Content-Range */size', async () => {
  const res = await get(`/files/${fileId}/download`, { Range: `bytes=${data.length}-` })
  assert.equal(res.status, 416)
  assert.equal(res.headers.get('content-range'), `bytes */${data.length}`)
  assert.equal(((await res.json()) as any).code, 'RANGE_NOT_SATISFIABLE')
})

test('deleted first copy serves from the second and is marked lost', async () => {
  const { primary, secondary } = await replicasOf(fileId)
  await memoryProvider.deleteBlob({ id: primary.connectedAccountId } as any, primary.providerFileId)
  const res = await get(`/files/${fileId}/download`)
  assert.equal(res.status, 200)
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(data))
  assert.equal((await prisma.fileReplica.findUniqueOrThrow({ where: { id: primary.id } })).status, 'lost')
  assert.equal((await prisma.fileReplica.findUniqueOrThrow({ where: { id: secondary.id } })).status, 'healthy')
})

test('transient read failure falls back without marking lost', async () => {
  const { primary } = await replicasOf(fileId)
  memoryTestHooks.failReadRange.add(primary.connectedAccountId)
  const res = await get(`/files/${fileId}/download`)
  assert.equal(res.status, 200)
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(data))
  assert.equal((await prisma.fileReplica.findUniqueOrThrow({ where: { id: primary.id } })).status, 'healthy')
})

test('tampered first copy falls back to the second, at the first and a later frame', async () => {
  const { primary } = await replicasOf(fileId)
  tamper(primary.connectedAccountId, primary.providerFileId, 40)
  tamper(primary.connectedAccountId, primary.providerFileId, 9 * FRAME_SIZE + 40)
  const res = await get(`/files/${fileId}/download`)
  assert.equal(res.status, 200)
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(data))
  assert.equal((await prisma.fileReplica.findUniqueOrThrow({ where: { id: primary.id } })).status, 'healthy')
})

test('both copies tampered in the first frame gives 502 FILE_UNAVAILABLE', async () => {
  const { primary, secondary } = await replicasOf(fileId)
  tamper(primary.connectedAccountId, primary.providerFileId, 40)
  tamper(secondary.connectedAccountId, secondary.providerFileId, 40)
  const res = await get(`/files/${fileId}/download`)
  assert.equal(res.status, 502)
  assert.equal(((await res.json()) as any).code, 'FILE_UNAVAILABLE')
})

test('both copies tampered later aborts the connection without tampered plaintext', async () => {
  const { primary, secondary } = await replicasOf(fileId)
  tamper(primary.connectedAccountId, primary.providerFileId, 9 * FRAME_SIZE + 40)
  tamper(secondary.connectedAccountId, secondary.providerFileId, 9 * FRAME_SIZE + 40)
  const res = await get(`/files/${fileId}/download`)
  assert.equal(res.status, 200)
  const chunks: Buffer[] = []
  let failed = false
  try {
    const reader = res.body!.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
    }
  } catch {
    failed = true
  }
  const got = Buffer.concat(chunks)
  assert.ok(failed, 'connection must be aborted')
  assert.ok(got.length <= 9 * P, 'nothing from the tampered frame')
  assert.ok(got.equals(data.subarray(0, got.length)))
})

test('preview token streams; disabled owner and trashed file give 404', async () => {
  const token = randomUUID()
  await prisma.filePreviewToken.create({ data: { fileId, userId: owner.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60_000) } })
  const ok = await get(`/files/preview/${token}`, { Range: 'bytes=5-20' }, false)
  assert.equal(ok.status, 206)
  assert.match(ok.headers.get('content-disposition')!, /^inline/)
  assert.ok(Buffer.from(await ok.arrayBuffer()).equals(data.subarray(5, 21)))
  await prisma.user.update({ where: { id: owner.id }, data: { status: 'disabled' } })
  assert.equal((await get(`/files/preview/${token}`, {}, false)).status, 404)
  await prisma.user.update({ where: { id: owner.id }, data: { status: 'active' } })
  await prisma.file.update({ where: { id: fileId }, data: { status: 'deleted' } })
  assert.equal((await get(`/files/preview/${token}`, {}, false)).status, 404)
})

test('public link serves decrypted bytes; disabled owner and expired link give 404', async () => {
  const token = randomUUID()
  const share = await prisma.fileShare.create({ data: { fileId, userId: owner.id, token, tokenHash: hashToken(token), enabled: true } })
  const res = await get(`/public/files/${token}/download`, { Range: `bytes=${P - 3}-${P + 3}` }, false)
  assert.equal(res.status, 206)
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(data.subarray(P - 3, P + 4)))
  const full = await get(`/public/files/${token}/preview`, {}, false)
  assert.equal(full.status, 200)
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(data))
  assert.equal((await get(`/public/files/${token}`, {}, false)).status, 200)

  await prisma.user.update({ where: { id: owner.id }, data: { status: 'disabled' } })
  for (const p of ['', '/download', '/preview']) assert.equal((await get(`/public/files/${token}${p}`, {}, false)).status, 404, p)
  await prisma.user.update({ where: { id: owner.id }, data: { status: 'active' } })

  await prisma.fileShare.update({ where: { id: share.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
  for (const p of ['', '/download', '/preview']) assert.equal((await get(`/public/files/${token}${p}`, {}, false)).status, 404, p)
})

function unzip(zip: Buffer) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10)
    const compSize = zip.readUInt32LE(p + 20)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const local = zip.readUInt32LE(p + 42)
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString()
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(start, start + compSize)
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw))
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

test('batch zip entries decrypt and an unreadable file is skipped', async () => {
  const small = randomBytes(5000)
  const id2 = await upload(small, 'notes.txt', 'text/plain')
  const id3 = await upload(randomBytes(300), 'gone.bin', 'application/octet-stream')
  for (const r of await prisma.fileReplica.findMany({ where: { fileId: id3 } })) await memoryProvider.deleteBlob({ id: r.connectedAccountId } as any, r.providerFileId)
  const res = await fetch(`${base}/files/batch-download`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ fileIds: [fileId, id2, id3] }) })
  assert.equal(res.status, 200)
  const entries = unzip(Buffer.from(await res.arrayBuffer()))
  assert.deepEqual([...entries.keys()].sort(), ['holiday-photo.jpg', 'notes.txt'])
  assert.ok(entries.get('holiday-photo.jpg')!.equals(data))
  assert.ok(entries.get('notes.txt')!.equals(small))
})

test('zip aborts instead of hanging when a later frame is corrupt on both copies', async () => {
  const { primary, secondary } = await replicasOf(fileId)
  tamper(primary.connectedAccountId, primary.providerFileId, 9 * FRAME_SIZE + 40)
  tamper(secondary.connectedAccountId, secondary.providerFileId, 9 * FRAME_SIZE + 40)
  const res = await fetch(`${base}/files/batch-download`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ fileIds: [fileId] }), signal: AbortSignal.timeout(15000) })
  assert.equal(res.status, 200)
  await assert.rejects(res.arrayBuffer())
})

test('zip client disconnect stops reading from the provider', async () => {
  const big = randomBytes(80 * P)
  const bigId = await upload(big, 'big.bin', 'application/octet-stream')
  let reads = 0
  const streams: Readable[] = []
  setTestProvider({
    ...memoryProvider,
    readRange: async (a, id, st, en) => {
      reads++
      const r = await memoryProvider.readRange(a, id, st, en)
      streams.push(r)
      return r
    },
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const req = request(`${base}/files/batch-download`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' } }, (res) => {
        res.once('data', () => {
          req.destroy()
          resolve()
        })
        res.on('error', () => undefined)
      })
      req.on('error', (e) => (/aborted|hang up|ECONNRESET/i.test(String(e)) ? undefined : reject(e)))
      req.end(JSON.stringify({ fileIds: [bigId] }))
    })
    await new Promise((r) => setTimeout(r, 500))
    const settled = reads
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(reads, settled, 'no further provider reads after disconnect')
    assert.ok(reads < 10, `read ${reads} of 10 batches`)
    assert.ok(streams.every((s) => s.destroyed), 'provider streams destroyed')
  } finally {
    setTestProvider(memoryProvider)
  }
})

test('zip client disconnect while the next file is opening destroys that stream', async () => {
  const id2 = await upload(randomBytes(3000), 'second.bin', 'application/octet-stream')
  let reads = 0
  const streams: Readable[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let blocked!: () => void
  const isBlocked = new Promise<void>((r) => (blocked = r))
  setTestProvider({
    ...memoryProvider,
    readRange: async (a, id, st, en) => {
      reads++
      if (reads === 2) {
        blocked()
        await gate
      }
      const r = await memoryProvider.readRange(a, id, st, en)
      streams.push(r)
      return r
    },
  })
  try {
    const req = request(`${base}/files/batch-download`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' } }, (res) => res.on('error', () => undefined).resume())
    req.on('error', () => undefined)
    req.end(JSON.stringify({ fileIds: [fileId, id2] }))
    await isBlocked
    req.destroy()
    await new Promise((r) => setTimeout(r, 300))
    release()
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(reads, 2)
    assert.ok(streams.length >= 2 && streams.every((s) => s.destroyed), 'every provider stream destroyed')
  } finally {
    release()
    setTestProvider(memoryProvider)
  }
})

async function previewToken(id: string) {
  const token = randomUUID()
  await prisma.filePreviewToken.create({ data: { fileId: id, userId: owner.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60_000) } })
  return token
}

async function shareToken(id: string) {
  const token = randomUUID()
  await prisma.fileShare.create({ data: { fileId: id, userId: owner.id, token, tokenHash: hashToken(token), enabled: true } })
  return token
}

/** Every way a file's bytes leave the server: owner download, preview token, public download, public preview. */
async function servedResponses(id: string) {
  const preview = await previewToken(id)
  const share = await shareToken(id)
  const out: [string, Response][] = []
  for (const [label, path, authed] of [
    ['download', `/files/${id}/download`, true],
    ['preview-token', `/files/preview/${preview}`, false],
    ['public-download', `/public/files/${share}/download`, false],
    ['public-preview', `/public/files/${share}/preview`, false],
  ] as const) out.push([label, await get(path, {}, authed)])
  return out
}

function assertHardened(res: Response, label: string) {
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', label)
  assert.equal(res.headers.get('content-security-policy'), "sandbox; default-src 'none'", label)
}

test('html and svg are served as attachment octet-stream with nosniff and a sandbox CSP', async () => {
  for (const [name, mime] of [['page.html', 'text/html'], ['drawing.svg', 'image/svg+xml']] as const) {
    const bytes = Buffer.from(mime === 'text/html' ? '<script>alert(1)</script>' : '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
    const id = await upload(bytes, name, mime)
    for (const [label, res] of await servedResponses(id)) {
      assert.equal(res.status, 200, `${mime} ${label}`)
      assert.equal(res.headers.get('content-type'), 'application/octet-stream', `${mime} ${label}`)
      assert.match(res.headers.get('content-disposition')!, /^attachment;/, `${mime} ${label}`)
      assertHardened(res, `${mime} ${label}`)
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes))
    }
  }
})

test('png previews inline with its type, downloads as attachment, both hardened', async () => {
  const bytes = randomBytes(500)
  const id = await upload(bytes, 'pic.png', 'image/png')
  for (const [label, res] of await servedResponses(id)) {
    assert.equal(res.status, 200, label)
    assert.equal(res.headers.get('content-type'), 'image/png', label)
    assert.match(res.headers.get('content-disposition')!, label.includes('download') ? /^attachment;/ : /^inline;/, label)
    assertHardened(res, label)
    await res.arrayBuffer()
  }
})

test('invalid characters in mimeType fall back to octet-stream instead of a 500', async () => {
  const bytes = randomBytes(300)
  const id = await upload(bytes, 'evil.png', 'image/png\r\nX-Evil: 1')
  assert.equal((await prisma.file.findUniqueOrThrow({ where: { id } })).mimeType, 'application/octet-stream')
  // A row stored before validation existed must not break the response either.
  await prisma.file.update({ where: { id }, data: { mimeType: 'image/png\u0001' } })
  for (const [label, res] of await servedResponses(id)) {
    assert.equal(res.status, 200, label)
    assert.equal(res.headers.get('content-type'), 'application/octet-stream', label)
    assert.equal(res.headers.get('x-evil'), null, label)
    assertHardened(res, label)
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes))
  }
})

test('zip download carries nosniff and the sandbox CSP', async () => {
  const res = await fetch(`${base}/files/batch-download`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ fileIds: [fileId] }) })
  assert.equal(res.status, 200)
  assertHardened(res, 'zip')
  await res.arrayBuffer()
})
