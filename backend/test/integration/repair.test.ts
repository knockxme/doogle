import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { after, before, beforeEach } from 'node:test'
import { app } from '../../src/app.js'
import { prisma } from '../../src/config/prisma.js'
import { UPLOAD_CHUNK_PLAINTEXT } from '../../src/modules/crypto/frames.js'
import { repairIdle, resumeRepairOnBoot } from '../../src/modules/admin/repair.js'
import { getBlob, memoryProvider, resetMemoryProvider } from '../../src/modules/storage/memory-provider.js'
import { ProviderUnavailableError, setTestProvider, type StorageProvider } from '../../src/modules/storage/provider.js'
import { hashPassword } from '../../src/utils/password.js'

const C = UPLOAD_CHUNK_PLAINTEXT
const run = randomUUID().slice(0, 8)
const PW = 'password-123'
const FILE_NAME = 'secret-holiday-photo.jpg'
let server: Server
let base = ''
const userIds: string[] = []
let accountIds: string[] = []
let admin = { id: '', token: '' }
let alice = { id: '', token: '' }
const authFail = new Set<string>()

const provider: StorageProvider = {
  ...memoryProvider,
  readRange: (a, id, s, e) => {
    if (authFail.has(a.id)) return Promise.reject(new ProviderUnavailableError('auth failed', false))
    return memoryProvider.readRange(a, id, s, e)
  },
}

async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

async function seedUser(name: string, role = 'member') {
  const user = await prisma.user.create({ data: { name, email: `${name}-${run}@repair.test`, passwordHash: await hashPassword(PW), role } })
  userIds.push(user.id)
  const login = await api('POST', '/auth/login', undefined, { email: user.email, password: PW })
  return { id: user.id, token: login.json.accessToken as string }
}

async function seedAccount(tag: string, free = 10n ** 12n) {
  const account = await prisma.connectedAccount.create({ data: { userId: admin.id, provider: 's3', providerAccountId: `${tag}-${randomUUID()}`, email: `${tag}-${run}@repair-pool.test`, scopes: [] } })
  await prisma.storageAccount.create({ data: { connectedAccountId: account.id, totalBytes: free, usedBytes: 0n, availableBytes: free, lastSyncedAt: new Date() } })
  accountIds.push(account.id)
  return account
}

let lastData: Buffer
async function upload() {
  const bytes = (lastData = randomBytes(3000))
  const init = await api('POST', '/uploads/resumable/init', alice.token, { fileName: FILE_NAME, mimeType: 'image/jpeg', sizeBytes: String(bytes.length) })
  assert.equal(init.status, 201, init.text)
  const res = await fetch(`${base}/uploads/resumable/chunk/${init.json.sessionId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` },
    body: new Uint8Array(bytes.subarray(0, Math.min(C, bytes.length))),
  })
  const json = (await res.json()) as any
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(json))
  return json.file.id as string
}

async function repairAndWait() {
  const started = await api('POST', '/admin/storage/repair', admin.token)
  assert.equal(started.status, 202, started.text)
  await repairIdle()
  const latest = await api('GET', '/admin/storage/repair', admin.token)
  return latest.json as { id: string; status: string; processed: number; failed: number }
}

const replicasOf = (fileId: string) => prisma.fileReplica.findMany({ where: { fileId }, include: { connectedAccount: true } })

before(async () => {
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  await prisma.appSetting.upsert({ where: { id: 1 }, create: { id: 1, priorityAccountIds: [] }, update: {} })
  admin = await seedUser('admin', 'admin')
  alice = await seedUser('alice')
  setTestProvider(provider)
})

beforeEach(async () => {
  await repairIdle()
  await prisma.file.deleteMany({ where: { userId: alice.id } })
  await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  accountIds = []
  authFail.clear()
  resetMemoryProvider()
  await prisma.repairJob.deleteMany()
  await prisma.appSetting.update({ where: { id: 1 }, data: { routingMode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 } })
})

after(async () => {
  setTestProvider(null)
  await repairIdle()
  await prisma.repairJob.deleteMany()
  await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
  await new Promise((r) => server.close(r))
})

test('a lost copy is recreated byte-identical on a third account', async () => {
  const a = await seedAccount('a')
  const b = await seedAccount('b')
  const fileId = await upload()
  const c = await seedAccount('c')
  const [lost, kept] = (await replicasOf(fileId)).sort((x, y) => (x.connectedAccountId === a.id ? -1 : 1) - (y.connectedAccountId === a.id ? -1 : 1))
  await prisma.fileReplica.update({ where: { id: lost!.id }, data: { status: 'lost' } })

  const job = await repairAndWait()
  assert.equal(job.status, 'completed')
  assert.equal(job.failed, 0)
  const after = await replicasOf(fileId)
  assert.equal(after.length, 2)
  assert.ok(after.every((r) => r.status === 'healthy' && r.connectedAccount.status === 'connected'))
  const fresh = after.find((r) => r.connectedAccountId === c.id)!
  assert.ok(fresh)
  assert.ok(!after.some((r) => r.id === lost!.id))
  assert.deepEqual(getBlob(c.id, fresh.providerFileId), getBlob(kept!.connectedAccountId, kept!.providerFileId))
  assert.equal(await prisma.orphanBlob.count({ where: { connectedAccountId: lost!.connectedAccountId } }), 0, 'swept after a successful delete')
  assert.equal(await prisma.uploadSession.count({ where: { fileId, status: 'repairing' } }), 0)
  assert.equal(b.id.length > 0, true)
})

