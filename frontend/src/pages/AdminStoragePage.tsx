import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, Cloud, Database, RefreshCw, Trash2, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { DummyModal } from '@/components/drive/DummyModal'
import { PageHeader } from '@/components/drive/PageHeader'
import { apiFetch, errorCode, errorMessage, formatBytes, formatDate } from '@/lib/api'
import { bytesToGbText, gbToBytesString } from '@/lib/units'
import { cn } from '@/lib/utils'

type PoolAccount = {
  id: string
  provider: string
  email: string | null
  capBytes: string | null
  storedBytes: string
  effectiveFreeBytes: string | null
  pausedUntil: string | null
  full: boolean
}
type HealthAccount = { id: string; email: string; status: string; lastError: string | null; healthyCopies: number; lostCopies: number; full: boolean }
type Health = { accounts: HealthAccount[]; filesMissingCopy: number; copiesPerFile?: 1 | 2 }
type Settings = { copiesPerFile: 1 | 2; defaultAccountCapBytes: string | null; routingMode: RoutingMode; priorityAccountIds: string[] }
type RoutingMode = 'most_available' | 'round_robin' | 'priority'
type RepairJob = { id: string; status: 'running' | 'completed' | 'failed'; processed: number; failed: number; startedAt: string; finishedAt: string | null }
type GoogleConfig = { exists: boolean; clientId?: string; redirectUri?: string; hasSecret?: boolean; defaultRedirectUri: string }

const routingLabels: Record<RoutingMode, string> = {
  most_available: 'Most available space',
  round_robin: 'Round robin',
  priority: 'Priority order',
}

const storageErrors: Record<string, string> = {
  ACCOUNT_HOLDS_SOLE_COPY: 'Some files have their only healthy copy on this account. Run Repair first so each file has a copy elsewhere, then remove the account.',
  REPAIR_RUNNING: 'A repair is already running.',
  ACCOUNT_NOT_FOUND: 'That storage account no longer exists.',
}

function readable(error: unknown, fallback: string) {
  const code = errorCode(error)
  return (code && storageErrors[code]) || errorMessage(error, fallback)
}

const emptyS3 = { name: '', bucket: '', region: 'us-east-1', endpoint: '', accessKeyId: '', secretAccessKey: '', forcePathStyle: false, quotaGb: '' }

