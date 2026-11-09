import type { ConnectedAccount } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { ProviderUnavailableError, type ReplicaUploadState, type StorageProvider } from './provider.js'

const blobs = new Map<string, Map<string, Buffer>>()
const pending = new Map<string, Map<string, Buffer>>()

export const memoryTestHooks = {
  /** One-shot: next putChunk commits only this many bytes, then throws. */
  partialCommit: null as bigint | null,
  failPutChunk: new Set<string>(),
  failReadRange: new Set<string>(),
}

function bucket(map: Map<string, Map<string, Buffer>>, accountId: string) {
  let m = map.get(accountId)
  if (!m) map.set(accountId, (m = new Map()))
  return m
}

export function resetMemoryProvider() {
  blobs.clear()
  pending.clear()
  memoryTestHooks.partialCommit = null
  memoryTestHooks.failPutChunk.clear()
  memoryTestHooks.failReadRange.clear()
}

export function getBlob(accountId: string, providerFileId: string): Buffer | undefined {
  return blobs.get(accountId)?.get(providerFileId)
}

function fileId(state: ReplicaUploadState) {
  if (!state.providerFileId) throw new Error('Upload state has no providerFileId.')
  return state.providerFileId
}

export const memoryProvider: StorageProvider = {
  async beginUpload(account: ConnectedAccount) {
    const id = randomUUID()
    bucket(pending, account.id).set(id, Buffer.alloc(0))
    return { providerFileId: id, sessionUri: `memory://${id}` }
  },
  async putChunk(account, state, offset, chunk, totalSize) {
    if (memoryTestHooks.failPutChunk.has(account.id)) throw new Error('Simulated putChunk failure.')
    const id = fileId(state)
    const buf = bucket(pending, account.id).get(id)
    if (!buf) throw new ProviderUnavailableError('Upload session not found.', true)
    if (offset !== BigInt(buf.length)) throw new Error(`Wrong offset ${offset}; committed is ${buf.length}.`)
    if (offset + BigInt(chunk.length) > totalSize) throw new Error('Chunk exceeds total size.')
    if (memoryTestHooks.partialCommit !== null) {
      const n = Number(memoryTestHooks.partialCommit)
      memoryTestHooks.partialCommit = null
      bucket(pending, account.id).set(id, Buffer.concat([buf, chunk.subarray(0, n)]))
      throw new Error('Simulated partial commit.')
    }
    const next = Buffer.concat([buf, chunk])
    const complete = BigInt(next.length) === totalSize
    if (complete) {
      bucket(pending, account.id).delete(id)
      bucket(blobs, account.id).set(id, next)
    } else bucket(pending, account.id).set(id, next)
    return { state: { ...state }, complete }
  },
  async committedOffset(account, state, totalSize) {
    const id = fileId(state)
    if (bucket(blobs, account.id).has(id)) return totalSize
    const buf = bucket(pending, account.id).get(id)
    if (!buf) throw new ProviderUnavailableError('Upload session not found.', true)
    return BigInt(buf.length)
  },
  async abortUpload(account, state) {
    bucket(pending, account.id).delete(fileId(state))
  },
  async readRange(account, providerFileId, start, end) {
    if (memoryTestHooks.failReadRange.has(account.id)) throw new Error('Simulated readRange failure.')
    const blob = bucket(blobs, account.id).get(providerFileId)
    if (!blob) throw new ProviderUnavailableError('Blob not found.', true)
    return Readable.from([blob.subarray(Number(start), Number(end) + 1)])
  },
  async deleteBlob(account, providerFileId) {
    bucket(blobs, account.id).delete(providerFileId)
  },
}
