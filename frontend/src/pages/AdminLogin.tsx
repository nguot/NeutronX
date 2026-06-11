import { useState } from 'react'
import { useAppConfig } from '../context/AppConfig'

export default function AdminLogin({ onLogin }: { onLogin: (token: string) => void }) {
  const { backendUrl } = useAppConfig()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const res  = await fetch(`${backendUrl}/admin/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Login failed')
      onLogin(data.token)
    } catch (e: any) { setError(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="page-content" style={{ maxWidth: 360, paddingTop: 96 }}>
      <div className="card">
        <div className="page-header" style={{ marginBottom: 16 }}>
          <div className="page-title">Admin Login</div>
          <div className="page-sub">Restricted area</div>
        </div>
        <form onSubmit={submit}>
          <label>Username</label>
          <input value={username} onChange={e => setUsername(e.target.value)} autoFocus />
          <label>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} />
          <button type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {error && <div className="status bad">{error}</div>}
        </form>
      </div>
    </div>
  )
}
