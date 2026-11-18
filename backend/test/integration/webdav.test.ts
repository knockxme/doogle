import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { promisify } from 'node:util'
import { app } from '../../src/app.js'
import { prisma } from '../../src/config/prisma.js'
import { UPLOAD_CHUNK_PLAINTEXT } from '../../src/modules/crypto/frames.js'
import { countFilesMissingCopy } from '../../src/modules/admin/repair.js'
import { blobDeletesIdle } from '../../src/modules/files/purge.js'
import { getBlob, memoryProvider, resetMemoryProvider } from '../../src/modules/storage/memory-provider.js'
import { reservedByAccount } from '../../src/modules/storage/pool.js'
import { setTestProvider } from '../../src/modules/storage/provider.js'
import { startEncryptedUpload } from '../../src/modules/uploads/encrypted-upload.js'
import { STALE_UPLOAD_MS, sweepStaleUploads } from '../../src/modules/uploads/stale-uploads.js'
import { sweepDavTempFiles } from '../../src/modules/webdav/family-ports.js'
import { TEMP_PREFIX } from '../../src/modules/webdav/util.js'
import { hashPassword } from '../../src/utils/password.js'

const run = randomUUID().slice(0, 8)
const PW = 'password-123'
const P = UPLOAD_CHUNK_PLAINTEXT
let server: Server
let base = ''
const userIds: string[] = []
const accountIds: string[] = []
let media = { id: '', email: '', token: '', key: '' }
let admin = { id: '', token: '' }

async function seedUser(name: string, extra: Record<string, unknown> = {}) {
  const email = `${name}-${run}@test.local`
  const user = await prisma.user.create({ data: { name, email, passwordHash: await hashPassword(PW), ...extra } })
  userIds.push(user.id)
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }) })
  return { id: user.id, email, token: ((await res.json()) as { accessToken: string }).accessToken }
}

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

const basic = (email: string, key: string) => `Basic ${Buffer.from(`${email}:${key}`).toString('base64')}`
function dav(method: string, path: string, init: { body?: Buffer | string; headers?: Record<string, string>; email?: string; key?: string } = {}) {
  return fetch(`${base}/api/dav${path}`, { method, headers: { Authorization: basic(init.email ?? media.email, init.key ?? media.key), ...init.headers }, body: init.body })
}

const filesNamed = (name: string) => prisma.file.findMany({ where: { userId: media.id, name }, include: { replicas: true } })

before(async () => {
  setTestProvider(memoryProvider)
  resetMemoryProvider()
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const a = await seedUser('davadmin', { role: 'admin' })
  admin = { id: a.id, token: a.token }
  const m = await seedUser('media', { role: 'member' })
  for (const tag of ['dav-a', 'dav-b']) {
    const account = await prisma.connectedAccount.create({ data: { userId: admin.id, provider: 's3', providerAccountId: `${tag}-${randomUUID()}`, email: `${tag}@dav.test`, scopes: [] } })
    await prisma.storageAccount.create({ data: { connectedAccountId: account.id, totalBytes: 10n ** 12n, usedBytes: 0n, availableBytes: 10n ** 12n, lastSyncedAt: new Date() } })
    accountIds.push(account.id)
  }
  // Only an admin can turn WebDAV on; until then no WebDAV key can be made.
  assert.equal((await api('POST', '/api-keys', m.token, { name: 'pi', kind: 'dav' })).status, 403)
  assert.equal((await api('PATCH', `/admin/users/${m.id}`, admin.token, { davEnabled: true })).status, 200)
  const created = await api('POST', '/api-keys', m.token, { name: 'pi-rclone', kind: 'dav' })
  assert.equal(created.status, 201)
  media = { id: m.id, email: m.email, token: m.token, key: created.json.secret }
})

after(async () => {
  await blobDeletesIdle()
  await prisma.file.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.uploadSession.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.orphanBlob.deleteMany({ where: { connectedAccountId: { in: accountIds } } })
  await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  setTestProvider(null)
  await prisma.$disconnect()
  await new Promise((r) => server.close(r))
})

