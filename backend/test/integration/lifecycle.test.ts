import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import test, { after, before, beforeEach } from 'node:test'
import { fileURLToPath } from 'node:url'
import { app } from '../../src/app.js'
import { prisma } from '../../src/config/prisma.js'
import { UPLOAD_CHUNK_PLAINTEXT } from '../../src/modules/crypto/frames.js'
import { canRemoveAccount } from '../../src/modules/files/delete-blobs.js'
import { getBlob, memoryProvider, resetMemoryProvider } from '../../src/modules/storage/memory-provider.js'
import { ProviderUnavailableError, setTestProvider, type StorageProvider } from '../../src/modules/storage/provider.js'
import { hashPassword } from '../../src/utils/password.js'

const C = UPLOAD_CHUNK_PLAINTEXT
const run = randomUUID().slice(0, 8)
const PW = 'password-123'
let server: Server
let base = ''
const userIds: string[] = []
let accountIds: string[] = []
let admin = { id: '', token: '' }
let alice = { id: '', token: '' }
let bob = { id: '', token: '' }
let accounts: { id: string }[] = []

let providerCalls: string[] = []
let deleteBlobOverride: StorageProvider['deleteBlob'] | null = null
const spy: StorageProvider = {
  beginUpload: (a, n, s) => memoryProvider.beginUpload(a, n, s),
  putChunk: (a, s, o, c, t) => memoryProvider.putChunk(a, s, o, c, t),
  committedOffset: (a, s, t) => memoryProvider.committedOffset(a, s, t),
  abortUpload: (a, s) => memoryProvider.abortUpload(a, s),
  readRange: (a, id, s, e) => {
    providerCalls.push('readRange')
    return memoryProvider.readRange(a, id, s, e)
  },
  deleteBlob: (a, id) => (deleteBlobOverride ?? memoryProvider.deleteBlob)(a, id),
}

async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

async function seedUser(name: string, role = 'member') {
  const user = await prisma.user.create({ data: { name, email: `${name}-${run}@life.test`, passwordHash: await hashPassword(PW), role } })
  userIds.push(user.id)
  const login = await api('POST', '/auth/login', undefined, { email: user.email, password: PW })
  return { id: user.id, token: login.json.accessToken as string }
}

async function seedAccount(tag: string) {
  const account = await prisma.connectedAccount.create({ data: { userId: admin.id, provider: 's3', providerAccountId: `${tag}-${randomUUID()}`, email: `${tag}-${run}@life-pool.test`, scopes: [] } })
  const free = 10n ** 12n
  await prisma.storageAccount.create({ data: { connectedAccountId: account.id, totalBytes: free, usedBytes: 0n, availableBytes: free, lastSyncedAt: new Date() } })
  accountIds.push(account.id)
  return account
}

async function upload(token: string, fileName = 'holiday-photo.jpg', folderId?: string) {
  const bytes = randomBytes(2000)
  const init = await api('POST', '/uploads/resumable/init', token, { fileName, mimeType: 'image/jpeg', sizeBytes: String(bytes.length), ...(folderId ? { folderId } : {}) })
  assert.equal(init.status, 201, init.text)
  const res = await fetch(`${base}/uploads/resumable/chunk/${init.json.sessionId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` },
    body: new Uint8Array(bytes.subarray(0, Math.min(C, bytes.length))),
  })
  const json = (await res.json()) as any
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(json))
  return json.file.id as string
}

const replicasOf = (fileId: string) => prisma.fileReplica.findMany({ where: { fileId } })
const blobsOf = async (fileId: string) => (await replicasOf(fileId)).map((r) => getBlob(r.connectedAccountId, r.providerFileId))

before(async () => {
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  await prisma.appSetting.upsert({ where: { id: 1 }, create: { id: 1, priorityAccountIds: [] }, update: {} })
  admin = await seedUser('admin', 'admin')
  alice = await seedUser('alice')
  bob = await seedUser('bob')
  setTestProvider(spy)
})

