import { useState } from 'react'
import { AppConfigProvider } from './context/AppConfig'
import AdminLogin from './pages/AdminLogin'
import Admin from './pages/Admin'

const TOKEN_KEY = 'nx_admin_token'

function Inner() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY))

  function handleLogin(t: string) {
    sessionStorage.setItem(TOKEN_KEY, t)
    setToken(t)
  }

  function handleLogout() {
    sessionStorage.removeItem(TOKEN_KEY)
    setToken(null)
  }

  if (!token) return <AdminLogin onLogin={handleLogin} />

  return (
    <div>
      <nav className="navbar">
        <div className="navbar-brand">
          <span className="brand-logo">⬡</span>
          <span className="brand-name">NeutronX</span>
          <span className="brand-tag">Admin</span>
        </div>
        <div className="navbar-nav" />
        <div className="navbar-wallet">
          <button className="ghost" onClick={() => { window.location.href = '/' }}>← Back to app</button>
          <button className="ghost" onClick={handleLogout}>Log out</button>
        </div>
      </nav>
      <main className="page-content">
        <Admin token={token} onUnauthorized={handleLogout} />
      </main>
    </div>
  )
}

export default function AdminApp() {
  return (
    <AppConfigProvider>
      <Inner />
    </AppConfigProvider>
  )
}