test('no account available leaves the file counted in failed', async () => {
  await seedAccount('a')
  await seedAccount('b')
  const fileId = await upload()
  const [r] = await replicasOf(fileId)
  await prisma.fileReplica.update({ where: { id: r!.id }, data: { status: 'lost' } })
  const job = await repairAndWait()
  assert.equal(job.status, 'completed')
  assert.equal(job.failed, 1)
  assert.equal((await replicasOf(fileId)).filter((x) => x.status === 'healthy').length, 1)
  const again = await api('POST', '/admin/storage/repair', admin.token)
  assert.equal(again.status, 202)
  await repairIdle()
})

test('a file with no usable copy is counted failed and left alone', async () => {
  await seedAccount('a')
  await seedAccount('b')
  await seedAccount('c')
  const fileId = await upload()
  await prisma.fileReplica.updateMany({ where: { fileId }, data: { status: 'lost' } })
  const job = await repairAndWait()
  assert.equal(job.failed, 1)
  assert.equal((await replicasOf(fileId)).length, 2)
})

test('a second start while one runs is refused with REPAIR_RUNNING', async () => {
  await prisma.repairJob.create({ data: { status: 'running' } })
  const res = await api('POST', '/admin/storage/repair', admin.token)
  assert.equal(res.status, 409)
  assert.equal(res.json.code, 'REPAIR_RUNNING')
  const member = await api('POST', '/admin/storage/repair', alice.token)
  assert.equal(member.status, 403)
})

test('a running job left in the database resumes on boot and stale repairing sessions fail', async () => {
  await seedAccount('a')
  await seedAccount('b')
  const fileId = await upload()
  const c = await seedAccount('c')
  const [r] = await replicasOf(fileId)
  await prisma.fileReplica.update({ where: { id: r!.id }, data: { status: 'lost' } })
  const job = await prisma.repairJob.create({ data: { status: 'running' } })
  const stale = await prisma.uploadSession.create({ data: { userId: alice.id, fileName: 'repair', mimeType: 'application/octet-stream', sizeBytes: 10n, status: 'repairing', fileId, replicas: { create: [{ connectedAccountId: c.id, reservedBytes: 10n }] } } })

  await resumeRepairOnBoot()
  await repairIdle()
  assert.equal((await prisma.uploadSession.findUniqueOrThrow({ where: { id: stale.id } })).status, 'failed')
  const done = await prisma.repairJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(done.status, 'completed')
  const after = await replicasOf(fileId)
  assert.equal(after.filter((x) => x.status === 'healthy').length, 2)
})

test('OrphanBlob rows are cleared when their account is reachable and kept when it is not', async () => {
  const a = await seedAccount('a')
  const b = await seedAccount('b')
  await prisma.orphanBlob.create({ data: { connectedAccountId: a.id, providerFileId: 'gone-1' } })
  await prisma.orphanBlob.create({ data: { connectedAccountId: b.id, providerFileId: 'gone-2' } })
  await prisma.connectedAccount.update({ where: { id: b.id }, data: { status: 'unhealthy' } })
  await repairAndWait()
  assert.equal(await prisma.orphanBlob.count({ where: { connectedAccountId: a.id } }), 0)
  assert.equal(await prisma.orphanBlob.count({ where: { connectedAccountId: b.id } }), 1)
})

test('health reports per-account counts and no file names', async () => {
  const a = await seedAccount('a')
  await seedAccount('b')
  const fileId = await upload()
  const [r] = await replicasOf(fileId)
  await prisma.fileReplica.update({ where: { id: r!.id }, data: { status: 'lost' } })
  const res = await api('GET', '/admin/storage/health', admin.token)
  assert.equal(res.status, 200, res.text)
  assert.ok(!res.text.includes(FILE_NAME))
  assert.equal(res.json.filesMissingCopy, 1)
  const row = res.json.accounts.find((x: any) => x.id === r!.connectedAccountId)
  assert.deepEqual(Object.keys(row).sort(), ['email', 'full', 'healthyCopies', 'id', 'lastError', 'lostCopies', 'status'])
  assert.equal(row.lostCopies, 1)
  assert.equal(a.id.length > 0, true)
  assert.equal((await api('GET', '/admin/storage/health', alice.token)).status, 403)
})

test('a locked account fails over on read, is marked unhealthy, and Repair rebuilds the copy elsewhere', async () => {
  await seedAccount('a')
  await seedAccount('b')
  const fileId = await upload()
  const c = await seedAccount('c')
  const reps = (await replicasOf(fileId)).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || (x.id < y.id ? -1 : 1))
  const first = reps[0]!
  const second = reps[1]!
  authFail.add(first.connectedAccountId)

  const res = await fetch(`${base}/files/${fileId}/download`, { headers: { Authorization: `Bearer ${alice.token}` } })
  assert.equal(res.status, 200)
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), lastData)
  const locked = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: first.connectedAccountId } })
  assert.equal(locked.status, 'unhealthy')
  assert.ok(locked.lastError && !locked.lastError.includes(FILE_NAME))

  const job = await repairAndWait()
  assert.equal(job.failed, 0)
  const after = await replicasOf(fileId)
  assert.equal(after.length, 2)
  assert.ok(after.every((r) => r.status === 'healthy' && r.connectedAccount.status === 'connected'))
  assert.deepEqual(after.map((r) => r.connectedAccountId).sort(), [c.id, second.connectedAccountId].sort())
  const orphans = await prisma.orphanBlob.findMany({ where: { connectedAccountId: first.connectedAccountId } })
  assert.equal(orphans.length, 1)
  assert.equal(orphans[0]!.providerFileId, first.providerFileId)
})