beforeEach(async () => {
  await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  accountIds = []
  resetMemoryProvider()
  providerCalls = []
  deleteBlobOverride = null
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

test('canRemoveAccount allows removal only when no file depends on it', () => {
  assert.equal(canRemoveAccount(0), true)
  assert.equal(canRemoveAccount(1), false)
})

test('permanent delete removes both blobs and the file row', async () => {
  const id = await upload(alice.token)
  const before = await blobsOf(id)
  assert.equal(before.length, 2)
  assert.ok(before.every(Boolean))
  assert.equal((await api('DELETE', `/files/${id}`, alice.token)).status, 200)
  const res = await api('DELETE', '/files/batch/permanent', alice.token, { fileIds: [id] })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.deleted, 1)
  assert.ok((await blobsOf(id)).every((b) => b === undefined))
  assert.equal(await prisma.file.count({ where: { id } }), 0)
  assert.equal(await prisma.fileReplica.count({ where: { fileId: id } }), 0)
  assert.equal(await prisma.orphanBlob.count({ where: { connectedAccountId: { in: accounts.map((a) => a.id) } } }), 0)
})

test('an unreachable account becomes an OrphanBlob and the file is still deleted', async () => {
  const id = await upload(alice.token)
  const reps = await replicasOf(id)
  const bad = reps[0]!
  deleteBlobOverride = async (a, pid) => {
    if (a.id === bad.connectedAccountId) throw new ProviderUnavailableError('account unreachable')
    return memoryProvider.deleteBlob(a, pid)
  }
  await api('DELETE', `/files/${id}`, alice.token)
  const res = await api('DELETE', '/files/batch/permanent', alice.token, { fileIds: [id] })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.deleted, 1)
  assert.equal(await prisma.file.count({ where: { id } }), 0)
  const orphans = await prisma.orphanBlob.findMany({ where: { connectedAccountId: { in: accounts.map((a) => a.id) } } })
  assert.equal(orphans.length, 1)
  assert.equal(orphans[0]!.connectedAccountId, bad.connectedAccountId)
  assert.equal(orphans[0]!.providerFileId, bad.providerFileId)
  const good = reps[1]!
  assert.equal(getBlob(good.connectedAccountId, good.providerFileId), undefined)
})

test('a 404 on blob delete counts as already gone', async () => {
  const id = await upload(alice.token)
  deleteBlobOverride = async () => { throw new ProviderUnavailableError('gone', true) }
  await api('DELETE', `/files/${id}`, alice.token)
  const res = await api('DELETE', '/files/batch/permanent', alice.token, { fileIds: [id] })
  assert.equal(res.status, 200)
  assert.equal(await prisma.orphanBlob.count({ where: { connectedAccountId: { in: accounts.map((a) => a.id) } } }), 0)
  assert.equal(await prisma.file.count({ where: { id } }), 0)
})

test('rename changes only the database and calls no provider', async () => {
  const id = await upload(alice.token)
  const secret = `secret-name-${run}.jpg`
  const res = await api('PATCH', `/files/${id}`, alice.token, { name: secret })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.file.name, secret)
  assert.deepEqual(providerCalls, [])
  assert.equal((await prisma.file.findUniqueOrThrow({ where: { id } })).name, secret)
  for (const r of await replicasOf(id)) assert.ok(!r.providerFileId.includes('secret'))
})

test('file responses expose no account details or provider ids', async () => {
  const id = await upload(alice.token)
  await api('DELETE', `/files/${await upload(alice.token, 'trashed.jpg')}`, alice.token)
  await api('POST', `/files/${id}/share`, alice.token)
  const reps = await replicasOf(id)
  const texts = [
    (await api('GET', '/files', alice.token)).text,
    (await api('GET', `/files/${id}`, alice.token)).text,
    (await api('GET', '/files/trash', alice.token)).text,
    (await api('GET', '/files/shared-links', alice.token)).text,
    (await api('PATCH', `/files/${id}`, alice.token, { name: 'x.jpg' })).text,
  ]
  for (const text of texts) {
    assert.ok(text.includes('"files"') || text.includes('"file"') || text.includes('"shares"'))
    assert.ok(!text.includes('providerFileId'), text)
    assert.ok(!text.includes('connectedAccount'), text)
    assert.ok(!text.includes('life-pool.test'), text)
    for (const r of reps) assert.ok(!text.includes(r.providerFileId))
    assert.ok(!text.includes('wrappedFileKey'))
  }
})

test('removed Google-link routes are 404', async () => {
  const id = await upload(alice.token)
  assert.equal((await api('POST', '/files/sync-google', alice.token)).status, 404)
  assert.equal((await api('GET', `/files/${id}/view-url`, alice.token)).status, 404)
  assert.equal((await api('POST', `/files/${id}/public-permission`, alice.token, {})).status, 404)
})

test('no module sends names to Google or creates permissions', () => {
  // google.service.ts only finds or creates the fixed app folder, which carries no user data.
  const root = join(fileURLToPath(new URL('../../src', import.meta.url)))
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.ts') && !p.endsWith('google.service.ts') && /\bdrive\.(files|permissions)\./.test(readFileSync(p, 'utf8'))) hits.push(p)
    }
  }
  walk(root)
  assert.deepEqual(hits, [])
})

