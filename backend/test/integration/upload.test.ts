import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test, { after, before, beforeEach } from 'node:test'
import { fileURLToPath } from 'node:url'
import { app } from '../../src/app.js'
import { prisma } from '../../src/config/prisma.js'
import { openFileKey } from '../../src/modules/crypto/file-keys.js'
import { decryptFrame, encryptedSize, frameCount, FRAME_SIZE, UPLOAD_CHUNK_PLAINTEXT } from '../../src/modules/crypto/frames.js'
import { failUpload, resetUploadTracking } from '../../src/modules/uploads/encrypted-upload.js'
import { getBlob, memoryProvider, memoryTestHooks, resetMemoryProvider } from '../../src/modules/storage/memory-provider.js'
import { reservedByAccount } from '../../src/modules/storage/pool.js'
import { ProviderQuotaError, ProviderUnavailableError, setTestProvider, type ReplicaUploadState, type StorageProvider } from '../../src/modules/storage/provider.js'
import { hashToken } from '../../src/utils/crypto.js'
import { hashPassword } from '../../src/utils/password.js'

const C = UPLOAD_CHUNK_PLAINTEXT
const run = randomUUID().slice(0, 8)
const PW = 'password-123'
let server: Server
let base = ''
const userIds: string[] = []
let accountIds: string[] = []
let owner = { id: '', token: '' }
let other = { id: '', token: '' }

type Calls = { begin: { accountId: string; args: unknown[] }[]; abort: string[]; committed: string[]; log: string[] }
let calls: Calls
let overrides: Partial<StorageProvider> = {}

const spy: StorageProvider = {
  beginUpload: (a, name, size, ...rest: unknown[]) => {
    calls.begin.push({ accountId: a.id, args: [name, size, ...rest] })
    calls.log.push(`begin:${a.id}`)
    return (overrides.beginUpload ?? memoryProvider.beginUpload)(a, name, size)
  },
  putChunk: (a, s, o, c, t) => (overrides.putChunk ?? memoryProvider.putChunk)(a, s, o, c, t),
  committedOffset: (a, s, t) => {
    calls.committed.push(a.id)
    return (overrides.committedOffset ?? memoryProvider.committedOffset)(a, s, t)
  },
  abortUpload: (a, s) => {
    calls.abort.push(a.id)
    return memoryProvider.abortUpload(a, s)
  },
  readRange: memoryProvider.readRange,
  deleteBlob: memoryProvider.deleteBlob,
}

async function seedUser(name: string, extra: Record<string, unknown> = {}) {
  const user = await prisma.user.create({ data: { name, email: `${name}-${run}@test.local`, passwordHash: await hashPassword(PW), role: 'member', ...extra } })
  userIds.push(user.id)
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password: PW }) })
  const json = (await res.json()) as { accessToken: string }
  return { id: user.id, token: json.accessToken }
}

async function seedAccount(tag: string, free = 10n ** 12n) {
  const account = await prisma.connectedAccount.create({
    data: { userId: owner.id, provider: 's3', providerAccountId: `${tag}-${randomUUID()}`, email: `${tag}@upload.test`, scopes: [] },
  })
  await prisma.storageAccount.create({ data: { connectedAccountId: account.id, totalBytes: free, usedBytes: 0n, availableBytes: free, lastSyncedAt: new Date() } })
  accountIds.push(account.id)
  return account
}

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

async function init(size: number | string, extra: Record<string, unknown> = {}, token = owner.token) {
  return api('POST', '/uploads/resumable/init', token, { fileName: 'holiday-photo.jpg', mimeType: 'image/jpeg', sizeBytes: String(size), ...extra })
}

