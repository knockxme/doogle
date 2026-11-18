import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { prisma } from '../../src/config/prisma.js'
import { countFilesMissingCopy, repairIdle, startRepair, sweepCopyChecks, verifyCopies } from '../../src/modules/admin/repair.js'
import { memoryProvider, resetMemoryProvider } from '../../src/modules/storage/memory-provider.js'
import { setTestProvider } from '../../src/modules/storage/provider.js'
import { startEncryptedUpload, writeEncryptedChunk } from '../../src/modules/uploads/encrypted-upload.js'
import { hashPassword } from '../../src/utils/password.js'

const run = randomUUID().slice(0, 8)
let userId = ''
const accountIds: string[] = []

before(async () => {
  setTestProvider(memoryProvider)
  resetMemoryProvider()
  const user = await prisma.user.create({ data: { name: 'verify', email: `verify-${run}@test.local`, passwordHash: await hashPassword('password-123') } })
  userId = user.id
  for (const tag of ['v-a', 'v-b']) {
    const account = await prisma.connectedAccount.create({ data: { userId, provider: 's3', providerAccountId: `${tag}-${run}`, email: `${tag}@verify.test`, scopes: [] } })
    await prisma.storageAccount.create({ data: { connectedAccountId: account.id, totalBytes: 10n ** 12n, usedBytes: 0n, availableBytes: 10n ** 12n, lastSyncedAt: new Date() } })
    accountIds.push(account.id)
  }
})

after(async () => {
  await prisma.file.deleteMany({ where: { userId } })
  await prisma.uploadSession.deleteMany({ where: { userId } })
  await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.user.deleteMany({ where: { id: userId } })
  setTestProvider(null)
  await prisma.$disconnect()
})

async function upload(name: string) {
  const data = randomBytes(5000)
  const session = await startEncryptedUpload({ userId, plainSize: BigInt(data.length), fileName: name, mimeType: 'application/octet-stream', folderId: null })
  const result = await writeEncryptedChunk(session.id, 0n, data)
  return prisma.file.findUniqueOrThrow({ where: { id: result.file!.id }, include: { replicas: true } })
}

test('a copy deleted behind the app is found without anyone reading the file', async () => {
  const file = await upload('unwatched.bin')
  const gone = file.replicas[0]!
  await memoryProvider.deleteBlob({ id: gone.connectedAccountId } as never, gone.providerFileId)
  const before = await countFilesMissingCopy()
  // New copies count as checked when written; a check that ignores age finds the loss.
  const result = await verifyCopies({ olderThanMs: 0 })
  assert.ok(result.lost >= 1)
  assert.equal((await prisma.fileReplica.findUniqueOrThrow({ where: { id: gone.id } })).status, 'lost')
  assert.equal(await countFilesMissingCopy(), before + 1)
  const kept = await prisma.fileReplica.findUniqueOrThrow({ where: { id: file.replicas[1]!.id } })
  assert.equal(kept.status, 'healthy')
  assert.ok(kept.lastVerifiedAt)
})

test('the hourly check skips copies checked within the week and checks old ones', async () => {
  const file = await upload('weekly.bin')
  const [a, b] = file.replicas
  await prisma.fileReplica.update({ where: { id: a!.id }, data: { lastVerifiedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } })
  const recent = (await prisma.fileReplica.findUniqueOrThrow({ where: { id: b!.id } })).lastVerifiedAt!
  await sweepCopyChecks()
  assert.ok((await prisma.fileReplica.findUniqueOrThrow({ where: { id: a!.id } })).lastVerifiedAt!.getTime() > Date.now() - 60_000)
  assert.equal((await prisma.fileReplica.findUniqueOrThrow({ where: { id: b!.id } })).lastVerifiedAt!.getTime(), recent.getTime())
})

test('Repair checks every copy, including ones written today, before rebuilding', async () => {
  const file = await upload('fresh.bin')
  const gone = file.replicas[1]!
  await memoryProvider.deleteBlob({ id: gone.connectedAccountId } as never, gone.providerFileId)
  const job = await startRepair()
  await repairIdle()
  assert.equal((await prisma.fileReplica.findUniqueOrThrow({ where: { id: gone.id } })).status, 'lost')
  const done = await prisma.repairJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(done.status, 'completed')
  assert.ok(done.processed >= 1)
})
