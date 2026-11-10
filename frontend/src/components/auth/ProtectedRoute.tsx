import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { getAccessToken, getStoredUser } from '@/lib/auth'

export function ProtectedRoute() {
  const location = useLocation()
  if (!getAccessToken()) return <Navigate to="/login" replace />
  if (getStoredUser()?.mustChangePassword && location.pathname !== '/change-password') return <Navigate to="/change-password" replace />
  return <Outlet />
}
