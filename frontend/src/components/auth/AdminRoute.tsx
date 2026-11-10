import { Navigate, Outlet } from 'react-router-dom'
import { getStoredUser, isAdmin } from '@/lib/auth'

export function AdminRoute() {
  return isAdmin(getStoredUser()) ? <Outlet /> : <Navigate to="/all-files" replace />
}
