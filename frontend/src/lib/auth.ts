export type AuthUser = {
  id: string
  name: string
  email: string
  status?: string
  role?: 'admin' | 'member'
  mustChangePassword?: boolean
}

const ACCESS_TOKEN_KEY = 'doogle.accessToken'
const REFRESH_TOKEN_KEY = 'doogle.refreshToken'
const USER_KEY = 'doogle.user'

export function getAccessToken() {
  return localStorage.getItem(ACCESS_TOKEN_KEY)
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_TOKEN_KEY)
}

export function getStoredUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY)
  return raw ? JSON.parse(raw) as AuthUser : null
}

export function setAuthSession(accessToken: string, refreshToken: string, user: AuthUser) {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken)
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function updateStoredUser(user: AuthUser) {
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function setAccessToken(accessToken: string) {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken)
}

export function clearAuthSession() {
  localStorage.removeItem(ACCESS_TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

export function isAdmin(user: AuthUser | null = getStoredUser()) {
  return user?.role === 'admin'
}
