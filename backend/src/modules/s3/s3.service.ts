import { DeleteObjectCommand, HeadBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import type { ConnectedAccount, File, S3StorageConfig } from '@prisma/client'
import type { Readable } from 'node:stream'
import { prisma } from '../../config/prisma.js'
import { decryptText } from '../../utils/crypto.js'

type S3Config = S3StorageConfig
type FileWithAccount = Omit<File, 'wrappedFileKey' | 'encryptedSizeBytes'> & { connectedAccount: ConnectedAccount }

export function createS3Client(config: S3Config) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint ?? undefined,
    forcePathStyle: config.forcePathStyle || Boolean(config.endpoint),
    credentials: {
      accessKeyId: decryptText(config.accessKeyIdEncrypted),
      secretAccessKey: decryptText(config.secretAccessKeyEncrypted),
    },
  })
}

export async function getS3ConfigForAccount(accountId: string, userId?: string) {
  return prisma.s3StorageConfig.findFirstOrThrow({ where: { connectedAccountId: accountId, status: 'active', ...(userId ? { userId } : {}) } })
}

export async function testS3Connection(config: S3Config) {
  const client = createS3Client(config)
  await client.send(new HeadBucketCommand({ Bucket: config.bucket }))
}

export function buildBlobKey(config: Pick<S3Config, 'prefix'>, blobName: string) {
  return `${config.prefix.replace(/^\/+|\/+$/g, '')}/${blobName}`
}

export async function uploadS3Object(config: S3Config, key: string, body: NodeJS.ReadableStream, mimeType: string) {
  const client = createS3Client(config)
  await new Upload({
    client,
    params: { Bucket: config.bucket, Key: key, Body: body as Readable, ContentType: mimeType },
  }).done()
}

export async function deleteS3Object(file: FileWithAccount) {
  const config = await getS3ConfigForAccount(file.connectedAccountId)
  const client = createS3Client(config)
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: file.providerFileId }))
}

export async function syncS3Quota(accountId: string) {
  const config = await getS3ConfigForAccount(accountId)
  const client = createS3Client(config)
  let usedBytes = 0n
  let continuationToken: string | undefined
  do {
    const response = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, ContinuationToken: continuationToken }))
    for (const object of response.Contents ?? []) usedBytes += BigInt(object.Size ?? 0)
    continuationToken = response.NextContinuationToken
  } while (continuationToken)

  return prisma.storageAccount.upsert({
    where: { connectedAccountId: accountId },
    create: {
      connectedAccountId: accountId,
      totalBytes: config.quotaBytes,
      usedBytes,
      availableBytes: config.quotaBytes === null ? null : config.quotaBytes - usedBytes,
      lastSyncedAt: new Date(),
    },
    update: {
      totalBytes: config.quotaBytes,
      usedBytes,
      availableBytes: config.quotaBytes === null ? null : config.quotaBytes - usedBytes,
      lastSyncedAt: new Date(),
    },
  })
}
