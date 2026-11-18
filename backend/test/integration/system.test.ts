import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import test, { after, before } from 'node:test'
import { app } from '../../src/app.js'
import { prisma } from '../../src/config/prisma.js'
import { decryptText } from '../../src/utils/crypto.js'
import { hashPassword } from '../../src/utils/password.js'

const run = randomUUID().slice(0, 8)
const PW = 'password-123'
let server: Server
let base = ''
let token = ''
let adminId = ''
const startedAt = new Date()
let saved: { id: string; status: string }[] = []

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

const activeGlobal = () => prisma.providerConfig.findMany({ where: { userId: null, provider: 'google_drive', status: 'active' } })

before(async () => {
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const admin = await prisma.user.create({ data: { name: 'sys', email: `sys-${run}@test.local`, passwordHash: await hashPassword(PW), role: 'admin' } })
  adminId = admin.id
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: admin.email, password: PW }) })
  token = ((await login.json()) as { accessToken: string }).accessToken
  // Park any global config from earlier runs so these tests start from "never configured".
  saved = (await prisma.providerConfig.findMany({ where: { userId: null, provider: 'google_drive' }, select: { id: true, status: true } }))
  await prisma.providerConfig.updateMany({ where: { id: { in: saved.map((c) => c.id) } }, data: { status: 'disabled' } })
})

after(async () => {
  await prisma.providerConfig.deleteMany({ where: { userId: null, provider: 'google_drive', createdAt: { gte: startedAt }, id: { notIn: saved.map((c) => c.id) } } })
  for (const c of saved) await prisma.providerConfig.update({ where: { id: c.id }, data: { status: c.status } })
  await prisma.user.deleteMany({ where: { id: adminId } })
  await prisma.$disconnect()
  await new Promise((r) => server.close(r))
})

test('first Google config without a secret is refused and creates nothing', async () => {
  const res = await http('POST', '/system/google-config', { clientId: 'id-1' })
  assert.equal(res.status, 400)
  assert.equal((await activeGlobal()).length, 0)
})

test('a missing client id is a validation error', async () => {
  const res = await http('POST', '/system/google-config', { clientSecret: 'secret' })
  assert.equal(res.status, 400)
  assert.equal(res.json.code, 'VALIDATION_ERROR')
})

test('an update without a secret keeps the current secret and leaves exactly one active config', async () => {
  assert.equal((await http('POST', '/system/google-config', { clientId: 'id-1', clientSecret: 'secret-1', redirectUri: 'https://drive.example/api/connected-accounts/google/callback' })).status, 201)
  assert.equal((await http('POST', '/system/google-config', { clientId: 'id-2' })).status, 201)
  const active = await activeGlobal()
  assert.equal(active.length, 1)
  assert.equal(decryptText(active[0]!.clientIdEncrypted), 'id-2')
  assert.equal(decryptText(active[0]!.clientSecretEncrypted), 'secret-1')
})

test('the suggested redirect address includes the proxy prefix', async () => {
  const res = await http('GET', '/system/google-config', undefined, { 'X-Forwarded-Prefix': '/api' })
  assert.equal(res.status, 200)
  assert.match(res.json.defaultRedirectUri, /\/api\/connected-accounts\/google\/callback$/)
  const bad = await http('GET', '/system/google-config', undefined, { 'X-Forwarded-Prefix': '/api?x=<script>' })
  assert.match(bad.json.defaultRedirectUri, /:\d+\/connected-accounts\/google\/callback$/)
})
