import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { apiFetch, errorCode, errorMessage } from '@/lib/api'
import { clearAuthSession, getStoredUser, updateStoredUser } from '@/lib/auth'

export function ChangePasswordPage() {
  const navigate = useNavigate()
  const user = getStoredUser()
  const forced = Boolean(user?.mustChangePassword)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    if (newPassword.length < 8) return setError('The new password must be at least 8 characters.')
    if (newPassword !== confirmPassword) return setError('The new passwords do not match.')
    if (newPassword === currentPassword) return setError('Choose a password different from the current one.')
    setLoading(true)
    try {
      await apiFetch('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) })
      if (user) updateStoredUser({ ...user, mustChangePassword: false })
      navigate('/all-files', { replace: true })
    } catch (err) {
      setError(errorCode(err) === 'AUTH_INVALID_CREDENTIALS' ? 'The current password is incorrect.' : errorMessage(err, 'Could not change the password.'))
    } finally {
      setLoading(false)
    }
  }

  function signOut() {
    clearAuthSession()
    navigate('/login')
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-5">
      <Card className="w-full max-w-md p-6">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-white"><KeyRound className="h-6 w-6" /></div>
          <div>
            <h1 className="text-2xl font-extrabold">Change password</h1>
            <p className="text-sm text-slate-500">{forced ? 'Choose your own password before you continue.' : 'Pick a new password for your account.'}</p>
          </div>
        </div>
        <form onSubmit={submit} className="mt-6 grid gap-4">
          <label className="grid gap-2 text-sm font-semibold">{forced ? 'Temporary password' : 'Current password'}<Input type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required /></label>
          <label className="grid gap-2 text-sm font-semibold">New password<Input type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required /></label>
          <label className="grid gap-2 text-sm font-semibold">Repeat new password<Input type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required /></label>
          {error ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-600">{error}</p> : null}
          <Button disabled={loading}>{loading ? 'Saving...' : 'Save password'}</Button>
        </form>
        <p className="mt-5 text-center text-sm text-slate-500">
          {forced ? <button type="button" className="font-bold text-blue-600" onClick={signOut}>Sign out</button> : <Link className="font-bold text-blue-600" to="/settings">Cancel</Link>}
        </p>
      </Card>
    </main>
  )
}
