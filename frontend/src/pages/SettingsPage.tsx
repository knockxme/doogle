import { Link } from 'react-router-dom'
import { Database, KeyRound, ShieldCheck, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/drive/PageHeader'
import { getStoredUser, isAdmin } from '@/lib/auth'

export function SettingsPage() {
  const user = getStoredUser()
  const admin = isAdmin(user)

  return (
    <>
      <PageHeader title="Setting" description="Manage your account." />
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-blue-600/10 text-blue-600"><ShieldCheck className="h-5 w-5" /></div>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-bold">{user?.name ?? 'User'}</h2>
              <p className="truncate text-xs text-slate-500">{user?.email ?? '-'}</p>
            </div>
            <span className="ml-auto rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold capitalize text-slate-600">{user?.role ?? 'member'}</span>
          </div>
          <p className="mt-4 text-sm text-slate-500">Your files are encrypted and kept in two copies. Ask the admin if you need more space.</p>
          <Link to="/change-password" className="mt-4 inline-block"><Button variant="outline"><KeyRound className="h-4 w-4" />Change password</Button></Link>
        </Card>
        {admin ? (
          <Card className="p-5">
            <h2 className="text-lg font-bold">Administration</h2>
            <p className="mt-1 text-sm text-slate-500">Family members, storage accounts, caps, health and Google credentials.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link to="/admin/users"><Button variant="outline"><Users className="h-4 w-4" />Users</Button></Link>
              <Link to="/admin/storage"><Button variant="outline"><Database className="h-4 w-4" />Storage</Button></Link>
            </div>
          </Card>
        ) : null}
      </div>
    </>
  )
}
