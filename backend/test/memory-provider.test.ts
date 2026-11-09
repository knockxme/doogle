import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import type { ConnectedAccount } from '@prisma/client'
import { memoryProvider, memoryTestHooks, getBlob, resetMemoryProvider } from '../src/modules/storage/memory-provider.js'
import { ProviderUnavailableError, providerFor, setTestProvider } from '../src/modules/storage/provider.js'

const acct = (id: string) => ({ id, provider: 'google_drive' }) as unknown as ConnectedAccount
const A = acct('a')
const KiB = 1024n
async function drain(r: AsyncIterable<Buffer | string>) {
  const out: Buffer[] = []
  for await (const c of r) out.push(Buffer.from(c))
  return Buffer.concat(out)
}

describe('memory provider', () => {
  beforeEach(() => { resetMemoryProvider(); setTestProvider(null) })

  it('rejects putChunk at wrong offset', async () => {
    const st = await memoryProvider.beginUpload(A, 'x.bin', 10n)
    await assert.rejects(memoryProvider.putChunk(A, st, 5n, Buffer.alloc(5), 10n))
  })

  it('completes sequential chunks at totalSize and reports progress', async () => {
    let st = await memoryProvider.beginUpload(A, 'x.bin', 10n)
    let r = await memoryProvider.putChunk(A, st, 0n, Buffer.from('01234'), 10n)
    assert.equal(r.complete, false)
    st = r.state
    assert.equal(await memoryProvider.committedOffset(A, st, 10n), 5n)
    r = await memoryProvider.putChunk(A, st, 5n, Buffer.from('56789'), 10n)
    assert.equal(r.complete, true)
    assert.equal(await memoryProvider.committedOffset(A, r.state, 10n), 10n)
    assert.equal(getBlob('a', r.state.providerFileId!)?.toString(), '0123456789')
  })

  it('readRange is inclusive', async () => {
    let st = await memoryProvider.beginUpload(A, 'x.bin', 10n)
    st = (await memoryProvider.putChunk(A, st, 0n, Buffer.from('0123456789'), 10n)).state
    assert.equal((await drain(await memoryProvider.readRange(A, st.providerFileId!, 2n, 4n))).toString(), '234')
  })

  it('deleteBlob then read throws ProviderUnavailableError notFound', async () => {
    let st = await memoryProvider.beginUpload(A, 'x.bin', 3n)
    st = (await memoryProvider.putChunk(A, st, 0n, Buffer.from('abc'), 3n)).state
    await memoryProvider.deleteBlob(A, st.providerFileId!)
    await assert.rejects(memoryProvider.readRange(A, st.providerFileId!, 0n, 1n), (e: unknown) => e instanceof ProviderUnavailableError && e.notFound)
  })

  it('simulated partial commit leaves committedOffset on 256 KiB multiple', async () => {
    const total = 1024n * KiB
    const st = await memoryProvider.beginUpload(A, 'x.bin', total)
    memoryTestHooks.partialCommit = 256n * KiB
    const chunk = Buffer.alloc(Number(512n * KiB))
    await assert.rejects(memoryProvider.putChunk(A, st, 0n, chunk, total))
    const off = await memoryProvider.committedOffset(A, st, total)
    assert.equal(off, 256n * KiB)
    assert.equal(off % (256n * KiB), 0n)
    assert.ok(off < BigInt(chunk.length))
    const r = await memoryProvider.putChunk(A, st, off, Buffer.alloc(Number(total - off)), total)
    assert.equal(r.complete, true)
  })

  it('failure hooks apply per account', async () => {
    const st = await memoryProvider.beginUpload(A, 'x.bin', 3n)
    memoryTestHooks.failPutChunk.add('a')
    await assert.rejects(memoryProvider.putChunk(A, st, 0n, Buffer.from('abc'), 3n))
    const B = acct('b')
    const sb = await memoryProvider.beginUpload(B, 'y.bin', 3n)
    await memoryProvider.putChunk(B, sb, 0n, Buffer.from('abc'), 3n)
    memoryTestHooks.failReadRange.add('b')
    await assert.rejects(memoryProvider.readRange(B, sb.providerFileId!, 0n, 1n))
  })

  it('providerFor returns test provider when set', () => {
    setTestProvider(memoryProvider)
    assert.equal(providerFor({ provider: 'google_drive' }), memoryProvider)
  })
})
