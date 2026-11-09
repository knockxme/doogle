import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import test, { after, before } from 'node:test'
import { app } from '../../src/app.js'
import { prisma } from '../../src/config/prisma.js'
import { hashToken } from '../../src/utils/crypto.js'
import { hashPassword } from '../../src/utils/password.js'

const run = randomUUID().slice(0, 8)
const email = (n: string) => `${n}-${run}@test.local`
const PW = 'password-123'
let server: Server
let base = ''
const createdUserIds: string[] = []

async function http(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

async function seedUser(name: string, role: string, extra: Record<string, unknown> = {}) {
  const user = await prisma.user.create({ data: { name, email: email(name), passwordHash: await hashPassword(PW), role, ...extra } })
  createdUserIds.push(user.id)
  return user
}

async function login(name: string, password = PW) {
  const res = await http('POST', '/auth/login', { body: { email: email(name), password } })
  return res
}

before(async () => {
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  await prisma.$disconnect()
  await new Promise((r) => server.close(r))
})

test('sign-up and Google login routes are gone', async () => {
  assert.equal((await http('POST', '/auth/register', { body: { name: 'x', email: email('reg'), password: PW } })).status, 404)
  assert.equal((await http('GET', '/auth/google/url')).status, 404)
})

test('members are blocked from admin and system routes', async () => {
  await seedUser('mem1', 'member')
  const token = (await login('mem1')).json.accessToken
  for (const [m, p] of [['GET', '/admin/users'], ['GET', '/system/google-config'], ['GET', '/provider-configs'], ['POST', '/connected-accounts/s3']] as const) {
    const r = await http(m, p, { token, body: m === 'POST' ? {} : undefined })
    assert.equal(r.status, 403, `${m} ${p}`)
    assert.equal(r.json.code, 'ADMIN_REQUIRED')
  }
  assert.equal((await http('POST', '/system/update', { token })).status, 404)
})

test('login returns role and mustChangePassword; change-password flow', async () => {
  await seedUser('adm1', 'admin')
  const adminToken = (await login('adm1')).json.accessToken
  const created = await http('POST', '/admin/users', { token: adminToken, body: { name: 'newbie', email: email('newbie'), temporaryPassword: 'temp-pass-1', storageLimitBytes: null } })
  assert.equal(created.status, 201)
  createdUserIds.push(created.json.user.id)
  const l = await http('POST', '/auth/login', { body: { email: email('newbie'), password: 'temp-pass-1' } })
  assert.equal(l.status, 200)
  assert.equal(l.json.user.role, 'member')
  assert.equal(l.json.user.mustChangePassword, true)
  const t = l.json.accessToken
  const blocked = await http('GET', '/files', { token: t })
  assert.equal(blocked.status, 403)
  assert.equal(blocked.json.code, 'PASSWORD_CHANGE_REQUIRED')
  assert.equal((await http('GET', '/auth/me', { token: t })).status, 200)
  const apiKeyRaw = `k-${run}-pc`
  await prisma.apiKey.create({ data: { userId: created.json.user.id, name: 'k', keyPrefix: 'k', keyHash: hashToken(apiKeyRaw), scopes: ['files:upload'] } })
  const ak = await http('POST', '/api/v1/uploads', { token: apiKeyRaw })
  assert.equal(ak.status, 403)
  assert.equal(ak.json.code, 'PASSWORD_CHANGE_REQUIRED')
  const bad = await http('POST', '/auth/change-password', { token: t, body: { currentPassword: 'wrong-pass', newPassword: 'brand-new-pw' } })
  assert.equal(bad.status, 401)
  const ok = await http('POST', '/auth/change-password', { token: t, body: { currentPassword: 'temp-pass-1', newPassword: 'brand-new-pw' } })
  assert.equal(ok.status, 200)
  assert.notEqual((await http('GET', '/files', { token: t })).json?.code, 'PASSWORD_CHANGE_REQUIRED')
  assert.equal((await http('GET', '/files', { token: t })).status, 200)
})

test('reset-password revokes old sessions and forces change', async () => {
  await seedUser('adm2', 'admin')
  const adminToken = (await login('adm2')).json.accessToken
  const victim = await seedUser('victim', 'member')
  const first = (await login('victim')).json
  assert.equal((await http('GET', '/auth/me', { token: first.accessToken })).status, 200)
  const r = await http('POST', `/admin/users/${victim.id}/reset-password`, { token: adminToken, body: { temporaryPassword: 'reset-temp-1' } })
  assert.equal(r.status, 200)
  assert.equal((await http('GET', '/auth/me', { token: first.accessToken })).status, 401)
  assert.equal((await http('POST', '/auth/refresh', { body: { refreshToken: first.refreshToken } })).status, 401)
  assert.equal((await login('victim')).status, 401)
  const again = await login('victim', 'reset-temp-1')
  assert.equal(again.status, 200)
  assert.equal(again.json.user.mustChangePassword, true)
})

test('disabled user token and API key fail on next request', async () => {
  await seedUser('adm3', 'admin')
  const adminToken = (await login('adm3')).json.accessToken
  const u = await seedUser('dis', 'member')
  const token = (await login('dis')).json.accessToken
  const raw = `k-${run}-dis`
  await prisma.apiKey.create({ data: { userId: u.id, name: 'k', keyPrefix: 'k', keyHash: hashToken(raw), scopes: ['files:upload'] } })
  assert.equal((await http('GET', '/files', { token })).status, 200)
  const p = await http('PATCH', `/admin/users/${u.id}`, { token: adminToken, body: { status: 'disabled' } })
  assert.equal(p.status, 200)
  const a = await http('GET', '/files', { token })
  assert.equal(a.status, 403)
  assert.equal(a.json.code, 'USER_DISABLED')
  const k = await http('POST', '/api/v1/uploads', { token: raw })
  assert.equal(k.status, 403)
  assert.equal(k.json.code, 'USER_DISABLED')
  assert.equal((await login('dis')).status, 403)
})

test('last admin cannot be disabled or deleted; listing hides file names', async () => {
  // Make this admin the only active admin by temporarily disabling the others.
  const sole = await seedUser('sole', 'admin')
  const token = (await login('sole')).json.accessToken
  const others = await prisma.user.findMany({ where: { role: 'admin', status: 'active', id: { not: sole.id } }, select: { id: true } })
  await prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: 'disabled' } })
  try {
    const d = await http('PATCH', `/admin/users/${sole.id}`, { token, body: { status: 'disabled' } })
    assert.equal(d.status, 409)
    assert.equal(d.json.code, 'LAST_ADMIN')
    const del = await http('DELETE', `/admin/users/${sole.id}`, { token })
    assert.equal(del.status, 409)
    assert.equal(del.json.code, 'LAST_ADMIN')

    const owner = await seedUser('owner', 'member')
    const account = await prisma.connectedAccount.create({ data: { userId: owner.id, provider: 's3', providerAccountId: `acct-${run}`, email: 'a@b.c', scopes: [] } })
    const secretName = `secret-holiday-${run}.jpg`
    await prisma.file.create({ data: { userId: owner.id, connectedAccountId: account.id, provider: 's3', providerFileId: `pf-${run}`, name: secretName, mimeType: 'image/jpeg', sizeBytes: 1234n } })
    const list = await http('GET', '/admin/users', { token })
    assert.equal(list.status, 200)
    assert.ok(!list.text.includes(secretName))
    const row = list.json.users.find((u: any) => u.id === owner.id)
    assert.equal(row.usedBytes, '1234')
    const del2 = await http('DELETE', `/admin/users/${owner.id}`, { token })
    assert.equal(del2.status, 409)
    assert.equal(del2.json.code, 'USER_HAS_FILES')
  } finally {
    await prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: 'active' } })
  }
})

test('failed logins are rate limited per email and IP', async () => {
  await seedUser('rl', 'member')
  for (let i = 0; i < 5; i++) assert.equal((await login('rl', 'nope-nope')).status, 401)
  const blocked = await login('rl', 'nope-nope')
  assert.equal(blocked.status, 429)
  assert.equal(blocked.json.code, 'AUTH_RATE_LIMITED')
  assert.equal((await login('rl')).status, 429)
})
