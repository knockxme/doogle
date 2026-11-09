import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before, beforeEach } from 'node:test'
import { prisma } from '../../src/config/prisma.js'
import { encryptedSize } from '../../src/modules/crypto/frames.js'
import { initialCapForConnect, reserveUpload, userAvailable, userStorage } from '../../src/modules/storage/pool.js'

const run = randomUUID().slice(0, 8)
const userIds: string[] = []
let accountIds: string[] = []

async function seedUser(name: string, storageLimitBytes: bigint | null = null) {
  const user = await prisma.user.create({ data: { name, email: `${name}-${run}@test.local`, passwordHash: 'x', role: 'member', storageLimitBytes } })
  userIds.push(user.id)
  return user
}

async function seedAccount(owner: string, tag: string, freeBytes: bigint, extra: Record<string, unknown> = {}) {
  const account = await prisma.connectedAccount.create({
    data: { userId: owner, provider: 's3', providerAccountId: `${tag}-${run}`, email: `${tag}@pool.test`, scopes: [], ...extra },
  })
  await prisma.storageAccount.create({ data: { connectedAccountId: account.id, totalBytes: freeBytes, usedBytes: 0n, availableBytes: freeBytes, lastSyncedAt: new Date() } })
  accountIds.push(account.id)
  return account
}

before(async () => {
  await prisma.appSetting.upsert({ where: { id: 1 }, create: { id: 1, priorityAccountIds: [] }, update: {} })
})

beforeEach(async () => {
  await prisma.appSetting.update({ where: { id: 1 }, data: { routingMode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 } })
  await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  accountIds = []
})

after(async () => {
  await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
})

const args = (userId: string, plainSize: bigint) => ({ userId, plainSize, fileName: 'a.bin', mimeType: 'application/octet-stream', folderId: null })

test('concurrent reservations that cannot both fit give one success and one NO_ACCOUNT_WITH_ENOUGH_SPACE', async () => {
  const user = await seedUser('conc')
  const plain = 5_000_000n
  const free = encryptedSize(plain) + 100n
  await seedAccount(user.id, 'c1', free)
  await seedAccount(user.id, 'c2', free)
  const results = await Promise.allSettled([reserveUpload(args(user.id, plain)), reserveUpload(args(user.id, plain))])
  const ok = results.filter((r) => r.status === 'fulfilled')
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  assert.equal(ok.length, 1)
  assert.equal(failed.length, 1)
  assert.equal(failed[0].reason.code, 'NO_ACCOUNT_WITH_ENOUGH_SPACE')
  const won = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof reserveUpload>>>).value
  assert.equal(won.session.status, 'uploading')
  assert.ok(won.session.fileId && won.session.wrappedFileKey)
  assert.notEqual(won.accounts[0].id, won.accounts[1].id)
  const replicas = await prisma.uploadSessionReplica.findMany({ where: { uploadSessionId: won.session.id } })
  assert.equal(replicas.length, 2)
  assert.ok(replicas.every((r) => r.reservedBytes === encryptedSize(plain)))
})

test('USER_STORAGE_LIMIT_REACHED when the user would go over their limit', async () => {
  const user = await seedUser('limited', 1_000n)
  await seedAccount(user.id, 'l1', 10n ** 9n)
  await seedAccount(user.id, 'l2', 10n ** 9n)
  await assert.rejects(reserveUpload(args(user.id, 2_000n)), (e: any) => e.code === 'USER_STORAGE_LIMIT_REACHED')
  const usage = await userStorage(user.id)
  assert.equal(usage.limitBytes, 1_000n)
  assert.equal(usage.usedBytes, 0n)
  assert.equal(usage.availableBytes, 1_000n)
})

test('in-progress sessions and trashed files count toward user usage', async () => {
  const user = await seedUser('usage', 10_000n)
  await seedAccount(user.id, 'u1', 10n ** 9n)
  await seedAccount(user.id, 'u2', 10n ** 9n)
  await prisma.file.create({ data: { userId: user.id, name: 't', mimeType: 'x/y', sizeBytes: 4_000n, wrappedFileKey: 'wrapped', encryptedSizeBytes: 4_028n, status: 'deleted', deletedAt: new Date() } })
  await prisma.file.create({ data: { userId: user.id, name: 'p', mimeType: 'x/y', sizeBytes: 7_000n, wrappedFileKey: 'wrapped', encryptedSizeBytes: 7_028n, status: 'purged' } })
  await reserveUpload(args(user.id, 3_000n))
  const usage = await userStorage(user.id)
  assert.equal(usage.usedBytes, 7_000n)
  assert.equal(usage.availableBytes, 3_000n)
  await assert.rejects(reserveUpload(args(user.id, 3_001n)), (e: any) => e.code === 'USER_STORAGE_LIMIT_REACHED')
})

test('round robin advances the cursor inside the reservation', async () => {
  const user = await seedUser('rr')
  await seedAccount(user.id, 'r1', 10n ** 9n)
  await seedAccount(user.id, 'r2', 10n ** 9n)
  await seedAccount(user.id, 'r3', 10n ** 9n)
  await prisma.appSetting.update({ where: { id: 1 }, data: { routingMode: 'round_robin' } })
  await reserveUpload(args(user.id, 10n))
  assert.equal((await prisma.appSetting.findUniqueOrThrow({ where: { id: 1 } })).roundRobinCursor, 1)
})

test('a full account is skipped', async () => {
  const user = await seedUser('full')
  const full = await seedAccount(user.id, 'f1', 10n ** 9n, { capBytes: 100n })
  await seedAccount(user.id, 'f2', 10n ** 9n)
  await seedAccount(user.id, 'f3', 10n ** 9n)
  const got = await reserveUpload(args(user.id, 1_000n))
  assert.ok(!got.accounts.some((a) => a.id === full.id))
})

test('initialCapForConnect copies the default for new accounts and keeps the existing cap on reconnect', () => {
  assert.equal(initialCapForConnect(null, 20n), 20n)
  assert.equal(initialCapForConnect(null, null), null)
  assert.equal(initialCapForConnect({ capBytes: 5n }, 20n), 5n)
  assert.equal(initialCapForConnect({ capBytes: null }, 20n), null)
})

test('member availability is the lower of limit remaining and pool usable space', async () => {
  const unlimited = await seedUser('avail-free')
  await seedAccount(unlimited.id, 'v1', 10n ** 9n, { capBytes: 0n })
  await seedAccount(unlimited.id, 'v2', 10n ** 9n, { capBytes: 0n })
  assert.equal((await userAvailable(unlimited.id)).availableBytes, 0n)

  const limited = await seedUser('avail-lim', 10n ** 12n)
  await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  accountIds = []
  await seedAccount(limited.id, 'v3', 4_000n)
  await seedAccount(limited.id, 'v4', 6_000n)
  assert.equal((await userAvailable(limited.id)).availableBytes, 5_000n)

  const small = await seedUser('avail-small', 100n)
  assert.equal((await userAvailable(small.id)).availableBytes, 100n)
})