async function rawPut(sessionId: string, range: string, body: BodyInit, token = owner.token) {
  const res = await fetch(`${base}/uploads/resumable/chunk/${sessionId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Content-Range': range },
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit)
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

function put(sessionId: string, data: Buffer, start: number, token = owner.token) {
  return rawPut(sessionId, `bytes ${start}-${start + (Math.min(start + C, data.length) - start) - 1}/${data.length}`, new Uint8Array(data.subarray(start, Math.min(start + C, data.length))), token)
}

const status = (sessionId: string, token = owner.token) => api('GET', `/uploads/resumable/status/${sessionId}`, token)

async function uploadWhole(data: Buffer) {
  const started = await init(data.length)
  assert.equal(started.status, 201, started.text)
  const sessionId = started.json.sessionId as string
  let last = started
  for (let start = 0; start < data.length; start += C) {
    last = await put(sessionId, data, start)
    assert.ok(last.status === 200 || last.status === 201, last.text)
  }
  return { sessionId, last }
}

async function assertStored(fileId: string, userId: string, data: Buffer) {
  const file = await prisma.file.findUniqueOrThrow({ where: { id: fileId }, omit: { wrappedFileKey: false, encryptedSizeBytes: false }, include: { replicas: true } })
  const expected = encryptedSize(BigInt(data.length))
  assert.equal(file.replicas.length, 2)
  assert.notEqual(file.replicas[0]!.connectedAccountId, file.replicas[1]!.connectedAccountId)
  assert.equal(file.encryptedSizeBytes, expected)
  assert.equal(file.sizeBytes, BigInt(data.length))
  assert.ok(file.wrappedFileKey)
  assert.ok(file.replicas.some((r) => r.connectedAccountId === file.connectedAccountId && r.providerFileId === file.providerFileId), 'File row points at one of its copies')
  const blobs = file.replicas.map((r) => {
    assert.equal(r.sizeBytes, expected)
    assert.equal(r.status, 'healthy')
    const blob = getBlob(r.connectedAccountId, r.providerFileId)
    assert.ok(blob, 'blob stored')
    return blob
  })
  assert.ok(blobs[0]!.equals(blobs[1]!), 'copies are byte-identical')
  assert.equal(BigInt(blobs[0]!.length), expected)
  const key = openFileKey(userId, file.wrappedFileKey)
  const frames = Number(frameCount(BigInt(data.length)))
  const parts: Buffer[] = []
  for (let i = 0; i < frames; i++) {
    parts.push(decryptFrame(key, fileId, i, i === frames - 1, blobs[0]!.subarray(i * FRAME_SIZE, Math.min((i + 1) * FRAME_SIZE, blobs[0]!.length))))
  }
  assert.ok(Buffer.concat(parts).equals(data), 'decrypts to the original')
  const sample = data.subarray(Math.min(100, data.length - 1), Math.min(164, data.length))
  for (const blob of blobs) assert.equal(blob.indexOf(sample), -1, 'plaintext absent')
  return file
}

async function sessionOf(id: string) {
  return prisma.uploadSession.findUniqueOrThrow({ where: { id }, include: { replicas: true } })
}

function multipart(parts: Array<[string, string] | [string, Buffer, string]>) {
  const fd = new FormData()
  for (const p of parts) {
    if (p.length === 2) fd.append(p[0], p[1])
    else fd.append(p[0], new Blob([new Uint8Array(p[1])], { type: 'image/png' }), p[2])
  }
  return fd
}

async function postMultipart(path: string, fd: FormData, token = owner.token) {
  const res = await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

before(async () => {
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  await prisma.appSetting.upsert({ where: { id: 1 }, create: { id: 1, priorityAccountIds: [] }, update: {} })
  owner = await seedUser('owner')
  other = await seedUser('other')
  setTestProvider(spy)
})

let accounts: Awaited<ReturnType<typeof seedAccount>>[] = []

beforeEach(async () => {
  await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.uploadSession.deleteMany({ where: { userId: { in: userIds } } })
  accountIds = []
  resetMemoryProvider()
  resetUploadTracking()
  calls = { begin: [], abort: [], committed: [], log: [] }
  overrides = {}
  await prisma.appSetting.update({ where: { id: 1 }, data: { routingMode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 } })
  accounts = [await seedAccount('a'), await seedAccount('b')]
})

after(async () => {
  setTestProvider(null)
  await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
  await new Promise((r) => server.close(r))
})

test('resumable upload encrypts two identical copies under random blob names', async () => {
  const data = randomBytes(2 * C + 17)
  const started = await init(data.length)
  assert.equal(started.status, 201, started.text)
  assert.deepEqual(Object.keys(started.json).sort(), ['chunkSize', 'offset', 'provider', 'sessionId'])
  assert.equal(started.json.provider, 'encrypted')
  assert.equal(started.json.offset, 0)
  assert.equal(started.json.chunkSize, String(C))
  const sessionId = started.json.sessionId as string

  const first = await put(sessionId, data, 0)
  assert.equal(first.status, 200, first.text)
  assert.deepEqual(first.json, { status: 'uploading', offset: String(C) })
  assert.deepEqual((await status(sessionId)).json, { status: 'uploading', offset: String(C) })
  await put(sessionId, data, C)
  const last = await put(sessionId, data, 2 * C)
  assert.equal(last.status, 201, last.text)
  assert.equal(last.json.status, 'completed')
  assert.equal(last.json.file.sizeBytes, String(data.length))
  assert.equal(last.json.file.name, 'holiday-photo.jpg')
  assert.equal(last.json.file.mimeType, 'image/jpeg')
  assert.deepEqual((await status(sessionId)).json, { status: 'completed', offset: String(data.length) })

  const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId }, omit: { wrappedFileKey: false } })
  assert.equal(session.status, 'completed')
  assert.ok(session.completedAt)
  assert.equal(last.json.file.id, session.fileId)
  const file = await assertStored(session.fileId!, owner.id, data)
  assert.equal(file.wrappedFileKey, session.wrappedFileKey)
  assert.equal(new Set(file.replicas.map((r) => r.connectedAccountId)).size, 2)

  assert.equal(calls.begin.length, 2)
  assert.notEqual(calls.begin[0]!.accountId, calls.begin[1]!.accountId)
  for (const b of calls.begin) {
    assert.match(String(b.args[0]), /^[0-9a-f]{32}\.bin$/)
    assert.equal(b.args[1], encryptedSize(BigInt(data.length)))
    // The provider interface carries no name or MIME beyond the blob name; adapters send application/octet-stream.
    assert.equal(b.args.length, 2)
    assert.doesNotMatch(JSON.stringify(b.args.map(String)), /holiday-photo|image\/jpeg/)
  }

  const audit = await prisma.auditLog.findFirst({ where: { userId: owner.id, action: 'UPLOAD_FILE', entityId: session.fileId! } })
  assert.ok(audit, 'audit log written')
  assert.equal((await reservedByAccount()).get(file.replicas[0]!.connectedAccountId) ?? 0n, 0n)
})

test('normal path makes no committedOffset round trips; state unknown asks exactly once', async () => {
  const data = randomBytes(2 * C + 17)
  const started = await init(data.length)
  const id = started.json.sessionId as string
  await put(id, data, 0)
  assert.equal(calls.committed.length, 0)
  resetUploadTracking() // what a restart does
  await put(id, data, C)
  assert.equal(calls.committed.length, 2)
  await put(id, data, 2 * C)
  assert.equal(calls.committed.length, 2)
  const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id } })
  await assertStored(session.fileId!, owner.id, data)
})

test('per-chunk state is persisted to the replica rows with the session URI encrypted', async () => {
  const data = randomBytes(C + 5)
  const started = await init(data.length)
  const id = started.json.sessionId as string
  const replicas = (await sessionOf(id)).replicas
  for (const r of replicas) {
    assert.ok(r.providerFileId, 'state stored at init')
    assert.ok(r.sessionUriEncrypted)
    assert.ok(!r.sessionUriEncrypted!.includes('memory://'), 'session URI encrypted at rest')
  }
  for (const text of [started.text, (await status(id)).text]) assert.doesNotMatch(text, /sessionUri|wrappedFileKey|memory:\/\//)
})

test('chunk retry after one copy fails resumes from the lower offset and stays identical', async () => {
  const data = randomBytes(2 * C + 17)
  const started = await init(data.length)
  const id = started.json.sessionId as string
  await put(id, data, 0)
  const bId = calls.begin[1]!.accountId
  memoryTestHooks.failPutChunk.add(bId)
  const failed = await put(id, data, C)
  assert.equal(failed.status, 502)
  assert.equal(failed.json.code, 'UPLOAD_CHUNK_RETRY')
  assert.equal((await sessionOf(id)).status, 'uploading')
  memoryTestHooks.failPutChunk.clear()
  const st = await status(id)
  assert.deepEqual(st.json, { status: 'uploading', offset: String(C) })
  for (let offset = Number(st.json.offset); offset < data.length; offset += C) {
    const r = await put(id, data, offset)
    assert.ok(r.status < 300, r.text)
  }
  const session = await sessionOf(id)
  assert.equal(session.status, 'completed')
  await assertStored(session.fileId!, owner.id, data)
})

test('partial commit inside a chunk is trimmed on resume', async () => {
  const data = randomBytes(C + 40)
  const started = await init(data.length)
  const id = started.json.sessionId as string
  memoryTestHooks.partialCommit = 300_000n
  assert.equal((await put(id, data, 0)).status, 502)
  assert.deepEqual((await status(id)).json, { status: 'uploading', offset: '0' })
  assert.equal((await put(id, data, 0)).status, 200)
  assert.equal((await put(id, data, C)).status, 201)
  await assertStored((await sessionOf(id)).fileId!, owner.id, data)
})

test('a chunk ahead of the committed offset is refused without writing', async () => {
  const data = randomBytes(2 * C + 17)
  const started = await init(data.length)
  const id = started.json.sessionId as string
  const r = await put(id, data, C)
  assert.equal(r.status, 409)
  assert.equal(r.json.code, 'CHUNK_OUT_OF_ORDER')
  assert.equal((await sessionOf(id)).status, 'uploading')
  assert.deepEqual((await status(id)).json, { status: 'uploading', offset: '0' })
})

test('re-sending a committed chunk is a no-op and the final chunk is idempotent', async () => {
  const data = randomBytes(C + 40)
  const started = await init(data.length)
  const id = started.json.sessionId as string
  assert.equal((await put(id, data, 0)).status, 200)
  assert.equal((await put(id, data, 0)).status, 200)
  const [a, b] = await Promise.all([put(id, data, C), put(id, data, C)])
  assert.equal(a.status, 201, a.text)
  assert.equal(b.status, 201, b.text)
  assert.equal(a.json.file.id, b.json.file.id)
  const session = await sessionOf(id)
  assert.equal(await prisma.file.count({ where: { id: session.fileId! } }), 1)
  await assertStored(session.fileId!, owner.id, data)
  const again = await put(id, data, C)
  assert.equal(again.status, 201)
  assert.equal(again.json.file.id, session.fileId)
})

test('copy finished on the provider but response lost: providerFileId comes from committedOffset (Google shape)', async () => {
  const ids = new Map<string, string>()
  const inner = (s: ReplicaUploadState) => ({ ...s, providerFileId: ids.get(s.sessionUri!)! })
  let dropFinalResponseFor: string | null = null
  overrides = {
    beginUpload: async (a, n, s) => {
      const st = await memoryProvider.beginUpload(a, n, s)
      ids.set(st.sessionUri!, st.providerFileId!)
      return { sessionUri: st.sessionUri }
    },
    putChunk: async (a, s, o, c, t) => {
      const r = await memoryProvider.putChunk(a, inner(s), o, c, t)
      if (r.complete && a.id === dropFinalResponseFor) throw new Error('socket hang up')
      return r.complete ? r : { ...r, state: { sessionUri: s.sessionUri } }
    },
    committedOffset: async (a, s, t) => {
      const n = await memoryProvider.committedOffset(a, inner(s), t)
      if (n === t) s.providerFileId = ids.get(s.sessionUri!)
      return n
    },
    abortUpload: async () => undefined,
  }
  const data = randomBytes(1000)
  const started = await init(data.length)
  const id = started.json.sessionId as string
  dropFinalResponseFor = calls.begin[0]!.accountId
  const first = await put(id, data, 0)
  assert.equal(first.status, 502, first.text)
  assert.equal(await prisma.file.count({ where: { userId: owner.id, name: 'holiday-photo.jpg', id: (await sessionOf(id)).fileId! } }), 0)
  dropFinalResponseFor = null
  assert.deepEqual((await status(id)).json, { status: 'uploading', offset: '0' })
  const retry = await put(id, data, 0)
  assert.equal(retry.status, 201, retry.text)
  const session = await sessionOf(id)
  const file = await assertStored(session.fileId!, owner.id, data)
  for (const r of file.replicas) assert.ok(ids.has(`memory://${r.providerFileId}`))
})

