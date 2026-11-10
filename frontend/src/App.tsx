import { Navigate, Route, Routes } from 'react-router-dom'
import { ProtectedRoute } from '@/components/auth/ProtectedRoute'
import { DriveLayout } from '@/layouts/DriveLayout'
import { AllFilesPage } from '@/pages/AllFilesPage'
import { ArchivedPage } from '@/pages/ArchivedPage'
import { LoginPage } from '@/pages/LoginPage'
import { GoogleConnectedPage } from '@/pages/GoogleConnectedPage'
import { AdminRoute } from '@/components/auth/AdminRoute'
import { AdminStoragePage } from '@/pages/AdminStoragePage'
import { AdminUsersPage } from '@/pages/AdminUsersPage'
import { ChangePasswordPage } from '@/pages/ChangePasswordPage'
import { RecentPage } from '@/pages/RecentPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { SharedPage } from '@/pages/SharedPage'
import { StarredPage } from '@/pages/StarredPage'
import { PublicFilePage } from '@/pages/PublicFilePage'
import { ApiManagementPage } from '@/pages/ApiManagementPage'
import { TrashPage } from '@/pages/TrashPage'
import { ActivityLogPage } from '@/pages/ActivityLogPage'
import { UploadProvider } from '@/context/UploadContext'


function App() {
  return (
    <UploadProvider>
      <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route path="google-connected" element={<GoogleConnectedPage />} />
      <Route path="public/files/:token" element={<PublicFilePage />} />
      <Route path="public/files/:token/embed" element={<PublicFilePage embed />} />
      <Route element={<ProtectedRoute />}>
        <Route path="change-password" element={<ChangePasswordPage />} />
        <Route element={<DriveLayout />}>
          <Route index element={<Navigate to="/all-files" replace />} />
          <Route path="all-files" element={<AllFilesPage />} />
          <Route path="shared" element={<SharedPage />} />
          <Route path="recent" element={<RecentPage />} />
          <Route path="starred" element={<StarredPage />} />
          <Route path="archived" element={<ArchivedPage />} />
          <Route path="trash" element={<TrashPage />} />
          <Route path="activity" element={<ActivityLogPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="api" element={<ApiManagementPage />} />
          <Route element={<AdminRoute />}>
            <Route path="admin" element={<Navigate to="/admin/users" replace />} />
            <Route path="admin/users" element={<AdminUsersPage />} />
            <Route path="admin/storage" element={<AdminStoragePage />} />
            <Route path="quota" element={<Navigate to="/admin/storage" replace />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/all-files" replace />} />
      </Routes>
    </UploadProvider>
  )
}


export default App
