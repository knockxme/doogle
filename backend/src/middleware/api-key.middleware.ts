import type { NextFunction, Request, Response } from 'express'
import { prisma } from '../config/prisma.js'
import { hashToken } from '../utils/crypto.js'

export type ApiKeyRequest = Request & {
  user?: { id: string; sessionId: string; role: string }
  apiKey?: { id: string; scopes: string[] }
}

function normalizeScopes(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export type ApiKeyCheck =
  | { ok: true; user: { id: string; email: string; role: string; davEnabled: boolean }; apiKey: { id: string; scopes: string[] } }
  | { ok: false; status: number; code: string; message: string }

/** The one place an API key is checked: hash, status, expiry, scope, and the owner's status. Records last use. */
export async function verifyApiKey(rawKey: string, scope: string): Promise<ApiKeyCheck> {
  const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: hashToken(rawKey) } })
  if (!apiKey || apiKey.status !== 'active' || apiKey.revokedAt || (apiKey.expiresAt && apiKey.expiresAt <= new Date())) return { ok: false, status: 401, code: 'API_KEY_INVALID', message: 'Invalid API key.' }
  const scopes = normalizeScopes(apiKey.scopes)
  if (!scopes.includes(scope)) return { ok: false, status: 403, code: 'API_KEY_FORBIDDEN', message: 'API key does not have required scope.' }
  const user = await prisma.user.findUnique({ where: { id: apiKey.userId }, select: { id: true, email: true, role: true, status: true, mustChangePassword: true, davEnabled: true } })
  if (!user) return { ok: false, status: 401, code: 'API_KEY_INVALID', message: 'Invalid API key.' }
  if (user.status !== 'active') return { ok: false, status: 403, code: 'USER_DISABLED', message: 'This account is disabled.' }
  if (user.mustChangePassword) return { ok: false, status: 403, code: 'PASSWORD_CHANGE_REQUIRED', message: 'Password change required.' }
  await prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined)
  return { ok: true, user: { id: user.id, email: user.email, role: user.role, davEnabled: user.davEnabled }, apiKey: { id: apiKey.id, scopes } }
}

export function requireApiKey(scope: string) {
  return async (req: ApiKeyRequest, res: Response, next: NextFunction) => {
    try {
      const header = req.header('Authorization')
      if (!header?.startsWith('Bearer ')) return res.status(401).json({ code: 'API_KEY_REQUIRED', message: 'API key required.' })
      const check = await verifyApiKey(header.slice(7).trim(), scope)
      if (!check.ok) return res.status(check.status).json({ code: check.code, message: check.message })
      req.user = { id: check.user.id, sessionId: `api-key:${check.apiKey.id}`, role: check.user.role }
      req.apiKey = check.apiKey
      return next()
    } catch {
      return res.status(401).json({ code: 'API_KEY_INVALID', message: 'Invalid API key.' })
    }
  }
}