test('a complete copy with no providerFileId fails the upload instead of creating a File', async () => {
  overrides = {
    beginUpload: async (a, n, s) => {
      const st = await memoryProvider.beginUpload(a, n, s)
      return a.id === calls.begin[0]!.accountId ? { sessionUri: st.sessionUri } : st
    },
    putChunk: async (a, s, o, c, t) => {
      if (s.providerFileId) return memoryProvider.putChunk(a, s, o, c, t)
      return { state: s, complete: true }
    },
  }
  const data = randomBytes(1000)
  const started = await init(data.length)
  const r = await put(started.json.sessionId, data, 0)
  assert.equal(r.status, 502)
  assert.equal(r.json.code, 'STORAGE_ACCOUNT_UNAVAILABLE')
  const session = await sessionOf(started.json.sessionId)
  assert.equal(session.status, 'failed')
  assert.equal(await prisma.file.count({ where: { id: session.fileId! } }), 0)
})

test('Content-Range validation gives CHUNK_NOT_ALIGNED', async () => {
  const size = 2 * C + 17
  const started = await init(size)
  const id = started.json.sessionId as string
  const body = (n: number) => new Uint8Array(n)
  const cases: Array<[string, number]> = [
    [`bytes 1-${C}/${size}`, C], // start not a multiple
    [`bytes 0-${C - 2}/${size}`, C - 1], // short non-final chunk
    [`bytes ${2 * C}-${2 * C + 15}/${size}`, 16], // final chunk not ending at size-1
    [`bytes 0-${C - 1}/${size + 1}`, C], // total differs
    [`bytes ${3 * C}-${3 * C}/${size}`, 1], // beyond the file
  ]
  for (const [range, n] of cases) {
    const r = await rawPut(id, range, body(n))
    assert.equal(r.status, 400, range)
    assert.equal(r.json.code, 'CHUNK_NOT_ALIGNED', range)
  }
  assert.equal((await rawPut(id, 'bytes 0-1', body(2))).status, 400)
  assert.equal((await sessionOf(id)).status, 'uploading')
  assert.equal(memoryTestHooks.failPutChunk.size, 0)
})

