import { Router } from 'express'
import { google } from 'googleapis'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { requireAdmin } from '../../middleware/admin.middleware.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { decryptText, encryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { hashPassword } from '../../utils/password.js'
import { createOAuthClient, syncGoogleQuota } from '../google/google.service.js'
import { syncS3Quota, testS3Connection } from '../s3/s3.service.js'
import { canRemoveAccount } from '../files/delete-blobs.js'
import { failUpload } from '../uploads/encrypted-upload.js'
import { getDefaultCapBytes, initialCapForConnect, syncQuotaForAccount } from '../storage/pool.js'

export const connectedAccountRouter = Router()

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

const s3ConnectSchema = z.object({
  name: z.string().trim().min(1).max(191),
  bucket: z.string().trim().min(1).max(191),
  region: z.string().trim().min(1).max(191),
  endpoint: z.string().url().optional().or(z.literal('')),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  forcePathStyle: z.boolean().optional(),
  quotaBytes: z.string().regex(/^\d+$/).optional().nullable(),
})

connectedAccountRouter.get('/', requireAuth, requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const accounts = await prisma.connectedAccount.findMany({
      where: { status: 'connected' },
      include: { storageAccount: true },
      orderBy: { createdAt: 'desc' },
    })
    const missingQuota = accounts.filter((account) => !account.storageAccount?.lastSyncedAt)
    for (const account of missingQuota) await syncQuotaForAccount(account).catch(() => undefined)

    const syncedAccounts = missingQuota.length > 0
      ? await prisma.connectedAccount.findMany({
        where: { status: 'connected' },
        include: { storageAccount: true },
        orderBy: { createdAt: 'desc' },
      })
      : accounts

    return res.json({
      accounts: syncedAccounts.map(({ accessTokenEncrypted: _a, refreshTokenEncrypted: _r, storageAccount, ...account }) => ({
        ...account,
        capBytes: account.capBytes?.toString() ?? null,
        storageAccount: storageAccount ? {
          ...storageAccount,
          totalBytes: storageAccount.totalBytes?.toString() ?? null,
          usedBytes: storageAccount.usedBytes.toString(),
          availableBytes: storageAccount.availableBytes?.toString() ?? null,
          trashBytes: storageAccount.trashBytes?.toString() ?? null,
        } : null,
      })),
    })
  } catch (error) {
    return next(error)
  }
})

async function createGoogleConnectUrl(req: AuthRequest) {
  const query = z.object({ providerConfigId: z.string().min(1).optional() }).parse(req.query)
  const config = query.providerConfigId
    ? await prisma.providerConfig.findFirstOrThrow({ where: { id: query.providerConfigId, OR: [{ userId: req.user!.id }, { userId: null }], provider: 'google_drive', status: 'active' } })
    : await prisma.providerConfig.findFirstOrThrow({ where: { userId: null, provider: 'google_drive', status: 'active' }, orderBy: { createdAt: 'desc' } })
  const state = randomToken()
  await prisma.oauthState.create({ data: { userId: req.user!.id, providerConfigId: config.id, flow: 'connect', stateHash: hashToken(state), expiresAt: new Date(Date.now() + 10 * 60_000) } })
  const client = createOAuthClient(config)
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: config.scopes as string[],
    state,
  })
}

