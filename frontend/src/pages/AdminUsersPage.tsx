import { useEffect, useState, type FormEvent } from 'react'
import { HardDrive, KeyRound, Pencil, Trash2, UserPlus, UserX, UserCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { DummyModal } from '@/components/drive/DummyModal'
import { PageHeader } from '@/components/drive/PageHeader'
import { apiFetch, errorCode, errorMessage, formatBytes } from '@/lib/api'
import { getStoredUser } from '@/lib/auth'
import { bytesToGbText, gbToBytesString } from '@/lib/units'

type AdminUser = {
  id: string
  name: string
  email: string
  role: 'admin' | 'member'
  status: 'active' | 'disabled'
  mustChangePassword: boolean
  davEnabled: boolean
  storageLimitBytes: string | null
  usedBytes: string
  fileCount: number
  totalBytes: string
  totalFileCount: number
}

type Dialog = { kind: 'create' } | { kind: 'limit' | 'reset' | 'delete'; user: AdminUser } | null

const userErrors: Record<string, string> = {
  USER_EMAIL_TAKEN: 'That email is already in use.',
  USER_HAS_CONNECTED_ACCOUNTS: 'This user connected storage accounts. Remove those accounts on the Storage page first, then delete the user.',
  LAST_ADMIN: 'This is the last active admin. Another admin is needed before this one can be disabled or deleted.',
  USER_NOT_FOUND: 'That user no longer exists.',
}

function readable(error: unknown, fallback: string) {
  const code = errorCode(error)
  return (code && userErrors[code]) || errorMessage(error, fallback)
}

export function AdminUsersPage() {
  const me = getStoredUser()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [dialog, setDialog] = useState<Dialog>(null)
  const [message, setMessage] = useState('')
  const [dialogError, setDialogError] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', password: '', limitGb: '', confirmEmail: '' })

  async function load() {
    const data = await apiFetch<{ users: AdminUser[] }>('/admin/users')
    setUsers(data.users)
  }

  useEffect(() => {
    load().catch((error) => setMessage(readable(error, 'Failed to load users')))
  }, [])

  function open(next: Dialog) {
    setDialogError('')
    setForm({ name: '', email: '', password: '', limitGb: next && next.kind === 'limit' ? bytesToGbText(next.user.storageLimitBytes) : '', confirmEmail: '' })
    setDialog(next)
  }

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true)
    setDialogError('')
    try {
      await action()
      setDialog(null)
      setMessage(done)
      await load()
    } catch (error) {
      setDialogError(readable(error, 'Request failed'))
    } finally {
      setBusy(false)
    }
  }

  function parsedLimit() {
    const bytes = gbToBytesString(form.limitGb)
    if (bytes === undefined) setDialogError('Enter the limit in GB as a number, or leave it empty for no limit.')
    return bytes
  }

  function createUser(event: FormEvent) {
    event.preventDefault()
    const limit = parsedLimit()
    if (limit === undefined) return
    return run(() => apiFetch('/admin/users', { method: 'POST', body: JSON.stringify({ name: form.name, email: form.email, temporaryPassword: form.password, storageLimitBytes: limit }) }), `Created ${form.email}. They must change the temporary password at first login.`)
  }

  function saveLimit(event: FormEvent) {
    event.preventDefault()
    if (dialog?.kind !== 'limit') return
    const limit = parsedLimit()
    if (limit === undefined) return
    return run(() => apiFetch(`/admin/users/${dialog.user.id}`, { method: 'PATCH', body: JSON.stringify({ storageLimitBytes: limit }) }), 'Storage limit updated.')
  }

  function resetPassword(event: FormEvent) {
    event.preventDefault()
    if (dialog?.kind !== 'reset') return
    return run(() => apiFetch(`/admin/users/${dialog.user.id}/reset-password`, { method: 'POST', body: JSON.stringify({ temporaryPassword: form.password }) }), `Password reset for ${dialog.user.email}. They are signed out and must choose a new password.`)
  }

  function deleteUser(event: FormEvent) {
    event.preventDefault()
    if (dialog?.kind !== 'delete') return
    return run(() => apiFetch(`/admin/users/${dialog.user.id}`, { method: 'DELETE' }), `Deleted ${dialog.user.email} and their files.`)
  }

  async function toggleStatus(user: AdminUser) {
    setMessage('')
    try {
      await apiFetch(`/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ status: user.status === 'active' ? 'disabled' : 'active' }) })
      await load()
    } catch (error) {
      setMessage(readable(error, 'Request failed'))
    }
  }

  async function toggleDav(user: AdminUser) {
    setMessage('')
    try {
      await apiFetch(`/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ davEnabled: !user.davEnabled }) })
      setMessage(user.davEnabled ? `WebDAV turned off for ${user.email}. Their WebDAV keys were revoked.` : `WebDAV turned on for ${user.email}. They can now create a WebDAV key on the API Keys page.`)
      await load()
    } catch (error) {
      setMessage(readable(error, 'Request failed'))
    }
  }

  return (
    <>
      <PageHeader title="Users" description="Family members, their storage limits and access." actions={<Button onClick={() => open({ kind: 'create' })}><UserPlus className="h-4 w-4" />Add user</Button>} />
      {message ? <p className="mt-4 rounded-xl bg-blue-50 p-3 text-sm text-blue-700">{message}</p> : null}
      <Card className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-slate-500">
              <th className="p-4 font-semibold">User</th>
              <th className="p-4 font-semibold">Status</th>
              <th className="p-4 font-semibold">Used</th>
              <th className="p-4 font-semibold">Limit</th>
              <th className="p-4 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const self = user.id === me?.id
              return (
                <tr key={user.id} className="border-b border-slate-100">
                  <td className="p-4">
                    <p className="font-bold">{user.name}{self ? <span className="ml-2 text-xs font-semibold text-slate-400">(you)</span> : null}</p>
                    <p className="text-xs text-slate-500">{user.email}</p>
                    <p className="mt-1 flex gap-1.5 text-[11px] font-bold uppercase tracking-wide">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{user.role}</span>
                      {user.mustChangePassword ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">Password change pending</span> : null}
                      {user.davEnabled ? <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-700">WebDAV</span> : null}
                    </p>
                  </td>
                  <td className="p-4"><span className={user.status === 'active' ? 'rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-700' : 'rounded-full bg-slate-200 px-2 py-0.5 text-xs font-bold text-slate-600'}>{user.status}</span></td>
                  <td className="p-4">{formatBytes(user.usedBytes)}<span className="block text-xs text-slate-500">{user.fileCount} files</span></td>
                  <td className="p-4">{user.storageLimitBytes === null ? 'No limit' : formatBytes(user.storageLimitBytes)}</td>
                  <td className="p-4">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => open({ kind: 'limit', user })}><Pencil className="h-3.5 w-3.5" />Limit</Button>
                      <Button size="sm" variant="outline" onClick={() => open({ kind: 'reset', user })}><KeyRound className="h-3.5 w-3.5" />Reset</Button>
                      <Button size="sm" variant="outline" title="WebDAV lets apps like rclone read, change and delete this user's files with a WebDAV key." onClick={() => toggleDav(user)}><HardDrive className="h-3.5 w-3.5" />{user.davEnabled ? 'WebDAV off' : 'WebDAV on'}</Button>
                      {!self ? <Button size="sm" variant="outline" onClick={() => toggleStatus(user)}>{user.status === 'active' ? <><UserX className="h-3.5 w-3.5" />Disable</> : <><UserCheck className="h-3.5 w-3.5" />Enable</>}</Button> : null}
                      {!self ? <Button size="sm" variant="danger" onClick={() => open({ kind: 'delete', user })}><Trash2 className="h-3.5 w-3.5" />Delete</Button> : null}
                    </div>
                  </td>
                </tr>
              )
            })}
            {users.length === 0 ? <tr><td colSpan={5} className="p-6 text-center text-slate-500">No users yet.</td></tr> : null}
          </tbody>
        </table>
      </Card>

      <DummyModal open={dialog?.kind === 'create'} title="Add user" description="They sign in with the temporary password and must change it right away." onClose={() => setDialog(null)}>
        <form onSubmit={createUser} className="grid gap-4">
          <label className="grid gap-2 text-sm font-semibold">Name<Input value={form.name} minLength={2} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
          <label className="grid gap-2 text-sm font-semibold">Email<Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></label>
          <label className="grid gap-2 text-sm font-semibold">Temporary password<Input type="text" autoComplete="off" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /><span className="text-xs font-normal text-slate-500">At least 8 characters. Share it with them privately.</span></label>
          <label className="grid gap-2 text-sm font-semibold">Storage limit (GB)<Input inputMode="decimal" placeholder="Empty means no limit" value={form.limitGb} onChange={(e) => setForm({ ...form, limitGb: e.target.value })} /></label>
          {dialogError ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-600">{dialogError}</p> : null}
          <div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={busy}>{busy ? 'Creating...' : 'Create user'}</Button></div>
        </form>
      </DummyModal>

      <DummyModal open={dialog?.kind === 'limit'} title="Storage limit" description={dialog?.kind === 'limit' ? `${dialog.user.email} uses ${formatBytes(dialog.user.usedBytes)} now.` : ''} onClose={() => setDialog(null)}>
        <form onSubmit={saveLimit} className="grid gap-4">
          <label className="grid gap-2 text-sm font-semibold">Limit (GB)<Input inputMode="decimal" placeholder="Empty means no limit" value={form.limitGb} onChange={(e) => setForm({ ...form, limitGb: e.target.value })} /></label>
          {dialogError ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-600">{dialogError}</p> : null}
          <div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={busy}>Save</Button></div>
        </form>
      </DummyModal>

      <DummyModal open={dialog?.kind === 'reset'} title="Reset password" description={dialog?.kind === 'reset' ? `${dialog.user.email} is signed out everywhere and must choose a new password.` : ''} onClose={() => setDialog(null)}>
        <form onSubmit={resetPassword} className="grid gap-4">
          <label className="grid gap-2 text-sm font-semibold">Temporary password<Input type="text" autoComplete="off" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label>
          {dialogError ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-600">{dialogError}</p> : null}
          <div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={busy}>Reset password</Button></div>
        </form>
      </DummyModal>

      <DummyModal open={dialog?.kind === 'delete'} title="Delete user" description="This cannot be undone." onClose={() => setDialog(null)}>
        {dialog?.kind === 'delete' ? (
          <form onSubmit={deleteUser} className="grid gap-4">
            <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">
              Deleting <b>{dialog.user.email}</b> permanently deletes <b>{dialog.user.totalFileCount} files</b> ({formatBytes(dialog.user.totalBytes)}), including files in their recycle bin, and both stored copies of each. To keep the files, disable the user instead.
            </p>
            <label className="grid gap-2 text-sm font-semibold">Type the email to confirm<Input value={form.confirmEmail} onChange={(e) => setForm({ ...form, confirmEmail: e.target.value })} placeholder={dialog.user.email} autoComplete="off" /></label>
            {dialogError ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-600">{dialogError}</p> : null}
            <div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button type="submit" disabled={busy || form.confirmEmail.trim().toLowerCase() !== dialog.user.email.toLowerCase()} className="bg-red-600 text-white hover:bg-red-700">{busy ? 'Deleting...' : 'Delete user and files'}</Button></div>
          </form>
        ) : null}
      </DummyModal>
    </>
  )
}