test('the package smoke test passes against the real ports', { skip: process.platform === 'win32' }, async () => {
  const script = fileURLToPath(new URL('../../../scripts/dav-smoke-test.sh', import.meta.url))
  const { stdout } = await promisify(execFile)('bash', [script, `${base}/api/dav`, media.email, media.key], { timeout: 120_000 })
  assert.match(stdout, /all \d+ checks passed/)
})

test('an upload key, a wrong email or a member without WebDAV is refused', async () => {
  const upload = await api('POST', '/api-keys', media.token, { name: 'upload-only' })
  assert.equal(upload.status, 201)
  assert.equal((await dav('PROPFIND', '/', { key: upload.json.secret, headers: { Depth: '0' } })).status, 401)
  assert.equal((await dav('PROPFIND', '/', { email: 'someone@else', headers: { Depth: '0' } })).status, 401)
  assert.equal((await dav('PROPFIND', '/', { email: media.email.toUpperCase(), headers: { Depth: '0' } })).status, 207, 'email case does not matter')
})

test('a file over one piece round-trips with two copies and seeks across the piece edge', async () => {
  const body = randomBytes(P + 5000)
  assert.equal((await dav('PUT', '/big.mkv', { body })).status, 201)
  const [file] = await filesNamed('big.mkv')
  assert.equal(file!.replicas.length, 2)
  assert.notEqual(file!.replicas[0]!.connectedAccountId, file!.replicas[1]!.connectedAccountId)
  const res = await dav('GET', '/big.mkv', { headers: { Range: `bytes=${P - 100}-${P + 99}` } })
  assert.equal(res.status, 206)
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), body.subarray(P - 100, P + 100))
})

test('replacing a file keeps one row, frees the old copies and keeps the content time on rename', async () => {
  assert.equal((await dav('PUT', '/ep.mkv', { body: 'first version', headers: { 'X-OC-Mtime': '1700000000' } })).status, 201)
  const [old] = await filesNamed('ep.mkv')
  const put = await dav('PUT', '/ep.mkv', { body: 'second version!', headers: { 'X-OC-Mtime': '1700000500' } })
  assert.equal(put.status, 204)
  assert.equal(put.headers.get('x-oc-mtime'), 'accepted')
  const rows = await filesNamed('ep.mkv')
  assert.equal(rows.length, 1)
  assert.notEqual(rows[0]!.id, old!.id)
  await blobDeletesIdle()
  for (const r of old!.replicas) assert.equal(getBlob(r.connectedAccountId, r.providerFileId), undefined)

  assert.equal((await dav('MOVE', '/ep.mkv', { headers: { Destination: `${base}/api/dav/renamed.mkv` } })).status, 201)
  const [moved] = await filesNamed('renamed.mkv')
  assert.equal(moved!.contentModifiedAt!.getTime(), 1700000500_000)
  assert.equal(await (await dav('GET', '/renamed.mkv')).text(), 'second version!')
})

test('names are case-sensitive', async () => {
  await dav('PUT', '/Show.mkv', { body: 'upper' })
  await dav('PUT', '/show.mkv', { body: 'lower' })
  assert.equal(await (await dav('GET', '/Show.mkv')).text(), 'upper')
  assert.equal(await (await dav('GET', '/show.mkv')).text(), 'lower')
})

test('an empty file is stored without copies and Repair ignores it', async () => {
  const before = await countFilesMissingCopy()
  assert.equal((await dav('PUT', '/empty.nfo', { body: '' })).status, 201)
  const [file] = await filesNamed('empty.nfo')
  assert.equal(file!.replicas.length, 0)
  const res = await dav('GET', '/empty.nfo')
  assert.equal(res.status, 200)
  assert.equal((await res.arrayBuffer()).byteLength, 0)
  assert.equal(await countFilesMissingCopy(), before)
  // The normal web download of the same file works too.
  assert.equal((await fetch(`${base}/files/${file!.id}/download`, { headers: { Authorization: `Bearer ${media.token}` } })).status, 200)
})

