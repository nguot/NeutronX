import { useState } from 'react'
import type { WalletState } from '../hooks/useWallet'
import { useAppConfig } from '../context/AppConfig'

interface FillerQuote {
  filler:          string
  wouldFill:       boolean
  fillAmount:      string
  fillAmountHuman: string
  auctionPrice:    string
  reason:          string
  metadata:        Record<string, unknown>
  error?:          string
}

interface SimulateResult {
  inputToken:             string
  outputToken:            string
  inputAmount:            string
  quotes:                 FillerQuote[]
  totalFillAmount:        string
  totalFillHuman:         string
  remainingAmount:        string
  remainingHuman:         string
  remainingWouldFallback: boolean
}

export default function Simulate({ wallet }: { wallet: WalletState }) {
  const { backendUrl } = useAppConfig()

  const [form, setForm] = useState({
    inputToken: '', outputToken: '', inputAmount: '',
    startPrice: '', decayPerBlock: '0',
    currentBlock: String(wallet.blockNumber || ''), deadline: '', minFillBps: '1000',
  })

  const [result, setResult] = useState<SimulateResult | null>(null)
  const [status, setStatus] = useState<{ msg: string; cls: string } | null>(null)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function runSimulation() {
    if (!form.inputToken || !form.outputToken || !form.inputAmount || !form.startPrice) {
      return setStatus({ msg: 'inputToken, outputToken, inputAmount and startPrice are required', cls: 'bad' })
    }

    setResult(null)
    setStatus({ msg: 'Querying registered fillers…', cls: 'info' })
    try {
      const body: Record<string, unknown> = {
        inputToken:    form.inputToken,
        outputToken:   form.outputToken,
        inputAmount:   form.inputAmount,
        startPrice:    form.startPrice,
        decayPerBlock: parseInt(form.decayPerBlock || '0'),
      }
      if (form.currentBlock) body.currentBlock = parseInt(form.currentBlock)
      if (form.deadline)     body.deadline     = parseInt(form.deadline)
      if (form.minFillBps)   body.minFillBps   = parseInt(form.minFillBps)

      const res  = await fetch(`${backendUrl}/simulate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Backend error')
      setResult(data)
      setStatus({ msg: `Got quotes from ${data.quotes.length} filler(s).`, cls: 'ok' })
    } catch (e: any) {
      setStatus({ msg: e.message, cls: 'bad' })
    }
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title">Simulate Order</div>
        <div className="page-sub">
          Preview how registered fillers would respond to a Dutch-auction order — without signing or paying gas.
          Wraps <code>POST /simulate</code>.
        </div>
      </div>

      <div className="card">
        <h2>Order Parameters</h2>
        <div className="row">
          <div><label>Input Token</label><input value={form.inputToken}  onChange={set('inputToken')}  placeholder="0x… (e.g. WETH)" /></div>
          <div><label>Output Token</label><input value={form.outputToken} onChange={set('outputToken')} placeholder="0x… (e.g. USDC)" /></div>
        </div>
        <div className="row">
          <div><label>Input Amount (wei)</label><input value={form.inputAmount} onChange={set('inputAmount')} placeholder="4000000000000000000" /></div>
          <div><label>Start Price (scaled 1e18)</label><input value={form.startPrice} onChange={set('startPrice')} placeholder="e.g. 2500000000000000000000" /></div>
        </div>
        <div className="row">
          <div><label>Decay Per Block</label><input value={form.decayPerBlock} onChange={set('decayPerBlock')} className="short" /></div>
          <div><label>Current Block (optional)</label><input value={form.currentBlock} onChange={set('currentBlock')} className="short" /></div>
          <div><label>Deadline (optional)</label><input value={form.deadline} onChange={set('deadline')} className="short" /></div>
          <div><label>Min Fill Bps (optional)</label><input value={form.minFillBps} onChange={set('minFillBps')} className="short" /></div>
        </div>
        <button onClick={runSimulation}>Run Simulation</button>
        {status && <div className={`status ${status.cls}`}>{status.msg}</div>}
      </div>

      {result && (
        <div className="card">
          <h2>Results</h2>
          <div style={{ display: 'flex', gap: 24, marginBottom: 16, flexWrap: 'wrap' }}>
            <Stat label="Total willing to fill" value={result.totalFillHuman} accent />
            <Stat label="Remaining" value={result.remainingHuman} />
            {result.remainingWouldFallback && (
              <Stat label="Fallback" value="→ AlphaRouter" warn />
            )}
          </div>

          {result.quotes.map(q => (
            <div key={q.filler} className={`slot-card ${q.wouldFill ? 'claimed' : ''}`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span className={`tag ${q.wouldFill ? 'claimed' : 'available'}`}>
                  {q.wouldFill ? 'would fill' : 'would skip'}
                </span>
                <strong style={{ fontSize: '0.88rem' }}>{q.filler}</strong>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px 16px', fontSize: '0.78rem' }}>
                <div><span style={{ color: '#64748b' }}>fill amount: </span>{q.fillAmountHuman}</div>
                <div><span style={{ color: '#64748b' }}>auction price: </span>{q.auctionPrice}</div>
                <div><span style={{ color: '#64748b' }}>reason: </span>{q.reason}</div>
              </div>
              {Object.keys(q.metadata).length > 0 && (
                <div style={{ marginTop: 6, fontSize: '0.72rem', color: '#64748b' }}>
                  metadata: <code>{JSON.stringify(q.metadata)}</code>
                </div>
              )}
              {q.error && <div style={{ color: '#dc2626', fontSize: '0.75rem', marginTop: 4 }}>error: {q.error}</div>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function Stat({ label, value, accent, warn }: { label: string; value: string; accent?: boolean; warn?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginBottom: 2 }}>{label}</div>
      <div style={{
        fontSize: '1.1rem', fontWeight: 700,
        color: warn ? '#d97706' : accent ? '#7c3aed' : '#0f172a'
      }}>{value}</div>
    </div>
  )
}