test('an exact multiple of the chunk size ends on its last chunk', async () => {
  const data = randomBytes(C)
  const { sessionId, last } = await uploadWhole(data)
  assert.equal(last.status, 201)
  await assertStored((await sessionOf(sessionId)).fileId!, owner.id, data)
})

test('a crash between both copies finishing and the File row reports the last chunk, not completion', async () => {
  const data = randomBytes(C)
  const started = await init(data.length)
  const id = started.json.sessionId as string
  const realCreate = prisma.file.create
  ;(prisma.file as any).create = () => { throw new Error('db down') }
  const failed = await put(id, data, 0).finally(() => { (prisma.file as any).create = realCreate })
  assert.ok(failed.status >= 500, failed.text)
  assert.equal(await prisma.file.count({ where: { id: (await sessionOf(id)).fileId! } }), 0)
  assert.deepEqual((await status(id)).json, { status: 'uploading', offset: '0' })
  assert.equal((await put(id, data, 0)).status, 201)
  await assertStored((await sessionOf(id)).fileId!, owner.id, data)
})

test('body bounds: oversized bodies get CHUNK_TOO_LARGE, short bodies CHUNK_LENGTH_MISMATCH', async () => {
  const size = 2 * C + 17
  const started = await init(size)
  const id = started.json.sessionId as string
  const tooBig = await rawPut(id, `bytes 0-${C - 1}/${size}`, new Uint8Array(C + 1))
  assert.equal(tooBig.status, 413)
  assert.equal(tooBig.json.code, 'CHUNK_TOO_LARGE')

  const stream = (n: number) => Readable.toWeb(Readable.from([Buffer.alloc(n)])) as unknown as ReadableStream
  const chunkedBig = await rawPut(id, `bytes 0-${C - 1}/${size}`, stream(C + 5))
  assert.equal(chunkedBig.status, 413)
  assert.equal(chunkedBig.json.code, 'CHUNK_TOO_LARGE')

  const short = await rawPut(id, `bytes 0-${C - 1}/${size}`, new Uint8Array(C - 3))
  assert.equal(short.status, 400)
  assert.equal(short.json.code, 'CHUNK_LENGTH_MISMATCH')
  assert.deepEqual((await status(id)).json, { status: 'uploading', offset: '0' })
})

