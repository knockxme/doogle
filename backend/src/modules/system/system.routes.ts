import { Router, type Request } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { requireAdmin } from '../../middleware/admin.middleware.js'
import { prisma } from '../../config/prisma.js'
import { decryptText, encryptText } from '../../utils/crypto.js'

export const systemRouter = Router()

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]

/** The callback address as the browser sees it. nginx sends X-Forwarded-Prefix (/api) because it strips that prefix. */
function defaultRedirectUri(req: Request) {
  const prefix = req.get('x-forwarded-prefix') ?? ''
  const safePrefix = /^(\/[A-Za-z0-9._-]+)*$/.test(prefix) ? prefix : ''
  return `${req.protocol}://${req.get('host')}${safePrefix}/connected-accounts/google/callback`
}

systemRouter.get('/google-config', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const config = await prisma.providerConfig.findFirst({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      orderBy: { createdAt: 'desc' }
    })

    const defaultRedirect = defaultRedirectUri(req)

    if (!config) {
      return res.json({
        exists: false,
        defaultRedirectUri: defaultRedirect
      })
    }

    let clientId = ''
    try {
      clientId = decryptText(config.clientIdEncrypted)
    } catch {
      clientId = ''
    }

    return res.json({
      exists: true,
      clientId,
      redirectUri: config.redirectUri,
      hasSecret: !!config.clientSecretEncrypted,
      defaultRedirectUri: defaultRedirect
    })
  } catch (error) {
    return next(error)
  }
})

const googleConfigSchema = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().optional(),
  redirectUri: z.string().trim().url().optional().or(z.literal('')),
})

systemRouter.post('/google-config', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const body = googleConfigSchema.parse(req.body)
    const finalRedirectUri = body.redirectUri || defaultRedirectUri(req)

    // A missing secret reuses the current one. Checked before anything changes, so a refusal leaves the working config active.
    let finalSecret = body.clientSecret
    if (!finalSecret) {
      const current = await prisma.providerConfig.findFirst({ where: { userId: null, provider: 'google_drive', status: 'active' }, orderBy: { createdAt: 'desc' } })
      if (current) {
        try {
          finalSecret = decryptText(current.clientSecretEncrypted)
        } catch {
          finalSecret = undefined
        }
      }
    }
    if (!finalSecret) return res.status(400).json({ code: 'BAD_REQUEST', message: 'Client Secret is required for first-time setup.' })

    // Accounts already connected keep the config they were connected with, so disabling the old one does not cut them off.
    const config = await prisma.$transaction(async (tx) => {
      await tx.providerConfig.updateMany({ where: { userId: null, provider: 'google_drive', status: 'active' }, data: { status: 'disabled' } })
      return tx.providerConfig.create({
        data: {
          userId: null,
          provider: 'google_drive',
          clientIdEncrypted: encryptText(body.clientId),
          clientSecretEncrypted: encryptText(finalSecret!),
          redirectUri: finalRedirectUri,
          scopes: GOOGLE_SCOPES,
          status: 'active',
        },
      })
    })

    return res.status(201).json({
      status: 'success',
      message: 'Global Google OAuth configuration updated successfully.',
      id: config.id
    })
  } catch (error) {
    return next(error)
  }
})