connectedAccountRouter.post('/s3', requireAuth, requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const body = s3ConnectSchema.parse(req.body)
    const providerAccountId = `${body.bucket}:${body.endpoint || body.region}`
    const existingAccount = await prisma.connectedAccount.findFirst({ where: { provider: 's3', providerAccountId } })
    const defaultCap = await getDefaultCapBytes()
    const account = existingAccount
      ? await prisma.connectedAccount.update({
        where: { id: existingAccount.id },
        data: {
          providerConfigId: null,
          email: `${body.bucket} (S3)`,
          displayName: body.name,
          accessTokenEncrypted: encryptText('s3'),
          refreshTokenEncrypted: encryptText(randomToken()),
          tokenExpiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
          scopes: [],
          status: 'connected',
          lastError: null,
        },
      })
      : await prisma.connectedAccount.create({ data: {
        userId: req.user!.id,
        capBytes: initialCapForConnect(null, defaultCap),
        providerConfigId: null,
        provider: 's3',
        providerAccountId,
        email: `${body.bucket} (S3)`,
        displayName: body.name,
        accessTokenEncrypted: encryptText('s3'),
        refreshTokenEncrypted: encryptText(randomToken()),
        tokenExpiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
        scopes: [],
        status: 'connected',
      } })
    const config = await prisma.s3StorageConfig.upsert({
      where: { connectedAccountId: account.id },
      create: {
        userId: req.user!.id,
        connectedAccountId: account.id,
        name: body.name,
        bucket: body.bucket,
        region: body.region,
        endpoint: body.endpoint || null,
        accessKeyIdEncrypted: encryptText(body.accessKeyId),
        secretAccessKeyEncrypted: encryptText(body.secretAccessKey),
        forcePathStyle: body.forcePathStyle ?? Boolean(body.endpoint),
        quotaBytes: body.quotaBytes ? BigInt(body.quotaBytes) : null,
      },
      update: {
        name: body.name,
        bucket: body.bucket,
        region: body.region,
        endpoint: body.endpoint || null,
        accessKeyIdEncrypted: encryptText(body.accessKeyId),
        secretAccessKeyEncrypted: encryptText(body.secretAccessKey),
        forcePathStyle: body.forcePathStyle ?? Boolean(body.endpoint),
        quotaBytes: body.quotaBytes ? BigInt(body.quotaBytes) : null,
        status: 'active',
      },
    })
    try {
      await testS3Connection(config)
      const quota = await syncS3Quota(account.id)
      return res.status(201).json({
        account: {
          ...account,
          capBytes: account.capBytes?.toString() ?? null,
          storageAccount: { ...quota, totalBytes: quota.totalBytes?.toString() ?? null, usedBytes: quota.usedBytes.toString(), availableBytes: quota.availableBytes?.toString() ?? null, trashBytes: quota.trashBytes?.toString() ?? null },
        },
      })
    } catch (error) {
      if (!existingAccount) await prisma.connectedAccount.delete({ where: { id: account.id } }).catch(() => undefined)
      // The SDK error name (NoSuchBucket, InvalidAccessKeyId, AccessDenied...) is safe to show and tells the admin what to fix.
      const reason = error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : 'unknown error'
      return res.status(400).json({ code: 'S3_CONNECTION_FAILED', message: `Could not use this bucket (${reason}). Check the bucket name, region, endpoint and keys.` })
    }
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.get('/google/connect-url', requireAuth, requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const url = await createGoogleConnectUrl(req)
    return res.json({ url })
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.get('/google/connect', requireAuth, requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const url = await createGoogleConnectUrl(req)
    return res.redirect(url)
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.get('/google/callback', async (req, res, next) => {
  try {
    const query = z.object({ code: z.string(), state: z.string() }).parse(req.query)
    const oauthState = await prisma.oauthState.findUniqueOrThrow({ where: { stateHash: hashToken(query.state) }, include: { providerConfig: true } })
    if (oauthState.flow !== 'connect') return res.status(400).json({ code: 'GOOGLE_OAUTH_FLOW_INVALID', message: 'Unsupported OAuth flow.' })
    if (oauthState.usedAt || oauthState.expiresAt < new Date()) return res.status(400).json({ code: 'GOOGLE_OAUTH_STATE_INVALID', message: 'OAuth state expired.' })
    const client = createOAuthClient(oauthState.providerConfig)
    const tokenResult = await client.getToken(query.code)
    const tokens = tokenResult.tokens
    if (!tokens.access_token) return res.status(400).json({ code: 'GOOGLE_OAUTH_FAILED', message: 'Google did not return required tokens.' })
    // Google lets the user untick the Drive box on the consent screen. Without it no upload can work.
    if (tokens.scope && !tokens.scope.split(' ').includes(DRIVE_FILE_SCOPE)) return res.redirect(`${env.FRONTEND_URL}/google-connected?status=error&reason=scope`)
    client.setCredentials(tokens)
    const oauth2 = google.oauth2({ version: 'v2', auth: client })
    const profile = await oauth2.userinfo.get()
    const providerAccountId = profile.data.id
    const email = profile.data.email
    if (!providerAccountId || !email) return res.status(400).json({ code: 'GOOGLE_PROFILE_FAILED', message: 'Google profile missing id or email.' })

    if (oauthState.flow !== 'connect' || !oauthState.userId) return res.status(400).json({ code: 'GOOGLE_OAUTH_STATE_INVALID', message: 'OAuth state expired.' })
    const existingAccount = await prisma.connectedAccount.findFirst({ where: { provider: 'google_drive', providerAccountId } })
    const defaultCap = await getDefaultCapBytes()
    const refreshTokenEncrypted = tokens.refresh_token ? encryptText(tokens.refresh_token) : existingAccount?.refreshTokenEncrypted
    if (!refreshTokenEncrypted) return res.status(400).json({ code: 'GOOGLE_OAUTH_FAILED', message: 'Google did not return required tokens.' })

    const common = {
      providerConfigId: oauthState.providerConfigId,
      email,
      displayName: profile.data.name,
      avatarUrl: profile.data.picture,
      accessTokenEncrypted: encryptText(tokens.access_token),
      refreshTokenEncrypted,
      tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
      scopes: oauthState.providerConfig.scopes as string[],
      status: 'connected',
      lastError: null,
    }
    // A reconnect keeps the account's owner and cap; only a new account takes the install default.
    const account = existingAccount
      ? await prisma.connectedAccount.update({ where: { id: existingAccount.id }, data: common })
      : await prisma.connectedAccount.create({ data: { ...common, userId: oauthState.userId, provider: 'google_drive', providerAccountId, capBytes: initialCapForConnect(null, defaultCap) } })
    await prisma.oauthState.update({ where: { id: oauthState.id }, data: { usedAt: new Date() } })
    await syncGoogleQuota(account.id)
    return res.redirect(`${env.FRONTEND_URL}/google-connected?status=success`)
  } catch (error) {
    console.error('Google OAuth callback failed:', error instanceof Error ? error.name : 'unknown error')
    return res.redirect(`${env.FRONTEND_URL}/google-connected?status=error`)
  }
})

connectedAccountRouter.post('/:id/sync-quota', requireAuth, requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.id)
    const account = await prisma.connectedAccount.findFirstOrThrow({ where: { id: accountId } })
    const quota = await syncQuotaForAccount(account)
    return res.json({
      quota: {
        ...quota,
        totalBytes: quota.totalBytes?.toString() ?? null,
        usedBytes: quota.usedBytes.toString(),
        availableBytes: quota.availableBytes?.toString() ?? null,
        trashBytes: quota.trashBytes?.toString() ?? null,
      },
    })
  } catch (error) {
    return next(error)
  }
})