test('one copy failing permanently: no File, both aborted, failed, reservation released', async () => {
  const data = randomBytes(C + 17)
  const started = await init(data.length)
  const id = started.json.sessionId as string
  const victim = calls.begin[1]!.accountId
  overrides = {
    putChunk: async (a, s, o, c, t) => {
      if (a.id === victim) throw new ProviderUnavailableError('gone', false)
      return memoryProvider.putChunk(a, s, o, c, t)
    },
  }
  const r = await put(id, data, 0)
  assert.equal(r.status, 502)
  assert.equal(r.json.code, 'STORAGE_ACCOUNT_UNAVAILABLE')
  const session = await sessionOf(id)
  assert.equal(session.status, 'failed')
  assert.equal(await prisma.file.count({ where: { id: session.fileId! } }), 0)
  assert.equal(new Set(calls.abort).size, 2)
  assert.deepEqual((await status(id)).json, { status: 'failed', offset: '0' })
  const reserved = await reservedByAccount()
  for (const account of accounts) assert.equal(reserved.get(account.id) ?? 0n, 0n)
  const next = await put(id, data, 0)
  assert.equal(next.status, 409)
  assert.equal(next.json.code, 'UPLOAD_NOT_ACTIVE')
})

test('permanent failure on the final chunk deletes a copy that already finished', async () => {
  const data = randomBytes(1000)
  const started = await init(data.length)
  const id = started.json.sessionId as string
  const victim = calls.begin[1]!.accountId
  const survivor = calls.begin[0]!.accountId
  overrides = {
    putChunk: async (a, s, o, c, t) => {
      if (a.id === victim) throw new ProviderUnavailableError('gone', false)
      return memoryProvider.putChunk(a, s, o, c, t)
    },
  }
  const r = await put(id, data, 0)
  assert.equal(r.status, 502)
  const replica = (await sessionOf(id)).replicas.find((x) => x.connectedAccountId === survivor)!
  assert.equal(getBlob(survivor, replica.providerFileId!), undefined)
  assert.equal((await sessionOf(id)).status, 'failed')
})

