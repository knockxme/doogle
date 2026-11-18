import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { prisma } from '../../src/config/prisma.js'
import { countFilesMissingCopy, repairIdle, startRepair } from '../../src/modules/admin/repair.js'
import { memoryProvider, resetMemoryProvider } from '../../src/modules/storage/memory-provider.js'
import { userAvailable } from '../../src/modules/storage/pool.js'
import { setTestProvider } from '../../src/modules/storage/provider.js'
import { startEncryptedUpload, writeEncryptedChunk } from '../../src/modules/uploads/encrypted-upload.js'
import { hashPassword } from '../../src/utils/password.js'

const run = randomUUID().slice(0, 8)
let userId = ''
const accountIds: string[] = []
const setCopies = (copiesPerFile: number) => prisma.appSetting.upsert({ where: { id: 1 }, create: { id: 1, priorityAccountIds: [], copiesPerFile }, update: { copiesPerFile } })

before(async () => {
  setTestProvider(memoryProvider)
  resetMemoryProvider()
  // Other test files leave accounts behind only by mistake; this file needs to know the whole pool.
  const user = await prisma.user.create({ data: { name: 'copies', email: `copies-${run}@test.local`, passwordHash: await hashPassword('password-123') } })
  userId = user.id
  for (const tag of ['c-a', 'c-b']) {
    const account = await prisma.connectedAccount.create({ data: { userId, provider: 's3', providerAccountId: `${tag}-${run}`, email: `${tag}@copies.test`, scopes: [] } })
    await prisma.storageAccount.create({ data: { connectedAccountId: account.id, totalBytes: 10n ** 9n, usedBytes: 0n, availableBytes: 10n ** 9n, lastSyncedAt: new Date() } })
    accountIds.push(account.id)
  }
})

after(async () => {
  await setCopies(2)
  await prisma.file.deleteMany({ where: { userId } })
  await prisma.uploadSession.deleteMany({ where: { userId } })
  await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.user.deleteMany({ where: { id: userId } })
  setTestProvider(null)
  await prisma.$disconnect()
})

async function upload(name: string) {
  const data = randomBytes(4000)
  const session = await startEncryptedUpload({ userId, plainSize: BigInt(data.length), fileName: name, mimeType: 'application/octet-stream', folderId: null })
  const result = await writeEncryptedChunk(session.id, 0n, data)
  return prisma.file.findUniqueOrThrow({ where: { id: result.file!.id }, include: { replicas: true } })
}

test('with the second copy off, a file is stored once and all free space is usable', async () => {
  await setCopies(2)
  const both = (await userAvailable(userId)).availableBytes
  await setCopies(1)
  const one = (await userAvailable(userId)).availableBytes
  assert.ok(both !== null && one !== null)
  assert.ok(one! >= both! * 2n - 2n, `one copy: ${one}, two copies: ${both}`)
  const file = await upload('single.bin')
  assert.equal(file.replicas.length, 1)
  assert.equal(await countFilesMissingCopy(), 0, 'one copy is enough while the second copy is off')
})

test('turning the second copy back on lets Repair add it', async () => {
  await setCopies(1)
  const file = await upload('later.bin')
  assert.equal(file.replicas.length, 1)
  await setCopies(2)
  assert.ok((await countFilesMissingCopy()) >= 1)
  await startRepair()
  await repairIdle()
  const after = await prisma.fileReplica.findMany({ where: { fileId: file.id, status: 'healthy' } })
  assert.equal(after.length, 2)
  assert.notEqual(after[0]!.connectedAccountId, after[1]!.connectedAccountId)
})

test('with the second copy on, uploads still get two copies', async () => {
  await setCopies(2)
  const file = await upload('pair.bin')
  assert.equal(file.replicas.length, 2)
})