test('a member cannot read, rename, delete, share or move another member\'s file', async () => {
  const id = await upload(bob.token)
  assert.equal((await api('GET', `/files/${id}`, alice.token)).status, 404)
  assert.equal((await api('GET', `/files/${id}/download`, alice.token)).status, 404)
  assert.equal((await api('POST', `/files/${id}/preview-token`, alice.token)).status, 404)
  assert.equal((await api('PATCH', `/files/${id}`, alice.token, { name: 'mine.jpg' })).status, 404)
  assert.equal((await api('POST', `/files/${id}/share`, alice.token)).status, 404)
  assert.equal((await api('DELETE', `/files/${id}`, alice.token)).status, 404)
  assert.equal((await api('POST', '/invites', alice.token, { email: `bob-${run}@life.test`, targetType: 'file', targetId: id })).status, 404)
  const list = await api('GET', '/files', alice.token)
  assert.ok(!list.text.includes(id))
  await prisma.file.update({ where: { id }, data: { status: 'deleted', deletedAt: new Date() } })
  const perm = await api('DELETE', '/files/batch/permanent', alice.token, { fileIds: [id] })
  assert.equal(perm.json.deleted, 0)
  assert.equal(await prisma.file.count({ where: { id } }), 1)
  assert.ok((await blobsOf(id)).every(Boolean))
  assert.equal((await prisma.file.findUniqueOrThrow({ where: { id } })).name, 'holiday-photo.jpg')
})

test('invites only target existing users', async () => {
  const id = await upload(alice.token)
  const unknown = await api('POST', '/invites', alice.token, { email: `nobody-${run}@life.test`, targetType: 'file', targetId: id })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.code, 'INVITEE_NOT_FOUND')
  const disabled = await seedUser('gone')
  await prisma.user.update({ where: { id: disabled.id }, data: { status: 'disabled' } })
  const off = await api('POST', '/invites', alice.token, { email: `gone-${run}@life.test`, targetType: 'file', targetId: id })
  assert.equal(off.status, 404)
  assert.equal(off.json.code, 'INVITEE_NOT_FOUND')
  const ok = await api('POST', '/invites', alice.token, { email: `bob-${run}@life.test`, targetType: 'file', targetId: id })
  assert.equal(ok.status, 201, ok.text)
  assert.equal(await prisma.workspaceInvite.count({ where: { inviteeEmail: `nobody-${run}@life.test` } }), 0)
})

test('audit log: members and admins see only their own entries; the admin overview has no names', async () => {
  const secret = `audit-secret-${run}.jpg`
  const id = await upload(alice.token)
  await api('PATCH', `/files/${id}`, alice.token, { name: secret })
  await api('DELETE', `/files/${id}`, alice.token)
  const bobFile = await upload(bob.token)
  await api('PATCH', `/files/${bobFile}`, bob.token, { name: 'bobs-private.jpg' })
  const adminFile = await upload(admin.token)
  await api('PATCH', `/files/${adminFile}`, admin.token, { name: 'admins-own.jpg' })

  const mine = await api('GET', '/audit-logs', bob.token)
  assert.equal(mine.status, 200)
  assert.ok(mine.json.logs.length > 0)
  assert.ok(mine.json.logs.every((l: any) => l.userId === bob.id))
  assert.ok(!mine.text.includes(secret))

  const adminOwn = await api('GET', '/audit-logs', admin.token)
  assert.ok(adminOwn.json.logs.length > 0)
  assert.ok(adminOwn.json.logs.every((l: any) => l.userId === admin.id))
  assert.ok(!adminOwn.text.includes(secret))

  assert.equal((await api('GET', '/audit-logs/all', bob.token)).status, 403)
  assert.equal((await api('GET', '/audit-logs/all')).status, 401)
  const all = await api('GET', '/audit-logs/all', admin.token)
  assert.equal(all.status, 200, all.text)
  assert.ok(all.json.logs.length >= 3)
  assert.ok(!all.text.includes(secret))
  assert.ok(!all.text.includes('bobs-private'))
  assert.ok(!all.text.includes('metadata'))
  assert.ok(!all.text.includes('entityId'))
  for (const log of all.json.logs) {
    assert.deepEqual(Object.keys(log).sort(), ['action', 'createdAt', 'entityType', 'user'])
    if (log.user) assert.deepEqual(Object.keys(log.user).sort(), ['email', 'id', 'name'])
  }
  assert.ok(all.json.logs.some((l: any) => l.user?.id === alice.id && l.user.email === `alice-${run}@life.test`))
})

