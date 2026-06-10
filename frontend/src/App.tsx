import { useState } from 'react'
import { AppConfigProvider } from './context/AppConfig'
import { useWallet } from './hooks/useWallet'
import DutchAuction from './pages/DutchAuction'
import CrossChain   from './pages/CrossChain'
import Explore      from './pages/Explore'
import Simulate     from './pages/Simulate'
import Orders       from './pages/Orders'
import Admin        from './pages/Admin'

type Tab = 'swap' | 'crosschain' | 'orders' | 'explore' | 'simulate' | 'admin'

const NAV: { id: Tab; label: string }[] = [
  { id: 'swap',       label: 'Swap' },
  { id: 'crosschain', label: 'Cross-Chain' },
  { id: 'orders',     label: 'Orders' },
  { id: 'explore',    label: 'Explore' },
  { id: 'simulate',   label: 'Simulate' },
  { id: 'admin',      label: 'Admin' },
]

function Inner() {
  const [tab, setTab] = useState<Tab>('swap')
  const { wallet, error, connect } = useWallet()

  return (
    <div>
      <nav className="navbar">
        <div className="navbar-brand">
          <span className="brand-logo">⬡</span>
          <span className="brand-name">NeutronX</span>
          <span className="brand-tag">DEX Aggregator</span>
        </div>

        <div className="navbar-nav">
          {NAV.map(n => (
            <button
              key={n.id}
              className={`nav-btn ${tab === n.id ? 'active' : ''}`}
              onClick={() => setTab(n.id)}
            >
              {n.label}
            </button>
          ))}
        </div>

        <div className="navbar-wallet">
          {wallet.connected ? (
            <div className="wallet-badge">
              <span className="wallet-dot" />
              <span>{wallet.account.slice(0, 6)}…{wallet.account.slice(-4)}</span>
              <span className="wallet-block">block #{wallet.blockNumber}</span>
            </div>
          ) : (
            <button className="btn-connect" onClick={connect}>Connect Wallet</button>
          )}
          {error && <span className="wallet-error">{error}</span>}
        </div>
      </nav>

      <main className="page-content">
        {tab === 'swap'       && <DutchAuction wallet={wallet} />}
        {tab === 'crosschain' && <CrossChain   wallet={wallet} />}
        {tab === 'orders'     && <Orders        wallet={wallet} />}
        {tab === 'explore'    && <Explore />}
        {tab === 'simulate'   && <Simulate      wallet={wallet} />}
        {tab === 'admin'      && <Admin />}
      </main>
    </div>
  )
}

export default function App() {
  return (
    <AppConfigProvider>
      <Inner />
    </AppConfigProvider>
  )
}