export function AdminStoragePage() {
  const [pool, setPool] = useState<PoolAccount[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [job, setJob] = useState<RepairJob | null>(null)
  const [google, setGoogle] = useState<GoogleConfig | null>(null)
  const [message, setMessage] = useState('')
  const [defaultCapGb, setDefaultCapGb] = useState('')
  const [capDrafts, setCapDrafts] = useState<Record<string, string>>({})
  const [removeTarget, setRemoveTarget] = useState<{ id: string; email: string } | null>(null)
  const [removeError, setRemoveError] = useState('')
  const [removing, setRemoving] = useState(false)
  const [s3Open, setS3Open] = useState(false)
  const [s3, setS3] = useState(emptyS3)
  const [s3Error, setS3Error] = useState('')
  const [s3Busy, setS3Busy] = useState(false)
  const [credForm, setCredForm] = useState({ clientId: '', clientSecret: '', redirectUri: '' })
  const [credBusy, setCredBusy] = useState(false)
  const [repairStarting, setRepairStarting] = useState(false)

  const load = useCallback(async () => {
    const [accounts, healthData, settingsData, jobData, googleData] = await Promise.all([
      apiFetch<{ accounts: PoolAccount[] }>('/admin/storage/accounts'),
      apiFetch<Health>('/admin/storage/health'),
      apiFetch<Settings>('/admin/storage/settings'),
      apiFetch<RepairJob | null>('/admin/storage/repair'),
      apiFetch<GoogleConfig>('/system/google-config'),
    ])
    setPool(accounts.accounts)
    setHealth(healthData)
    setSettings(settingsData)
    setJob(jobData)
    setGoogle(googleData)
    setDefaultCapGb(bytesToGbText(settingsData.defaultAccountCapBytes))
    setCredForm((current) => ({ clientId: googleData.clientId ?? '', clientSecret: '', redirectUri: current.redirectUri || googleData.redirectUri || googleData.defaultRedirectUri }))
    setCapDrafts(Object.fromEntries(accounts.accounts.map((account) => [account.id, bytesToGbText(account.capBytes)])))
  }, [])

  useEffect(() => {
    load().catch((error) => setMessage(readable(error, 'Failed to load storage')))
  }, [load])

  // Poll the repair job while it runs, then refresh health once it ends.
  const running = job?.status === 'running'
  useEffect(() => {
    if (!running) return undefined
    const timer = window.setInterval(() => {
      apiFetch<RepairJob | null>('/admin/storage/repair').then((next) => {
        setJob(next)
        if (next && next.status !== 'running') load().catch(() => undefined)
      }).catch(() => undefined)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [running, load])

  async function startRepair() {
    setRepairStarting(true)
    setMessage('')
    try {
      setJob(await apiFetch<RepairJob>('/admin/storage/repair', { method: 'POST' }))
    } catch (error) {
      setMessage(readable(error, 'Could not start repair'))
      if (errorCode(error) === 'REPAIR_RUNNING') apiFetch<RepairJob | null>('/admin/storage/repair').then(setJob).catch(() => undefined)
    } finally {
      setRepairStarting(false)
    }
  }

  async function connectGoogle() {
    setMessage('')
    try {
      const data = await apiFetch<{ url: string }>('/connected-accounts/google/connect-url')
      window.location.href = data.url
    } catch {
      setMessage('Could not start the Google connection. Save the Google OAuth credentials below first.')
    }
  }

  async function saveDefaultCap(event: FormEvent) {
    event.preventDefault()
    const bytes = gbToBytesString(defaultCapGb)
    if (bytes === undefined) return setMessage('Enter the default cap in GB as a number, or leave it empty for no cap.')
    try {
      await apiFetch('/admin/storage/settings', { method: 'PATCH', body: JSON.stringify({ defaultAccountCapBytes: bytes }) })
      setMessage('Default cap saved. It applies to accounts connected from now on.')
      await load()
    } catch (error) {
      setMessage(readable(error, 'Failed to save the default cap'))
    }
  }

  async function saveAccountCap(id: string) {
    const bytes = gbToBytesString(capDrafts[id] ?? '')
    if (bytes === undefined) return setMessage('Enter the cap in GB as a number, or leave it empty for no cap.')
    try {
      await apiFetch(`/admin/storage/accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ capBytes: bytes }) })
      setMessage('Account cap saved.')
      await load()
    } catch (error) {
      setMessage(readable(error, 'Failed to save the cap'))
    }
  }

  async function toggleSecondCopy() {
    const turnOff = settings?.copiesPerFile !== 1
    if (turnOff && !window.confirm('Turn off the second copy?\n\nNew files will be stored on one account only. If that account is lost, those files are gone for good. Files that already have two copies keep them.')) return
    try {
      setSettings(await apiFetch<Settings>('/admin/storage/settings', { method: 'PATCH', body: JSON.stringify({ copiesPerFile: turnOff ? 1 : 2 }) }))
      setMessage(turnOff ? 'Second copy is off. New files are stored once.' : 'Second copy is on. Press Repair to add a second copy to files stored only once.')
      await load()
    } catch (error) {
      setMessage(readable(error, 'Failed to save the copy setting'))
    }
  }

  async function saveRouting(next: Partial<Settings>) {
    try {
      setSettings(await apiFetch<Settings>('/admin/storage/settings', { method: 'PATCH', body: JSON.stringify(next) }))
    } catch (error) {
      setMessage(readable(error, 'Failed to save routing'))
    }
  }

  function movePriority(id: string, direction: -1 | 1) {
    if (!settings) return
    const ids = orderedIds()
    const index = ids.indexOf(id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
    saveRouting({ priorityAccountIds: ids })
  }

  function orderedIds() {
    const known = new Set(pool.map((account) => account.id))
    const saved = (settings?.priorityAccountIds ?? []).filter((id) => known.has(id))
    return [...saved, ...pool.map((account) => account.id).filter((id) => !saved.includes(id))]
  }

  async function removeAccount() {
    if (!removeTarget) return
    setRemoving(true)
    setRemoveError('')
    try {
      await apiFetch(`/connected-accounts/${removeTarget.id}`, { method: 'DELETE' })
      setRemoveTarget(null)
      setMessage('Storage account removed. Its encrypted files in the provider were left untouched.')
      await load()
    } catch (error) {
      setRemoveError(readable(error, 'Could not remove the account'))
    } finally {
      setRemoving(false)
    }
  }

  async function connectS3(event: FormEvent) {
    event.preventDefault()
    setS3Error('')
    const quota = gbToBytesString(s3.quotaGb)
    if (quota === undefined) return setS3Error('Enter the quota in GB as a number, or leave it empty.')
    setS3Busy(true)
    try {
      await apiFetch('/connected-accounts/s3', { method: 'POST', body: JSON.stringify({ ...s3, quotaGb: undefined, endpoint: s3.endpoint || undefined, quotaBytes: quota }) })
      setS3Open(false)
      setS3(emptyS3)
      setMessage('S3 storage connected.')
      await load()
    } catch (error) {
      setS3Error(readable(error, 'Could not connect the S3 bucket'))
    } finally {
      setS3Busy(false)
    }
  }

  async function saveGoogleConfig(event: FormEvent) {
    event.preventDefault()
    setCredBusy(true)
    try {
      await apiFetch('/system/google-config', { method: 'POST', body: JSON.stringify({ clientId: credForm.clientId, clientSecret: credForm.clientSecret || undefined, redirectUri: credForm.redirectUri || google?.defaultRedirectUri }) })
      setMessage('Google OAuth credentials saved.')
      await load()
    } catch (error) {
      setMessage(readable(error, 'Failed to save the Google credentials'))
    } finally {
      setCredBusy(false)
    }
  }

  const healthById = new Map((health?.accounts ?? []).map((account) => [account.id, account]))
  const poolById = new Map(pool.map((account) => [account.id, account]))
  const rows = (health?.accounts ?? []).map((h) => ({ h, p: poolById.get(h.id) }))
  const priorityIds = orderedIds()

  return (
    <>
      <PageHeader
        title="Storage"
        description="Storage accounts, caps, routing and health. Every file is kept on two different accounts."
        actions={<>
          <Button variant="outline" onClick={() => load().catch((error) => setMessage(readable(error, 'Refresh failed')))}><RefreshCw className="h-4 w-4" />Refresh</Button>
          <Button variant="outline" onClick={() => { setS3Error(''); setS3Open(true) }}><Database className="h-4 w-4" />Connect S3</Button>
          <Button onClick={connectGoogle}><Cloud className="h-4 w-4" />Connect Google</Button>
        </>}
      />
      {message ? <p className="mt-4 rounded-xl bg-blue-50 p-3 text-sm text-blue-700">{message}</p> : null}

      <Card className="mt-4 border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-bold">Before connecting Google accounts</p>
        <ul className="mt-2 list-inside list-disc space-y-1 text-[13px]">
          <li>Set the Google OAuth app to <b>In production</b>. In testing mode, tokens expire every 7 days. An unverified app shows a warning screen and is limited to 100 accounts.</li>
          <li><b>Never replace the Google Cloud project.</b> Access is tied to the project, so a new one cannot read existing files.</li>
          <li>Many Gmail accounts linked to one server may be flagged by Google. Two copies reduce the risk but do not remove it.</li>
        </ul>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold">Health</h2>
              <p className="mt-1 text-sm text-slate-500">{health?.copiesPerFile === 1 ? 'Files that have no healthy copy left.' : 'Files that have fewer than two healthy copies.'}</p>
            </div>
            <Button onClick={startRepair} disabled={repairStarting || running}><Wrench className="h-4 w-4" />{running ? 'Repairing...' : 'Repair'}</Button>
          </div>
          <p className={cn('mt-4 text-3xl font-extrabold', health && health.filesMissingCopy > 0 ? 'text-orange-600' : 'text-emerald-600')}>{health ? health.filesMissingCopy : '--'}</p>
          <p className="text-sm text-slate-500">files missing a copy</p>
          {job ? (
            <div className="mt-4 rounded-xl bg-slate-50 p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold">{job.status === 'running' ? 'Repair running' : job.status === 'completed' ? 'Last repair finished' : 'Last repair failed'}</span>
                <span className="text-xs text-slate-500">{formatDate(job.finishedAt ?? job.startedAt)}</span>
              </div>
              <p className="mt-1 text-slate-600">{job.processed} files processed, {job.failed} could not be repaired.</p>
              {job.status === 'running' ? <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200"><div className="h-full w-1/3 animate-pulse rounded-full bg-blue-600" /></div> : null}
            </div>
          ) : null}
        </Card>

        <Card className="p-5">
          <h2 className="text-lg font-bold">Caps and routing</h2>
          <div className="mt-3 flex items-start justify-between gap-3 rounded-xl bg-slate-50 p-3">
            <div>
              <p className="text-sm font-semibold">Second copy: {settings?.copiesPerFile === 1 ? 'off' : 'on'}</p>
              <p className="mt-0.5 text-xs text-slate-500">{settings?.copiesPerFile === 1
                ? 'New files are stored on one account, so all free space can be used. If an account is lost, its files are gone.'
                : 'Every new file is stored on two different accounts, so losing one account loses nothing. Uses twice the space.'}</p>
            </div>
            <Button size="sm" variant="outline" disabled={!settings} onClick={toggleSecondCopy}>{settings?.copiesPerFile === 1 ? 'Turn on' : 'Turn off'}</Button>
          </div>
          <form onSubmit={saveDefaultCap} className="mt-3 grid gap-2">
            <label className="text-sm font-semibold">Default cap for new accounts (GB)</label>
            <div className="flex gap-2">
              <Input inputMode="decimal" placeholder="Empty means no cap" value={defaultCapGb} onChange={(e) => setDefaultCapGb(e.target.value)} />
              <Button variant="outline">Save</Button>
            </div>
            <p className="text-xs text-slate-500">Only accounts connected after the change use the new default. Caps count the encrypted bytes this app stored on the account.</p>
          </form>
          <div className="mt-4 grid gap-2">
            <label className="text-sm font-semibold">Routing</label>
            <select className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm" value={settings?.routingMode ?? 'most_available'} onChange={(e) => saveRouting({ routingMode: e.target.value as RoutingMode })}>
              {(Object.keys(routingLabels) as RoutingMode[]).map((mode) => <option key={mode} value={mode}>{routingLabels[mode]}</option>)}
            </select>
            {settings?.routingMode === 'priority' ? (
              <ol className="grid gap-1.5">
                {priorityIds.map((id, index) => (
                  <li key={id} className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-1.5 text-sm">
                    <span className="w-5 text-xs font-bold text-slate-400">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{healthById.get(id)?.email ?? poolById.get(id)?.email ?? id}</span>
                    <Button size="sm" variant="ghost" aria-label="Move up" disabled={index === 0} onClick={() => movePriority(id, -1)}><ArrowUp className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" aria-label="Move down" disabled={index === priorityIds.length - 1} onClick={() => movePriority(id, 1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </Card>
      </div>

      <Card className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-slate-500">
              <th className="p-4 font-semibold">Account</th>
              <th className="p-4 font-semibold">Status</th>
              <th className="p-4 font-semibold">Stored</th>
              <th className="p-4 font-semibold">Cap (GB)</th>
              <th className="p-4 font-semibold">Free</th>
              <th className="p-4 font-semibold">Lost copies</th>
              <th className="p-4 text-right font-semibold" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ h, p }) => {
              const unhealthy = h.status !== 'connected'
              const paused = p?.pausedUntil && new Date(p.pausedUntil).getTime() > Date.now()
              return (
                <tr key={h.id} className="border-b border-slate-100 align-top">
                  <td className="p-4"><p className="font-bold break-all">{h.email}</p><p className="text-xs text-slate-500">{p?.provider === 's3' ? 'S3 storage' : 'Google Drive'}</p></td>
                  <td className="p-4">
                    {unhealthy ? <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">Unhealthy</span> : paused ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">Paused until {formatDate(p!.pausedUntil!)}</span> : <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-700">Connected</span>}
                    {h.full ? <span className="ml-1.5 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-bold text-orange-700">Full</span> : null}
                    {unhealthy && h.lastError ? <p className="mt-1 flex max-w-xs items-start gap-1 text-xs text-red-600"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{h.lastError}</p> : null}
                  </td>
                  <td className="p-4">{p ? formatBytes(p.storedBytes) : '--'}<span className="block text-xs text-slate-500">{h.healthyCopies} copies</span></td>
                  <td className="p-4">
                    {p ? (
                      <div className="flex gap-1.5">
                        <Input className="h-9 w-24 px-2" inputMode="decimal" placeholder="No cap" value={capDrafts[h.id] ?? ''} onChange={(e) => setCapDrafts({ ...capDrafts, [h.id]: e.target.value })} />
                        <Button size="sm" variant="outline" disabled={(capDrafts[h.id] ?? '') === bytesToGbText(p.capBytes)} onClick={() => saveAccountCap(h.id)}>Save</Button>
                      </div>
                    ) : '--'}
                  </td>
                  <td className="p-4">{p ? (p.effectiveFreeBytes === null ? 'Unknown' : formatBytes(p.effectiveFreeBytes)) : '--'}</td>
                  <td className="p-4">{h.lostCopies > 0 ? <span className="font-bold text-orange-600">{h.lostCopies}</span> : 0}</td>
                  <td className="p-4 text-right"><Button size="sm" variant="danger" onClick={() => { setRemoveError(''); setRemoveTarget({ id: h.id, email: h.email }) }}><Trash2 className="h-3.5 w-3.5" />Remove</Button></td>
                </tr>
              )
            })}
            {rows.length === 0 ? <tr><td colSpan={7} className="p-6 text-center text-slate-500">No storage accounts yet. Connect at least two so files can be kept in two copies.</td></tr> : null}
          </tbody>
        </table>
      </Card>

      <Card className="mt-4 p-5">
        <h2 className="text-lg font-bold">Google OAuth credentials</h2>
        <p className="mt-1 text-sm text-slate-500">{google?.exists ? 'Credentials are saved. Leave the secret empty to keep the current one.' : 'Save the OAuth client from your Google Cloud project before connecting an account.'}</p>
        <form onSubmit={saveGoogleConfig} className="mt-4 grid gap-3 lg:grid-cols-3">
          <label className="grid gap-1.5 text-sm font-semibold">Client ID<Input value={credForm.clientId} onChange={(e) => setCredForm({ ...credForm, clientId: e.target.value })} required /></label>
          <label className="grid gap-1.5 text-sm font-semibold">Client secret<Input type="password" autoComplete="off" placeholder={google?.hasSecret ? 'Saved' : ''} value={credForm.clientSecret} onChange={(e) => setCredForm({ ...credForm, clientSecret: e.target.value })} /></label>
          <label className="grid gap-1.5 text-sm font-semibold">Redirect URI<Input value={credForm.redirectUri} onChange={(e) => setCredForm({ ...credForm, redirectUri: e.target.value })} /></label>
          <div className="lg:col-span-3"><Button disabled={credBusy}>{credBusy ? 'Saving...' : 'Save credentials'}</Button></div>
        </form>
      </Card>

      <DummyModal open={Boolean(removeTarget)} title="Remove storage account" description={removeTarget?.email ?? ''} onClose={() => setRemoveTarget(null)}>
        <div className="grid gap-4">
          <p className="text-sm text-slate-600">The account stops being used and its copy records are forgotten. Files stay readable from their other copy, and the encrypted data in the provider is not deleted.</p>
          {removeError ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-600">{removeError}</p> : null}
          <div className="flex justify-end gap-3"><Button variant="outline" onClick={() => setRemoveTarget(null)}>Cancel</Button><Button disabled={removing} className="bg-red-600 text-white hover:bg-red-700" onClick={removeAccount}>{removing ? 'Removing...' : 'Remove account'}</Button></div>
        </div>
      </DummyModal>

      <DummyModal open={s3Open} title="Connect S3 storage" description="Any S3-compatible bucket." onClose={() => setS3Open(false)}>
        <form onSubmit={connectS3} className="grid gap-3">
          <Input placeholder="Display name" value={s3.name} onChange={(e) => setS3({ ...s3, name: e.target.value })} required />
          <Input placeholder="Bucket" value={s3.bucket} onChange={(e) => setS3({ ...s3, bucket: e.target.value })} required />
          <Input placeholder="Region" value={s3.region} onChange={(e) => setS3({ ...s3, region: e.target.value })} required />
          <Input placeholder="Endpoint (optional)" value={s3.endpoint} onChange={(e) => setS3({ ...s3, endpoint: e.target.value })} />
          <Input placeholder="Access key ID" autoComplete="off" value={s3.accessKeyId} onChange={(e) => setS3({ ...s3, accessKeyId: e.target.value })} required />
          <Input type="password" placeholder="Secret access key" autoComplete="off" value={s3.secretAccessKey} onChange={(e) => setS3({ ...s3, secretAccessKey: e.target.value })} required />
          <Input inputMode="decimal" placeholder="Provider quota in GB (optional)" value={s3.quotaGb} onChange={(e) => setS3({ ...s3, quotaGb: e.target.value })} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s3.forcePathStyle} onChange={(e) => setS3({ ...s3, forcePathStyle: e.target.checked })} />Force path-style URLs</label>
          {s3Error ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-600">{s3Error}</p> : null}
          <div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={() => setS3Open(false)}>Cancel</Button><Button disabled={s3Busy}>{s3Busy ? 'Connecting...' : 'Connect'}</Button></div>
        </form>
      </DummyModal>
    </>
  )
}