test('removing an account is refused while a file keeps its only healthy copy there', async () => {
  const id = await upload(alice.token)
  const [a, b] = await replicasOf(id)
  await prisma.fileReplica.update({ where: { id: b!.id }, data: { status: 'lost' } })
  const res = await api('DELETE', `/connected-accounts/${a!.connectedAccountId}`, admin.token)
  assert.equal(res.status, 409)
  assert.equal(res.json.code, 'ACCOUNT_HOLDS_SOLE_COPY')
  assert.equal(await prisma.connectedAccount.count({ where: { id: a!.connectedAccountId } }), 1)
  assert.equal(await prisma.fileReplica.count({ where: { id: a!.id } }), 1)
  assert.equal((await api('DELETE', `/connected-accounts/${a!.connectedAccountId}`, alice.token)).status, 403)
})

test('removing an account drops its replicas, fails its uploading sessions and leaves File rows and blobs', async () => {
  const id = await upload(alice.token)
  const pending = await api('POST', '/uploads/resumable/init', alice.token, { fileName: 'pending.jpg', mimeType: 'image/jpeg', sizeBytes: '5000' })
  assert.equal(pending.status, 201, pending.text)
  const [a, b] = await replicasOf(id)
  const removed = a!.connectedAccountId
  accountIds = accountIds.filter((x) => x !== removed)
  const res = await api('DELETE', `/connected-accounts/${removed}`, admin.token)
  assert.equal(res.status, 200, res.text)
  assert.equal(await prisma.connectedAccount.count({ where: { id: removed } }), 0)
  assert.equal(await prisma.file.count({ where: { id } }), 1)
  assert.equal(await prisma.fileReplica.count({ where: { fileId: id } }), 1)
  assert.equal((await prisma.fileReplica.findUniqueOrThrow({ where: { id: b!.id } })).status, 'healthy')
  assert.ok(getBlob(removed, a!.providerFileId), 'blob in the removed account is left alone')
  const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: pending.json.sessionId } })
  assert.equal(session.status, 'failed')
  assert.equal((await api('GET', `/files/${id}/download`, alice.token)).status, 200)
})

test('deleting a user permanently removes their files and copies and returns the count', async () => {
  const victim = await seedUser('victim')
  const f1 = await upload(victim.token, 'one.jpg')
  const f2 = await upload(victim.token, 'two.jpg')
  await api('DELETE', `/files/${f2}`, victim.token)
  const copies = [...(await replicasOf(f1)), ...(await replicasOf(f2))]
  assert.equal(copies.length, 4)

  const list = await api('GET', '/admin/users', admin.token)
  const row = list.json.users.find((u: any) => u.id === victim.id)
  assert.equal(row.totalFileCount, 2)
  assert.equal(row.totalBytes, '4000')

  const res = await api('DELETE', `/admin/users/${victim.id}`, admin.token)
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.deletedFiles, 2)
  assert.equal(await prisma.user.count({ where: { id: victim.id } }), 0)
  assert.equal(await prisma.file.count({ where: { id: { in: [f1, f2] } } }), 0)
  for (const c of copies) assert.equal(getBlob(c.connectedAccountId, c.providerFileId), undefined)
})

test('deleting a user with connected accounts is still refused', async () => {
  const holder = await seedUser('holder')
  const acct = await prisma.connectedAccount.create({ data: { userId: holder.id, provider: 's3', providerAccountId: `h-${randomUUID()}`, email: 'h@life.test', scopes: [] } })
  const res = await api('DELETE', `/admin/users/${holder.id}`, admin.token)
  assert.equal(res.status, 409)
  assert.equal(res.json.code, 'USER_HAS_CONNECTED_ACCOUNTS')
  await prisma.connectedAccount.delete({ where: { id: acct.id } })
})

test('deleting a folder removes both copies of contained files', async () => {
  const folder = await api('POST', '/folders', alice.token, { name: 'Trip' })
  assert.equal(folder.status, 201, folder.text)
  assert.ok(!folder.text.includes('providerFolderId'))
  const sub = await api('POST', '/folders', alice.token, { name: 'Sub', parentId: folder.json.folder.id })
  const f1 = await upload(alice.token, 'in-folder.jpg', folder.json.folder.id)
  const f2 = await upload(alice.token, 'in-sub.jpg', sub.json.folder.id)
  const keep = await upload(alice.token, 'outside.jpg')
  const copies = [...(await replicasOf(f1)), ...(await replicasOf(f2))]
  const res = await api('DELETE', `/folders/${folder.json.folder.id}`, alice.token)
  assert.equal(res.status, 200, res.text)
  assert.equal(await prisma.file.count({ where: { id: { in: [f1, f2] } } }), 0)
  for (const c of copies) assert.equal(getBlob(c.connectedAccountId, c.providerFileId), undefined)
  assert.equal(await prisma.file.count({ where: { id: keep } }), 1)
  assert.ok((await blobsOf(keep)).every(Boolean))
})