test('ProviderQuotaError pauses that account for 24 hours and fails the upload', async () => {
  const data = randomBytes(1000)
  const started = await init(data.length)
  const id = started.json.sessionId as string
  const victim = calls.begin[0]!.accountId
  overrides = {
    putChunk: async (a, s, o, c, t) => {
      if (a.id === victim) throw new ProviderQuotaError('quota')
      return memoryProvider.putChunk(a, s, o, c, t)
    },
  }
  const before = Date.now()
  const r = await put(id, data, 0)
  assert.equal(r.status, 507)
  assert.equal(r.json.code, 'STORAGE_ACCOUNT_QUOTA_EXCEEDED')
  const paused = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: victim } })
  const until = paused.pausedUntil!.getTime()
  assert.ok(Math.abs(until - (before + 24 * 3600_000)) < 60_000, 'now + 24h')
  const healthy = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: calls.begin[1]!.accountId } })
  assert.equal(healthy.pausedUntil, null)
  assert.equal((await sessionOf(id)).status, 'failed')
})

test('beginUpload failing on one copy aborts the other and fails the session', async () => {
  let n = 0
  overrides = {
    beginUpload: async (a, name, size) => {
      if (++n === 2) throw new ProviderUnavailableError('no', false)
      return memoryProvider.beginUpload(a, name, size)
    },
  }
  const r = await init(1000)
  assert.equal(r.status, 502)
  assert.equal(r.json.code, 'STORAGE_ACCOUNT_UNAVAILABLE')
  const sessions = await prisma.uploadSession.findMany({ where: { userId: owner.id, status: 'failed' } })
  assert.equal(sessions.length, 1)
  assert.equal(calls.abort.length, 1)
})

test('beginUpload quota error pauses the account with 507', async () => {
  overrides = { beginUpload: async () => { throw new ProviderQuotaError('quota') } }
  const r = await init(1000)
  assert.equal(r.status, 507)
  assert.equal(r.json.code, 'STORAGE_ACCOUNT_QUOTA_EXCEEDED')
  for (const b of calls.begin) assert.ok((await prisma.connectedAccount.findUniqueOrThrow({ where: { id: b.accountId } })).pausedUntil)
})

test('init rejects bad sizes, limits and folders', async () => {
  const zero = await init(0)
  assert.equal(zero.status, 400)
  assert.equal(zero.json.code, 'UPLOAD_SIZE_REQUIRED')
  const huge = await init(String(10n ** 15n))
  assert.equal(huge.status, 400)
  assert.equal(huge.json.code, 'UPLOAD_TOO_LARGE')
  const junk = await init('abc')
  assert.equal(junk.status, 400)

  const limited = await seedUser(`lim${randomUUID().slice(0, 4)}`, { storageLimitBytes: 500n })
  const over = await init(1000, {}, limited.token)
  assert.equal(over.status, 413)
  assert.equal(over.json.code, 'USER_STORAGE_LIMIT_REACHED')

  const stranger = await prisma.folder.create({ data: { userId: other.id, name: 'theirs' } })
  const notMine = await init(1000, { folderId: stranger.id })
  assert.equal(notMine.status, 404)
  assert.equal(notMine.json.code, 'FOLDER_NOT_FOUND')
  const trashed = await prisma.folder.create({ data: { userId: owner.id, name: 'trash', deletedAt: new Date() } })
  assert.equal((await init(1000, { folderId: trashed.id })).status, 404)
  assert.equal(calls.begin.length, 0)

  await prisma.connectedAccount.delete({ where: { id: accounts[1]!.id } })
  const single = await init(1000)
  assert.equal(single.status, 507)
  assert.equal(single.json.code, 'NO_ACCOUNT_WITH_ENOUGH_SPACE')
})

test('targetAccountId and Folder.connectedAccountId are ignored; a valid folderId is kept', async () => {
  const third = await seedAccount('c', 10n)
  const folder = await prisma.folder.create({ data: { userId: owner.id, name: 'mine', connectedAccountId: third.id } })
  const data = randomBytes(500)
  const started = await init(data.length, { folderId: folder.id, targetAccountId: third.id })
  assert.equal(started.status, 201, started.text)
  assert.ok(calls.begin.every((b) => b.accountId !== third.id))
  const done = await put(started.json.sessionId, data, 0)
  assert.equal(done.status, 201)
  assert.equal(done.json.file.folderId, folder.id)
})

