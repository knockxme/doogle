import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  UploadPartCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import type { ConnectedAccount, S3StorageConfig } from '@prisma/client'
import { Readable } from 'node:stream'
import { buildBlobKey, createS3Client, getS3ConfigForAccount } from '../s3/s3.service.js'
import { ProviderUnavailableError, type StorageProvider } from './provider.js'

const PART_SIZE = 8n * 1024n * 1024n

async function ctx(account: ConnectedAccount): Promise<{ client: S3Client; config: S3StorageConfig }> {
  const config = await getS3ConfigForAccount(account.id)
  return { client: createS3Client(config), config }
}

function mapError(error: unknown): never {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  const status = e.$metadata?.httpStatusCode
  if (e.name === 'NoSuchKey' || e.name === 'NoSuchUpload' || e.name === 'NotFound' || status === 404) {
    throw new ProviderUnavailableError('S3 object or upload not found.', true)
  }
  if (status === 401 || status === 403) throw new ProviderUnavailableError('S3 access denied.', false)
  throw error
}

async function listAllParts(client: S3Client, bucket: string, key: string, uploadId: string) {
  const parts: { PartNumber: number; ETag: string; Size: number }[] = []
  let marker: string | undefined
  do {
    const res = await client.send(new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }))
    for (const p of res.Parts ?? []) parts.push({ PartNumber: p.PartNumber!, ETag: p.ETag!, Size: Number(p.Size ?? 0) })
    marker = res.IsTruncated ? String(res.NextPartNumberMarker) : undefined
  } while (marker)
  return parts.sort((a, b) => a.PartNumber - b.PartNumber)
}

export const s3Provider: StorageProvider = {
  async beginUpload(account, blobName) {
    const { client, config } = await ctx(account)
    const key = buildBlobKey(config, blobName)
    try {
      const res = await client.send(new CreateMultipartUploadCommand({ Bucket: config.bucket, Key: key, ContentType: 'application/octet-stream' }))
      if (!res.UploadId) throw new Error('S3 did not return an upload id.')
      return { s3UploadId: res.UploadId, providerFileId: key, partEtags: [] }
    } catch (error) {
      return mapError(error)
    }
  },

  async putChunk(account, state, offset, chunk, totalSize) {
    if (!state.s3UploadId || !state.providerFileId) throw new Error('Upload state is incomplete.')
    if (offset % PART_SIZE !== 0n) throw new Error('S3 chunk offset must be a multiple of 8 MiB.')
    const { client, config } = await ctx(account)
    const partNumber = Number(offset / PART_SIZE) + 1
    try {
      const res = await client.send(new UploadPartCommand({
        Bucket: config.bucket, Key: state.providerFileId, UploadId: state.s3UploadId, PartNumber: partNumber, Body: chunk, ContentLength: chunk.length,
      }))
      const etags = [...(state.partEtags ?? [])]
      etags[partNumber - 1] = res.ETag ?? ''
      const next = { ...state, partEtags: etags }
      if (offset + BigInt(chunk.length) < totalSize) return { state: next, complete: false }

      const parts = await listAllParts(client, config.bucket, state.providerFileId, state.s3UploadId)
      await client.send(new CompleteMultipartUploadCommand({
        Bucket: config.bucket,
        Key: state.providerFileId,
        UploadId: state.s3UploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })) },
      }))
      return { state: next, complete: true }
    } catch (error) {
      return mapError(error)
    }
  },

  async committedOffset(account, state, totalSize) {
    if (!state.s3UploadId || !state.providerFileId) throw new Error('Upload state is incomplete.')
    const { client, config } = await ctx(account)
    try {
      const parts = await listAllParts(client, config.bucket, state.providerFileId, state.s3UploadId)
      let sum = 0n
      let expected = 1
      for (const p of parts) {
        if (p.PartNumber !== expected) break
        sum += BigInt(p.Size)
        expected += 1
      }
      return sum > totalSize ? totalSize : sum
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchUpload') {
        // Upload may already have been completed.
        try {
          await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: state.providerFileId }))
          return totalSize
        } catch (headError) {
          return mapError(headError)
        }
      }
      return mapError(error)
    }
  },

  async abortUpload(account, state) {
    if (!state.s3UploadId || !state.providerFileId) return
    const { client, config } = await ctx(account)
    try {
      await client.send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: state.providerFileId, UploadId: state.s3UploadId }))
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchUpload') return
      mapError(error)
    }
  },

  async readRange(account, providerFileId, start, end) {
    const { client, config } = await ctx(account)
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: providerFileId, Range: `bytes=${start}-${end}` }))
      if (!res.Body) throw new Error('S3 returned an empty body.')
      return res.Body as Readable
    } catch (error) {
      return mapError(error)
    }
  },

  async deleteBlob(account, providerFileId) {
    const { client, config } = await ctx(account)
    try {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: providerFileId }))
    } catch (error) {
      mapError(error)
    }
  },
}
