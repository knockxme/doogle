import { clearAuthSession, getAccessToken, getRefreshToken, setAccessToken } from '@/lib/auth'

const isProd = import.meta.env.PROD
const rawApiUrl = import.meta.env.VITE_API_URL
export const API_URL = (rawApiUrl && rawApiUrl !== 'http://localhost:4000')
  ? rawApiUrl
  : (isProd ? '/api' : 'http://localhost:4000')


export class ApiError extends Error {
  status: number
  code?: string
  data: Record<string, unknown>
  constructor(status: number, message: string, code?: string, data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.data = data
  }
}

export function errorCode(error: unknown) {
  return error instanceof ApiError ? error.code : undefined
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

type ApiOptions = RequestInit & { skipAuth?: boolean; retry?: boolean }

const REFRESHABLE_401 = new Set(['AUTH_INVALID_TOKEN', 'AUTH_SESSION_EXPIRED', 'AUTH_REQUIRED'])

/** True when a 401 means the access token is bad (or the body had no code). Other 401s, like a wrong password, are plain errors. */
export function isTokenFailure(code: unknown) {
  return typeof code !== 'string' || REFRESHABLE_401.has(code)
}

export async function refreshAccessToken() {
  const refreshToken = getRefreshToken()
  if (!refreshToken) return false
  const response = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
  if (!response.ok) return false
  const data = await response.json() as { accessToken: string }
  setAccessToken(data.accessToken)
  return true
}

export async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers)
  const token = getAccessToken()
  if (!options.skipAuth && token) headers.set('Authorization', `Bearer ${token}`)
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const response = await fetch(`${API_URL}${path}`, { ...options, headers })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText })) as Record<string, unknown>
    const tokenFailure = response.status === 401 && isTokenFailure(error.code)
    if (tokenFailure && options.retry !== false && !options.skipAuth && await refreshAccessToken()) {
      return apiFetch<T>(path, { ...options, retry: false })
    }
    if (tokenFailure && !options.skipAuth) clearAuthSession()
    throw new ApiError(response.status, typeof error.message === 'string' ? error.message : 'Request failed', typeof error.code === 'string' ? error.code : undefined, error)
  }

  return response.json() as Promise<T>
}

export function formatBytes(input: string | number | bigint | null | undefined) {
  if (input === null || input === undefined) return '--'
  const bytes = Number(input)
  if (!Number.isFinite(bytes)) return '--'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