/**
 * Files that have a copy on this account and no usable copy (healthy, on a connected account) anywhere else.
 * Matches Repair's notion of a usable copy, so removing the account never takes the last one.
 */
function countSoleCopies(db: Prisma.TransactionClient | typeof prisma, accountId: string): Promise<number> {
  return db.file.count({
    where: {
      status: { not: 'purged' },
      replicas: {
        some: { connectedAccountId: accountId },
        none: { connectedAccountId: { not: accountId }, status: 'healthy', connectedAccount: { status: 'connected' } },
      },
    },
  })
}

connectedAccountRouter.delete('/:id', requireAuth, requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.id)
    const account = await prisma.connectedAccount.findUnique({ where: { id: accountId }, select: { id: true } })
    if (!account) return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' })
    await prisma.appSetting.upsert({ where: { id: 1 }, create: { id: 1, priorityAccountIds: [] }, update: {} })
    const refuse = (count: number) => res.status(409).json({ code: 'ACCOUNT_HOLDS_SOLE_COPY', message: `${count} file(s) have no usable copy on another account. Repair them onto another account first.`, files: count })
    // Fast refusal before any upload is touched; the authoritative check runs again under the lock below.
    const early = await countSoleCopies(prisma, accountId)
    if (!canRemoveAccount(early)) return refuse(early)
    // Uploads writing to this account can no longer finish.
    const sessions = await prisma.uploadSession.findMany({ where: { status: 'uploading', replicas: { some: { connectedAccountId: accountId } } }, select: { id: true } })
    for (const session of sessions) await failUpload(session.id, 'Storage account was removed.').catch(() => undefined)
    // Check and deletes run in one transaction under the app_settings lock, which every reservation also takes.
    const soleCopies = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM app_settings WHERE id = 1 FOR UPDATE`
      const count = await countSoleCopies(tx, accountId)
      if (!canRemoveAccount(count)) return count
      // A session reserved on this account after the scan above cannot finish either.
      await tx.uploadSession.updateMany({ where: { status: 'uploading', replicas: { some: { connectedAccountId: accountId } } }, data: { status: 'failed', errorMessage: 'Storage account was removed.' } })
      // Only replica rows go; File rows and the blobs in the provider account are left alone.
      await tx.fileReplica.deleteMany({ where: { connectedAccountId: accountId } })
      await tx.uploadSessionReplica.deleteMany({ where: { connectedAccountId: accountId } })
      await tx.connectedAccount.delete({ where: { id: accountId } })
      return 0
    }, { timeout: 15_000, maxWait: 15_000 })
    if (!canRemoveAccount(soleCopies)) return refuse(soleCopies)
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})