test('sessions belong to their user', async () => {
  const data = randomBytes(1000)
  const started = await init(data.length)
  const id = started.json.sessionId as string
  const st = await status(id, other.token)
  assert.equal(st.status, 404)
  assert.equal(st.json.code, 'UPLOAD_SESSION_NOT_FOUND')
  const p = await put(id, data, 0, other.token)
  assert.equal(p.status, 404)
  assert.equal((await sessionOf(id)).status, 'uploading')
})

test('GET /files exposes neither wrapped keys nor encrypted size', async () => {
  const data = randomBytes(1000)
  const { last } = await uploadWhole(data)
  assert.doesNotMatch(last.text, /wrappedFileKey|encryptedSizeBytes/)
  const list = await api('GET', '/files', owner.token)
  assert.equal(list.status, 200, list.text)
  assert.equal(list.json.files.length >= 1, true)
  assert.doesNotMatch(list.text, /wrappedFileKey|encryptedSizeBytes|sessionUri/)
})

test('failUpload never touches a completed upload', async () => {
  const data = randomBytes(1000)
  const { sessionId } = await uploadWhole(data)
  await failUpload(sessionId, 'too late')
  const session = await sessionOf(sessionId)
  assert.equal(session.status, 'completed')
  assert.equal(calls.abort.length, 0)
  await assertStored(session.fileId!, owner.id, data)
})

test('multipart POST /uploads stores 20 MB correctly', async () => {
  const data = randomBytes(20 * 1024 * 1024)
  const r = await postMultipart('/uploads', multipart([['sizeBytes', String(data.length)], ['fileName', 'video.mov'], ['mimeType', 'video/quicktime'], ['file', data, 'ignored.bin']]))
  assert.equal(r.status, 201, r.text)
  assert.equal(r.json.file.name, 'video.mov')
  assert.equal(r.json.file.mimeType, 'video/quicktime')
  assert.equal(r.json.file.sizeBytes, String(data.length))
  assert.doesNotMatch(r.text, /wrappedFileKey|encryptedSizeBytes/)
  await assertStored(r.json.file.id, owner.id, data)
  assert.ok(calls.begin.every((b) => /^[0-9a-f]{32}\.bin$/.test(String(b.args[0]))))
})

test('POST /api/v1/uploads uses the same pipeline', async () => {
  const raw = `k-${run}-${randomUUID()}`
  await prisma.apiKey.create({ data: { userId: owner.id, name: 'k', keyPrefix: 'k', keyHash: hashToken(raw), scopes: ['files:upload'] } })
  const data = randomBytes(C + 3)
  const r = await postMultipart('/api/v1/uploads', multipart([['sizeBytes', String(data.length)], ['file', data, 'api.bin']]), raw)
  assert.equal(r.status, 201, r.text)
  await assertStored(r.json.file.id, owner.id, data)
})

test('multipart batches run strictly one file at a time and keep the response shape', async () => {
  const one = randomBytes(C + 100)
  const two = randomBytes(2000)
  let firstDone = false
  overrides = {
    putChunk: async (a, s, o, c, t) => {
      const r = await memoryProvider.putChunk(a, s, o, c, t)
      if (r.complete && t === encryptedSize(BigInt(one.length))) firstDone = true
      return r
    },
    beginUpload: async (a, n, s) => {
      if (s === encryptedSize(BigInt(two.length))) assert.equal(firstDone, true, 'second file began before the first finished')
      return memoryProvider.beginUpload(a, n, s)
    },
  }
  const meta = [
    { fieldName: 'f1', fileName: 'one.bin', mimeType: 'a/b', sizeBytes: String(one.length) },
    { fieldName: 'f2', fileName: 'two.bin', mimeType: 'c/d', sizeBytes: two.length },
  ]
  const r = await postMultipart('/uploads', multipart([['filesMeta', JSON.stringify(meta)], ['f1', one, 'x'], ['f2', two, 'y']]))
  assert.equal(r.status, 201, r.text)
  assert.equal(r.json.files.length, 2)
  assert.deepEqual(r.json.failed, [])
  await assertStored(r.json.files[0].id, owner.id, one)
  await assertStored(r.json.files[1].id, owner.id, two)
})

test('multipart stream that runs past the declared size fails with no File', async () => {
  const data = randomBytes(C + 100)
  const r = await postMultipart('/uploads', multipart([['sizeBytes', String(data.length - 1)], ['fileName', 'long.bin'], ['file', data, 'x']]))
  assert.equal(r.status, 400, r.text)
  assert.equal(r.json.code, 'UPLOAD_SIZE_MISMATCH')
  const [session] = await prisma.uploadSession.findMany({ where: { userId: owner.id, fileName: 'long.bin' } })
  assert.equal(session!.status, 'failed')
  assert.equal(await prisma.file.count({ where: { id: session!.fileId! } }), 0)
})

