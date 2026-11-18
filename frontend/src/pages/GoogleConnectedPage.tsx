import { useEffect } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { CheckCircle, XCircle } from 'lucide-react'
import { Card } from '@/components/ui/card'

export function GoogleConnectedPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const status = params.get('status') ?? 'success'
  const ok = status === 'success'
  const missingScope = params.get('reason') === 'scope'

  useEffect(() => {
    window.opener?.postMessage({ type: 'GOOGLE_CONNECTED', status }, window.location.origin)
    // A failure stays on screen so the reason can be read.
    if (!ok) return
    const timer = window.setTimeout(() => {
      if (window.opener) window.close()
      else navigate('/admin/storage')
    }, 800)
    return () => window.clearTimeout(timer)
  }, [navigate, ok, status])

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-5">
      <Card className="w-full max-w-sm p-6 text-center">
        {ok ? <CheckCircle className="mx-auto h-10 w-10 text-emerald-500" /> : <XCircle className="mx-auto h-10 w-10 text-red-500" />}
        <h1 className="mt-4 text-xl font-extrabold">{ok ? 'Google Account Connected' : 'Connection Failed'}</h1>
        <p className="mt-2 text-sm text-slate-500">{ok ? 'This window will close automatically.' : missingScope ? 'Google Drive access was not allowed. Try again and tick the Google Drive box on the Google screen.' : 'The account was not connected. Go back and try again.'}</p>
        {ok ? null : <Link to="/admin/storage" className="mt-4 inline-block text-sm font-bold text-blue-600 hover:underline">Back to storage</Link>}
      </Card>
    </main>
  )
}
