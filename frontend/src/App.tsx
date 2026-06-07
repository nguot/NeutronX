import { useState } from 'react'
import { useWallet } from './hooks/useWallet'
import DutchAuction from './pages/DutchAuction'
import CrossChain   from './pages/CrossChain'

type Tab = 'dutch' | 'crosschain'

export default function App() {
  const [tab, setTab] = useState<Tab>('dutch')
  const { wallet, error, connect } = useWallet()

  return (
    <>
      <h1>NeutronX</h1>
      <p className="sub">DEX aggregator — Dutch auction fills + cross-chain HTLC swaps</p>

      {/* ── Wallet bar ── */}
      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        {wallet.connected ? (
          <span style={{ color: '#4ade80', fontSize: '0.82em' }}>
            ● {wallet.account.slice(0,6)}…{wallet.account.slice(-4)} &nbsp;|&nbsp; block #{wallet.blockNumber}
          </span>
        ) : (
          <button onClick={connect}>Connect MetaMask</button>
        )}
        {error && <span style={{ color: '#f87171', fontSize: '0.8em' }}>{error}</span>}
      </div>

      {/* ── Tabs ── */}
      <div className="tabs" style={{ marginTop: 20 }}>
        <button className={`tab-btn ${tab === 'dutch'      ? 'active' : ''}`} onClick={() => setTab('dutch')}>
          Dutch Auction
        </button>
        <button className={`tab-btn ${tab === 'crosschain' ? 'active' : ''}`} onClick={() => setTab('crosschain')}>
          Cross-Chain
        </button>
      </div>

      {tab === 'dutch'      && <DutchAuction wallet={wallet} />}
      {tab === 'crosschain' && <CrossChain   wallet={wallet} />}
    </>
  )
}
