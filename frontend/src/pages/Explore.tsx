interface TokenInfo { symbol: string; address: string; decimals: number; chainId: number; note: string }
interface ChainInfo { id: number; name: string; role: string; rpcUrl: string }

const CHAINS: ChainInfo[] = [
  { id: 31337, name: 'Anvil — Chain A', role: 'Source chain (swapper funds locked here)',  rpcUrl: 'http://127.0.0.1:8545' },
  { id: 31338, name: 'Anvil — Chain B', role: 'Destination chain (filler output tokens)',  rpcUrl: 'http://127.0.0.1:8546' },
]

const TOKENS: TokenInfo[] = [
  { symbol: 'WETH',    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, chainId: 31337, note: 'Input token — wrap ETH via deposit()' },
  { symbol: 'Permit2', address: '0x000000000022D473030F116dDEE9F6B43aC78BA3', decimals: 0,  chainId: 31337, note: 'Approval router used by both reactors' },
  { symbol: 'USDC',    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6,  chainId: 31338, note: 'Output token on the destination chain' },
]

function copy(text: string) { navigator.clipboard?.writeText(text) }

export default function Explore() {
  return (
    <>
      <div className="page-header">
        <div className="page-title">Explore</div>
        <div className="page-sub">
          Tokens and chains configured for this devnet. Addresses match
          {' '}<code>tests/crosschain/setup_cc.sh</code> — click any address to copy.
        </div>
      </div>

      <div className="status warn" style={{ marginBottom: 20 }}>
        Static directory — no live backend endpoint for token/chain metadata.
        These are hardcoded from the devnet setup scripts.
      </div>

      <div className="card">
        <h2>Chains</h2>
        {CHAINS.map(c => (
          <div key={c.id} className="slot-card" style={{ marginBottom: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <span className="badge chain">chain {c.id}</span>
              <strong style={{ fontSize: '0.88rem' }}>{c.name}</strong>
            </div>
            <div style={{ fontSize: '0.78rem', color: '#64748b', marginBottom: 4 }}>{c.role}</div>
            <div style={{ fontSize: '0.78rem' }}>
              <span style={{ color: '#94a3b8' }}>RPC: </span>
              <code onClick={() => copy(c.rpcUrl)} style={{ cursor: 'pointer' }} title="click to copy">{c.rpcUrl}</code>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Tokens</h2>
        {TOKENS.map(t => (
          <div key={`${t.chainId}-${t.address}`} className="slot-card" style={{ marginBottom: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <span className="badge chain">chain {t.chainId}</span>
              <strong style={{ fontSize: '0.88rem' }}>{t.symbol}</strong>
              <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>{t.decimals} decimals</span>
            </div>
            <div style={{ fontSize: '0.78rem', marginBottom: 4 }}>
              <span style={{ color: '#94a3b8' }}>address: </span>
              <code onClick={() => copy(t.address)} style={{ cursor: 'pointer' }} title="click to copy">{t.address}</code>
            </div>
            <div style={{ fontSize: '0.75rem', color: '#64748b' }}>{t.note}</div>
          </div>
        ))}
      </div>
    </>
  )
}