test('multipart stream that ends short fails with no File, and a batch reports per file', async () => {
  const good = randomBytes(500)
  const bad = randomBytes(C + 10)
  const meta = [
    { fieldName: 'f1', fileName: 'short.bin', mimeType: 'a/b', sizeBytes: String(bad.length + 1) },
    { fieldName: 'f2', fileName: 'good.bin', mimeType: 'c/d', sizeBytes: String(good.length) },
    { fieldName: 'f3', fileName: 'empty.bin', mimeType: 'c/d', sizeBytes: '0' },
  ]
  const r = await postMultipart('/uploads', multipart([['filesMeta', JSON.stringify(meta)], ['f1', bad, 'x'], ['f2', good, 'y'], ['f3', Buffer.alloc(0), 'z']]))
  assert.equal(r.status, 201, r.text)
  assert.equal(r.json.files.length, 1)
  assert.deepEqual(r.json.failed.map((f: any) => [f.fileName, f.code]), [['short.bin', 'UPLOAD_SIZE_MISMATCH'], ['empty.bin', 'UPLOAD_SIZE_REQUIRED']])
  const [session] = await prisma.uploadSession.findMany({ where: { userId: owner.id, fileName: 'short.bin' } })
  assert.equal(session!.status, 'failed')
  await assertStored(r.json.files[0].id, owner.id, good)
})

test('multipart rejects malformed fields without crashing', async () => {
  for (const parts of [[['filesMeta', 'not json']], [['sizeBytes', 'nope']]] as Array<Array<[string, string]>>) {
    const r = await postMultipart('/uploads', multipart([...parts, ['file', Buffer.from('x'), 'x']]))
    assert.equal(r.status, 400, r.text)
  }
  assert.equal((await api('GET', '/files', owner.token)).status, 200)
})

test('a client that disconnects mid-file fails its session', async () => {
  const boundary = 'xBoundaryx'
  const name = `abort-${randomUUID()}.bin`
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="sizeBytes"\r\n\r\n${C * 3}\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\n${name}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x"\r\nContent-Type: a/b\r\n\r\n`)
  const req = request(`${base}/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(head.length + C * 3 + 100) } })
  req.on('error', () => undefined)
  req.write(head)
  req.write(Buffer.alloc(1000))
  const until = async (done: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await done()); i++) await new Promise((r) => setTimeout(r, 50))
  }
  await until(async () => (await prisma.uploadSession.count({ where: { fileName: name } })) > 0)
  req.destroy()
  await until(async () => (await prisma.uploadSession.count({ where: { fileName: name, status: 'failed' } })) > 0)
  const [session] = await prisma.uploadSession.findMany({ where: { fileName: name } })
  assert.equal(session!.status, 'failed')
  assert.equal(new Set(calls.abort).size, 2)
})

test('status leaves the session alone when a provider cannot answer', async () => {
  const data = randomBytes(1000)
  const started = await init(data.length)
  const id = started.json.sessionId as string
  overrides = { committedOffset: async () => { throw new Error('blip') } }
  const blip = await status(id)
  assert.equal(blip.status, 502)
  assert.equal(blip.json.code, 'UPLOAD_CHUNK_RETRY')
  overrides = { committedOffset: async () => { throw new ProviderUnavailableError('down', false) } }
  const down = await status(id)
  assert.equal(down.status, 502)
  assert.equal(down.json.code, 'STORAGE_ACCOUNT_UNAVAILABLE')
  assert.equal((await sessionOf(id)).status, 'uploading')
  overrides = {}
  assert.deepEqual((await status(id)).json, { status: 'uploading', offset: '0' })
})

test('an account removed mid-upload fails the upload', async () => {
  const data = randomBytes(1000)
  const started = await init(data.length)
  const id = started.json.sessionId as string
  await prisma.connectedAccount.delete({ where: { id: calls.begin[1]!.accountId } })
  const r = await put(id, data, 0)
  assert.equal(r.status, 502)
  assert.equal(r.json.code, 'STORAGE_ACCOUNT_UNAVAILABLE')
  assert.equal((await sessionOf(id)).status, 'failed')
  assert.deepEqual(calls.abort, [calls.begin[0]!.accountId])
})

test('no permissions.create call exists in backend/src', () => {
  const root = fileURLToPath(new URL('../../src', import.meta.url))
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
  const hits = walk(root).filter((path) => readFileSync(path, 'utf8').includes('permissions.create'))
  assert.deepEqual(hits, [])
})