test('deleting a folder removes everything in it at once, trash included', async () => {
  assert.equal((await dav('MKCOL', '/season')).status, 201)
  await dav('PUT', '/season/e1.mkv', { body: 'one' })
  await dav('PUT', '/season/e2.mkv', { body: 'two' })
  const [e2] = await filesNamed('e2.mkv')
  await prisma.file.update({ where: { id: e2!.id }, data: { status: 'deleted', deletedAt: new Date() } })
  const usedBefore = (await api('GET', '/storage/summary', media.token)).json.usedBytes
  assert.equal((await dav('DELETE', '/season/')).status, 204)
  assert.equal((await filesNamed('e1.mkv')).length + (await filesNamed('e2.mkv')).length, 0)
  const usedAfter = (await api('GET', '/storage/summary', media.token)).json.usedBytes
  assert.equal(BigInt(usedBefore) - BigInt(usedAfter), 6n)
})

test('the client address comes from the proxy, so a forged X-Forwarded-For does not escape the limit', async () => {
  // As behind nginx: the last entry is the one nginx added.
  for (let i = 0; i < 10; i++) await dav('PROPFIND', '/', { key: 'wrong', headers: { Depth: '0', 'X-Forwarded-For': `1.2.3.${i}, 10.9.9.9` } })
  assert.equal((await dav('PROPFIND', '/', { headers: { Depth: '0', 'X-Forwarded-For': '5.5.5.5, 10.9.9.9' } })).status, 429)
  assert.equal((await dav('PROPFIND', '/', { headers: { Depth: '0', 'X-Forwarded-For': '10.9.9.10' } })).status, 207)
})

test('a disabled member is refused on the next request, even with a cached key', async () => {
  assert.equal((await dav('PROPFIND', '/', { headers: { Depth: '0' } })).status, 207)
  assert.equal((await api('PATCH', `/admin/users/${media.id}`, admin.token, { status: 'disabled' })).status, 200)
  try {
    assert.equal((await dav('PROPFIND', '/', { headers: { Depth: '0' } })).status, 401)
  } finally {
    await api('PATCH', `/admin/users/${media.id}`, admin.token, { status: 'active' })
  }
})

test('turning WebDAV off revokes the WebDAV keys', async () => {
  const extra = await api('POST', '/api-keys', media.token, { name: 'second', kind: 'dav' })
  assert.equal((await dav('PROPFIND', '/', { key: extra.json.secret, headers: { Depth: '0' } })).status, 207)
  assert.equal((await api('PATCH', `/admin/users/${media.id}`, admin.token, { davEnabled: false })).status, 200)
  assert.equal((await dav('PROPFIND', '/', { key: extra.json.secret, headers: { Depth: '0' } })).status, 401)
  const key = await prisma.apiKey.findFirstOrThrow({ where: { userId: media.id, name: 'second' } })
  assert.ok(key.revokedAt)
  // Back on for the rest of the file, with a fresh key.
  await api('PATCH', `/admin/users/${media.id}`, admin.token, { davEnabled: true })
  media.key = (await api('POST', '/api-keys', media.token, { name: 'pi-again', kind: 'dav' })).json.secret
})

test('an idle upload is given up by the sweep and its reservation released', async () => {
  const session = await startEncryptedUpload({ userId: media.id, plainSize: 1000n, fileName: 'stuck.bin', mimeType: 'application/octet-stream', folderId: null })
  assert.ok(((await reservedByAccount()).get(accountIds[0]!) ?? 0n) > 0n || ((await reservedByAccount()).get(accountIds[1]!) ?? 0n) > 0n)
  await prisma.uploadSession.update({ where: { id: session.id }, data: { lastActivityAt: new Date(Date.now() - STALE_UPLOAD_MS - 1000) } })
  assert.ok((await sweepStaleUploads()) >= 1)
  assert.equal((await prisma.uploadSession.findUniqueOrThrow({ where: { id: session.id } })).status, 'failed')
})

test('a leftover temp upload is hidden from the web list and swept after a day', async () => {
  const name = `${TEMP_PREFIX}${randomUUID()}`
  await dav('PUT', '/visible.txt', { body: 'x' })
  const [row] = await filesNamed('visible.txt')
  await prisma.file.update({ where: { id: row!.id }, data: { name, createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) } })
  const list = await api('GET', '/files', media.token)
  assert.equal(list.json.files.some((f: { name: string }) => f.name === name), false)
  assert.ok((await sweepDavTempFiles()) >= 1)
  assert.equal((await filesNamed(name)).length, 0)
})
