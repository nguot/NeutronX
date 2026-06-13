import http from 'http'
import { provider, wallet } from '../contract/contracts'
import { decide } from '../strategy/strategy'
import { devFill } from '../dev/devFill'
import { ccFill, ccClaimSlot } from '../dev/ccFill'
import type { OrderInfo } from '../types'
import * as dotenv from 'dotenv'
dotenv.config()

const FILLER_NAME = 'WhaleFiller'
const PORT        = parseInt(process.env.QUOTE_PORT ?? '3001')
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3000'

const SYMBOLS: Record<string,string> = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2':'WETH',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':'USDC',
  '0xdac17f958d2ee523a2206206994597c13d831ec7':'USDT',
  '0x6b175474e89094c44da98b954eedeac495271d0f':'DAI',
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599':'WBTC',
  '0x514910771af9ca656af840dff83e8264ecf986ca':'LINK',
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984':'UNI',
}
const DECIMALS: Record<string,number> = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2':18,
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':6,
  '0xdac17f958d2ee523a2206206994597c13d831ec7':6,
  '0x6b175474e89094c44da98b954eedeac495271d0f':18,
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599':8,
  '0x514910771af9ca656af840dff83e8264ecf986ca':18,
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984':18,
}

// ── Dev UI HTML (PowerShell-console aesthetic) ─────────────────────────────────
function buildHtml(): string {
  const syms = JSON.stringify(SYMBOLS)
  const decs = JSON.stringify(DECIMALS)

  // ASCII box banner, width derived from the title so the borders always align.
  const title = `NeutronX · ${FILLER_NAME} · dev console`
  const inner = ` ${title} `
  const banner =
    `┌${'─'.repeat(inner.length)}┐\n` +
    `│${inner}│\n` +
    `└${'─'.repeat(inner.length)}┘`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${FILLER_NAME} · PS</title>
<style>
  :root{
    --accent:#c586c0; --prompt:#569cd6; --hi:#dcdcaa;
    --ok:#4ec9b0; --no:#f48771; --busy:#dcdcaa;
    --bg:#012456; --panel:#001a3f; --fg:#d6dbe8; --dim:#6079a8; --line:#214a8c;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Consolas,'Courier New',monospace;background:var(--bg);color:var(--fg);
       padding:20px;font-size:13px;line-height:1.5}
  .banner{color:var(--accent);white-space:pre;font-size:13px}
  .prompt{margin-top:6px}
  .prompt .ps{color:var(--prompt)}
  .prompt .cmd{color:var(--fg)}
  .sub{color:var(--dim);margin:4px 0 16px}
  .toolbar{margin-bottom:16px;display:flex;gap:10px;align-items:center}
  button{background:transparent;color:var(--fg);border:1px solid var(--line);
         padding:3px 10px;cursor:pointer;font-family:inherit;font-size:12px}
  button:hover{background:var(--fg);color:var(--bg)}
  #blocknum{color:var(--dim);font-size:12px}
  .order{border:1px solid var(--line);background:var(--panel);padding:12px 14px;margin-bottom:10px}
  .order-header{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
  .hash{color:var(--hi);font-weight:bold;word-break:break-all}
  .badge{font-size:11px;padding:0 7px;border:1px solid var(--line);color:var(--prompt)}
  .badge.active{color:var(--ok);border-color:#2a6a4a}
  .badge.pending{color:var(--prompt)}
  .pair{color:var(--fg);font-weight:bold}
  .dim{color:var(--dim);font-size:11px}
  .prog{color:var(--accent);white-space:pre;margin:6px 0 2px;letter-spacing:1px}
  .prog-label{color:var(--dim);font-size:12px;margin-bottom:8px}
  .controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px}
  input[type=range]{flex:1;min-width:120px;accent-color:var(--hi);height:6px}
  .pct{min-width:44px;color:var(--hi);font-weight:bold}
  .result{margin-top:8px;color:var(--dim);min-height:20px;word-break:break-all}
  .result::before{content:'> ';color:var(--dim)}
  .result.ok{color:var(--ok)} .result.ok::before{content:'> ';color:var(--ok)}
  .result.no{color:var(--no)} .result.no::before{content:'! ';color:var(--no)}
  .result.busy{color:var(--busy)} .result.busy::before{content:'… ';color:var(--busy)}
  .empty{color:var(--dim);padding:24px;text-align:center}
  .section-title{color:var(--accent);font-weight:bold;margin:24px 0 4px;
                 border-top:1px dashed var(--line);padding-top:16px}
  .slot-grid{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
  .slot-btn{min-width:74px;padding:5px 4px;border:1px solid var(--line);background:transparent;
            color:var(--fg);font-family:inherit;font-size:11px;cursor:pointer;text-align:center;line-height:1.4}
  .slot-btn.available{color:var(--ok);border-color:#2a6a4a}
  .slot-btn.available:hover{background:var(--ok);color:var(--bg)}
  .slot-btn.locked{color:var(--dim);border-color:var(--line);cursor:not-allowed}
  .slot-btn.claimed{color:var(--ok);border-color:var(--line);cursor:not-allowed}
  .slot-btn.busy{color:var(--busy);border-color:#5a4a1a;cursor:not-allowed}
</style>
</head>
<body>
<pre class="banner">${banner}</pre>
<div class="prompt"><span class="ps">PS C:\\NeutronX\\${FILLER_NAME}&gt;</span> <span class="cmd">Watch-Orders -Status pending,active</span></div>
<div class="sub">wallet ${wallet.address} · port ${PORT}</div>
<div class="toolbar">
  <button onclick="load()">[ ↻ refresh ]</button>
  <span id="blocknum"></span>
</div>
<div id="orders"><div class="empty">Loading…</div></div>

<div class="section-title">⛓ Cross-Chain Orders</div>
<div class="dim" style="margin-bottom:12px">Orders with available Merkle slots — fill a slot to earn WETH on Chain A by locking USDC on Chain B</div>
<div id="cc-orders"><div class="empty">Loading…</div></div>

<script>
const BACKEND='${BACKEND_URL}'
const SYMS=${syms}
const DECS=${decs}

function sym(addr){return SYMS[addr.toLowerCase()]??addr.slice(0,8)+'…'}
function dec(addr){return DECS[addr.toLowerCase()]??18}
// Full-precision token amount (wei -> decimal string), no rounding/truncation —
// .toFixed(4) used to show "0.0000" for genuinely-nonzero high-decimal amounts (e.g. WBTC).
function human(raw,addr){
  const d=dec(addr)
  const s=BigInt(raw||'0').toString().padStart(d+1,'0')
  const intPart=s.slice(0,s.length-d)
  const frac=s.slice(s.length-d).replace(/0+$/,'')
  return frac?intPart+'.'+frac:intPart
}
// Full-precision non-negative ratio -> decimal string.
function ratio(num,den,precision){
  let intPart=num/den, rem=num%den, frac=''
  for(let i=0;i<precision&&rem>0n;i++){rem*=10n;frac+=(rem/den).toString();rem%=den}
  frac=frac.replace(/0+$/,'')
  return frac?intPart.toString()+'.'+frac:intPart.toString()
}
// price is the contract's 1e18-scaled outputWei/inputWei rate (OrderInfo.startPrice units);
// human price = price/1e18 * 10^inDec/10^outDec, matching tokens.tsx's contractToHumanPrice.
function priceHumanStr(price,inAddr,outAddr){
  return ratio(price*10n**BigInt(dec(inAddr)), 10n**18n*10n**BigInt(dec(outAddr)), 18)
}
function bar(pct){var n=24;var f=Math.max(0,Math.min(n,Math.round(pct/100*n)));return '['+'█'.repeat(f)+'░'.repeat(n-f)+']'}

async function load(){
  const [r1,r2,blk]=await Promise.all([
    fetch(BACKEND+'/orders?status=pending&limit=20').then(r=>r.json()).catch(()=>({orders:[]})),
    fetch(BACKEND+'/orders?status=active&limit=20').then(r=>r.json()).catch(()=>({orders:[]})),
    fetch('/health').then(r=>r.json()).catch(()=>({})),
  ])
  const currentBlock=blk.block??0
  document.getElementById('blocknum').textContent='block #'+currentBlock
  const orders=[...(r1.orders??[]),...(r2.orders??[])]
  const div=document.getElementById('orders')
  if(!orders.length){div.innerHTML='<div class="empty">No open orders.</div>';return}

  const details=await Promise.all(
    orders.map(o=>fetch(BACKEND+'/orders/'+o.hash).then(r=>r.json()).catch(()=>null))
  )

  const saved={}
  document.querySelectorAll('input[type=range]').forEach(el=>{if(el.id.startsWith('sl-'))saved[el.id.slice(3)]=el.value})

  div.innerHTML=orders.map((o,i)=>{
    const d=details[i]
    const inSym=sym(o.inputToken), outSym=sym(o.outputToken)
    const inputAmt=BigInt(o.inputAmount||'0')

    const fills=d?.fills??[]
    const filled=fills.reduce((s,f)=>s+BigInt(f.fillAmount??'0'),0n)
    const remaining=inputAmt>filled?inputAmt-filled:0n
    const filledPct=inputAmt>0n?Number(filled*100n/inputAmt):0

    const lastFillBlock=fills.length>0?(fills[fills.length-1].blockNumber??currentBlock):currentBlock
    const blocksPassed=Math.max(0,currentBlock-lastFillBlock)
    const sp=BigInt(d?.startPrice??o.startPrice??'0')
    const dpb=BigInt(d?.decayPerBlock??o.decayPerBlock??'0')
    const price=sp>dpb*BigInt(blocksPassed)?sp-dpb*BigInt(blocksPassed):0n
    const priceHuman=priceHumanStr(price,o.inputToken,o.outputToken)

    const blocksLeft=Math.max(0,o.deadline-currentBlock)

    return \`<div class="order" id="o-\${o.hash}">
      <div class="order-header">
        <span class="hash">\${o.hash}</span>
        <span class="badge \${o.status}">\${o.status}</span>
        <span class="pair">\${inSym} → \${outSym}</span>
        <span class="dim">\${blocksLeft} blocks left</span>
      </div>
      <div class="prog">\${bar(filledPct)} \${filledPct.toFixed(1)}%</div>
      <div class="prog-label">
        \${human(filled.toString(),o.inputToken)} \${inSym} filled &nbsp;·&nbsp;
        \${human(remaining.toString(),o.inputToken)} \${inSym} remaining
        \${price>0n?' &nbsp;·&nbsp; price: '+priceHuman+' '+outSym+'/'+inSym:''}
      </div>
      <div class="controls">
        <button onclick="simulate('\${o.hash}')">[ sim ]</button>
        <input type="range" min="10" max="100" step="10" value="50"
          oninput="document.getElementById('p-\${o.hash}').textContent=this.value+'%'"
          id="sl-\${o.hash}">
        <span class="pct" id="p-\${o.hash}">50%</span>
        <button onclick="fill('\${o.hash}')">[ fill ]</button>
      </div>
      <div class="result" id="r-\${o.hash}">idle</div>
    </div>\`
  }).join('')

  for(const[hash,val]of Object.entries(saved)){
    const sl=document.getElementById('sl-'+hash)
    const p=document.getElementById('p-'+hash)
    if(sl){sl.value=val;if(p)p.textContent=val+'%'}
  }
}

async function simulate(hash){
  const el=document.getElementById('r-'+hash)
  el.className='result busy'; el.textContent='Computing preview…'
  try{
    const [detail,blk]=await Promise.all([
      fetch(BACKEND+'/orders/'+hash).then(r=>r.json()),
      fetch('/health').then(r=>r.json()).catch(()=>({}))
    ])
    const currentBlock=blk.block??0
    const sliderPct=parseInt(document.getElementById('sl-'+hash).value)

    const fills=detail.fills??[]
    const filled=fills.reduce((s,f)=>s+BigInt(f.fillAmount??'0'),0n)
    const inputAmt=BigInt(detail.inputAmount||'0')
    const remaining=inputAmt>filled?inputAmt-filled:0n

    if(remaining===0n){el.className='result no';el.textContent='order already fully filled';return}

    const lastBlock=fills.length>0?(fills[fills.length-1].blockNumber??currentBlock):currentBlock
    const blocksPassed=BigInt(Math.max(0,currentBlock-lastBlock))
    const sp=BigInt(detail.startPrice||'0')
    const dpb=BigInt(detail.decayPerBlock||'0')
    const price=sp>dpb*blocksPassed?sp-dpb*blocksPassed:0n

    if(price===0n){el.className='result no';el.textContent='price decayed to zero';return}

    const fillAmt=remaining*BigInt(sliderPct)/100n
    const minFill=inputAmt*BigInt(detail.minFillBps||100)/10000n
    let actualFill=fillAmt<minFill?minFill:fillAmt
    if(actualFill>remaining)actualFill=remaining  // final chunk completes the order, even if below minFill
    const outputNeeded=actualFill*price/(10n**18n)

    // Honor the swapper's minOutput floor — the reactor reverts any fill whose
    // output is below it. Without this the preview shows a fill the on-chain tx rejects.
    const minOutput=BigInt(detail.minOutput||'0')
    const requiredOut=inputAmt>0n?actualFill*minOutput/inputAmt:0n
    if(outputNeeded<requiredOut){
      const oSym=sym(detail.outputToken)
      el.className='result no'
      el.textContent='would REVERT — fill provides '+human(outputNeeded.toString(),detail.outputToken)+' '+oSym
        +' < swapper minimum '+human(requiredOut.toString(),detail.outputToken)+' '+oSym+' (auction price below floor)'
      return
    }

    const filledPctAfter=inputAmt>0n?Number((filled+actualFill)*100n/inputAmt):0

    const inSym=sym(detail.inputToken),outSym=sym(detail.outputToken)
    const priceH=priceHumanStr(price,detail.inputToken,detail.outputToken)

    el.className='result ok'
    el.textContent='receive '+human(actualFill.toString(),detail.inputToken)+' '+inSym
      +' · you provide '+human(outputNeeded.toString(),detail.outputToken)+' '+outSym
      +' · price '+priceH+' '+outSym+'/'+inSym
      +' · fills to '+filledPctAfter.toFixed(1)+'%'
  }catch(e){el.className='result no';el.textContent='Error: '+e.message}
}

async function fill(hash){
  const fillBps=parseInt(document.getElementById('sl-'+hash).value)*100
  const el=document.getElementById('r-'+hash)
  el.className='result busy'; el.textContent='Filling… (fund → approve → register → execute, ~10s)'
  try{
    const r=await fetch('/dev-fill',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({orderHash:hash,fillBps})})
    const data=await r.json()
    if(!r.ok) throw new Error(data.error??JSON.stringify(data))
    el.className='result ok'
    el.textContent='tx: '+data.txHash+' — waiting for indexer…'
    let n=5
    const poll=()=>{load();if(--n>0)setTimeout(poll,1500)}
    setTimeout(poll,1000)
  }catch(e){
    el.className='result no'
    el.textContent=(e.message??String(e)).slice(0,400)
  }
}

async function ccLoad(){
  const ccDiv=document.getElementById('cc-orders')
  try{
    const [r,blk]=await Promise.all([
      fetch(BACKEND+'/cc/orders').then(r=>r.json()).catch(()=>({orders:[]})),
      fetch('/health').then(r=>r.json()).catch(()=>({})),
    ])
    const currentBlock=blk.block??0
    const orders=r.orders??[]
    if(!orders.length){ccDiv.innerHTML='<div class="empty">No cross-chain orders with available slots.</div>';return}
    ccDiv.innerHTML=orders.map(o=>{
      const inSym=sym(o.inputToken),outSym=sym(o.outputToken)
      const slotAmt=BigInt(o.minOutput)/BigInt(o.numSlots)
      const blocksLeft=Math.max(0,o.deadline-currentBlock)
      const slots=o.slots??[]
      const slotsHtml=slots.map(s=>{
        const id=\`cc-btn-\${o.orderHash}-\${s.index}\`
        if(s.status==='available')
          return \`<button class="slot-btn available" id="\${id}" onclick="ccFillSlot('\${o.orderHash}',\${s.index})">Slot \${s.index}<br>▶ Fill</button>\`
        if(s.status==='locked')
          return \`<button class="slot-btn locked" id="\${id}" onclick="ccResetLocked('\${o.orderHash}',\${s.index})" title="Reset stuck locked slot — only use if Chain B was restarted">Slot \${s.index}<br>↺ Reset</button>\`
        if(s.status==='claimed'){
          const mine=!s.assignedFiller||s.assignedFiller.toLowerCase()==='${wallet.address.toLowerCase()}'
          if(mine)
            return \`<button class="slot-btn available" id="\${id}" onclick="ccClaimSlot('\${o.orderHash}',\${s.index})" title="Backend claimed USDC — collect your WETH on Chain A">Slot \${s.index}<br>⚡ Claim WETH</button>\`
          return \`<button class="slot-btn locked" id="\${id}" disabled title="Filled by \${s.assignedFiller}">Slot \${s.index}<br>🔒 Other filler</button>\`
        }
        return \`<button class="slot-btn claimed" id="\${id}" disabled>Slot \${s.index}<br>✓ done</button>\`
      }).join('')
      return \`<div class="order" id="cco-\${o.orderHash}">
        <div class="order-header">
          <span class="hash">\${o.orderHash}</span>
          <span class="badge active">cross-chain</span>
          <span class="pair">\${inSym} → \${outSym}</span>
          <span class="dim">\${blocksLeft} blocks left</span>
        </div>
        <div class="prog-label">
          \${human(o.inputAmount,o.inputToken)} \${inSym} total
          &nbsp;·&nbsp; \${human(slotAmt.toString(),o.outputToken)} \${outSym}/slot
          &nbsp;·&nbsp; \${o.numSlots} slots
        </div>
        <div class="slot-grid">\${slotsHtml}</div>
        <div class="result" id="cc-r-\${o.orderHash}">idle</div>
      </div>\`
    }).join('')
  }catch(e){
    ccDiv.innerHTML='<div class="empty">CC unavailable: '+e.message+'</div>'
  }
}

async function ccClaimSlot(hash,slotIndex){
  const resultEl=document.getElementById('cc-r-'+hash)
  const btnEl=document.getElementById('cc-btn-'+hash+'-'+slotIndex)
  resultEl.className='result busy'
  resultEl.textContent='Slot '+slotIndex+': reading S_i from Chain B → withdraw on Chain A…'
  if(btnEl){btnEl.disabled=true;btnEl.className='slot-btn busy';btnEl.innerHTML='Slot '+slotIndex+'<br>⏳ claiming'}
  try{
    const r=await fetch('/dev-cc-claim',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({orderHash:hash,slotIndex})})
    const data=await r.json()
    if(!r.ok) throw new Error(data.error??JSON.stringify(data))
    if(data.txHash==='reset-to-available'){
      resultEl.className='result busy'
      resultEl.textContent='↺ slot '+slotIndex+' Chain B stale (Chain B restarted) — slot reset to available, click ▶ Fill'
      setTimeout(()=>ccLoad(),800)
    } else {
      resultEl.className='result ok'
      if(data.txHash==='already-claimed'){
        resultEl.textContent='slot '+slotIndex+' was already claimed on-chain — marked done'
      } else {
        resultEl.textContent='slot '+slotIndex+' WETH withdrawn on Chain A  tx: '+data.txHash
      }
      if(btnEl){btnEl.className='slot-btn claimed';btnEl.innerHTML='Slot '+slotIndex+'<br>✓ done';btnEl.disabled=true}
      setTimeout(()=>ccLoad(),2000)
    }
  }catch(e){
    resultEl.className='result no'
    resultEl.textContent='slot '+slotIndex+': '+(e.message??String(e)).slice(0,500)
    if(btnEl){btnEl.className='slot-btn available';btnEl.innerHTML='Slot '+slotIndex+'<br>⚡ Claim WETH';btnEl.disabled=false}
  }
}

async function ccResetLocked(hash,slotIndex){
  const resultEl=document.getElementById('cc-r-'+hash)
  const btnEl=document.getElementById('cc-btn-'+hash+'-'+slotIndex)
  resultEl.className='result busy'
  resultEl.textContent='Resetting slot '+slotIndex+' to available…'
  if(btnEl){btnEl.disabled=true;btnEl.className='slot-btn busy';btnEl.innerHTML='Slot '+slotIndex+'<br>⏳'}
  try{
    const r=await fetch(BACKEND+'/cc/orders/'+hash+'/slots/'+slotIndex+'/reset',{
      method:'PATCH',headers:{'Content-Type':'application/json'}})
    const data=await r.json()
    if(!r.ok) throw new Error(data.error??JSON.stringify(data))
    resultEl.className='result ok'
    resultEl.textContent='↺ slot '+slotIndex+' reset to available — click ▶ Fill to re-fill'
    setTimeout(()=>ccLoad(),500)
  }catch(e){
    resultEl.className='result no'
    resultEl.textContent='reset failed: '+(e.message??String(e))
    if(btnEl){btnEl.disabled=false;btnEl.className='slot-btn locked';btnEl.innerHTML='Slot '+slotIndex+'<br>↺ Reset'}
  }
}

async function ccFillSlot(hash,slotIndex){
  const resultEl=document.getElementById('cc-r-'+hash)
  const btnEl=document.getElementById('cc-btn-'+hash+'-'+slotIndex)
  resultEl.className='result busy'
  resultEl.textContent='Slot '+slotIndex+': fillSlot → fund Chain B → deploy escrow → wait S_i → withdraw (~30s)…'
  if(btnEl){btnEl.disabled=true;btnEl.className='slot-btn busy';btnEl.innerHTML='Slot '+slotIndex+'<br>⏳ filling'}
  try{
    const r=await fetch('/dev-cc-fill',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({orderHash:hash,slotIndex})})
    const data=await r.json()
    if(!r.ok) throw new Error(data.error??JSON.stringify(data))
    resultEl.className='result ok'
    resultEl.textContent='slot '+slotIndex+' WETH withdrawn on Chain A  tx: '+data.txHash
    if(btnEl){btnEl.className='slot-btn claimed';btnEl.innerHTML='Slot '+slotIndex+'<br>✓';btnEl.disabled=true}
    setTimeout(()=>ccLoad(),2000)
  }catch(e){
    resultEl.className='result no'
    resultEl.textContent='slot '+slotIndex+': '+(e.message??String(e)).slice(0,500)
    if(btnEl){btnEl.className='slot-btn available';btnEl.innerHTML='Slot '+slotIndex+'<br>▶ Fill';btnEl.disabled=false}
  }
}

load()
ccLoad()
setInterval(load,12000)
setInterval(ccLoad,15000)
</script>
</body>
</html>`
}

interface QuoteRequest {
  inputToken:    string
  outputToken:   string
  inputAmount:   string
  startPrice:    string
  decayPerBlock: number
  currentBlock?: number
  deadline?:     number
  minFillBps?:   number
}

function buildFakeOrder(req: QuoteRequest, currentBlock: number): OrderInfo {
  return {
    hash:          '0x' + '0'.repeat(64),
    swapper:       '0x' + '0'.repeat(40),
    inputToken:    req.inputToken,
    outputToken:   req.outputToken,
    inputAmount:   req.inputAmount,
    minOutput:     '0',
    deadline:      req.deadline ?? currentBlock + 100,
    nonce:         0,
    minFillBps:    req.minFillBps ?? 100,
    startPrice:    req.startPrice,
    decayPerBlock: req.decayPerBlock,
    feeTier:       500,
    signature:     '0x' + '0'.repeat(130),
    status:        'pending',
    fills:         [],
  }
}

function cors(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  cors(res)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

export function startQuoteServer(): void {
  const server = http.createServer(async (req, res) => {
    cors(res)

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // GET / → dev UI
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(buildHtml())
      return
    }

    // GET /health
    if (req.method === 'GET' && req.url === '/health') {
      const block = await provider.getBlockNumber().catch(() => null)
      json(res, 200, { ok: true, filler: FILLER_NAME, block })
      return
    }

    // POST endpoints — read body first
    if (req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body)

          // POST /quote
          if (req.url === '/quote') {
            const quoteReq: QuoteRequest = payload
            const currentBlock = quoteReq.currentBlock ?? await provider.getBlockNumber()
            const order        = buildFakeOrder(quoteReq, currentBlock)
            const decision     = await decide(order, currentBlock)

            const inDecimals  = 18
            const outDecimals = 6
            json(res, 200, {
              filler:          FILLER_NAME,
              wouldFill:       decision.shouldFill,
              fillAmount:      decision.fillAmount.toString(),
              fillAmountHuman: `${(Number(decision.fillAmount) / 10 ** inDecimals).toFixed(4)} WETH`,
              auctionPrice:    `${(Number(decision.currentPrice) / 10 ** outDecimals).toFixed(4)} USDC`,
              reason:          decision.reason ?? 'no fill',
              metadata:        (decision as any).extras ?? {},
            })
            return
          }

          // POST /dev-fill
          if (req.url === '/dev-fill') {
            const { orderHash, fillBps } = payload as { orderHash: string; fillBps: number }
            if (!orderHash || !fillBps) {
              json(res, 400, { error: 'Missing orderHash or fillBps' }); return
            }
            const txHash = await devFill(orderHash, fillBps)
            json(res, 200, { txHash })
            return
          }

          // POST /dev-cc-fill
          if (req.url === '/dev-cc-fill') {
            const { orderHash, slotIndex } = payload as { orderHash: string; slotIndex: number }
            if (!orderHash || slotIndex === undefined) {
              json(res, 400, { error: 'Missing orderHash or slotIndex' }); return
            }
            const txHash = await ccFill(orderHash, slotIndex)
            json(res, 200, { txHash })
            return
          }

          // POST /dev-cc-claim  (recovery: backend claimed but filler timed out)
          if (req.url === '/dev-cc-claim') {
            const { orderHash, slotIndex } = payload as { orderHash: string; slotIndex: number }
            if (!orderHash || slotIndex === undefined) {
              json(res, 400, { error: 'Missing orderHash or slotIndex' }); return
            }
            const txHash = await ccClaimSlot(orderHash, slotIndex)
            json(res, 200, { txHash })
            return
          }

          json(res, 404, { error: 'Not found' })
        } catch (e: any) {
          json(res, 500, { error: e?.message ?? e?.reason ?? String(e) })
        }
      })
      return
    }

    json(res, 404, { error: 'Not found' })
  })

  server.listen(PORT, () => {
    console.log(`[${FILLER_NAME}] quote server on http://localhost:${PORT}`)
    console.log(`[${FILLER_NAME}] dev UI      on http://localhost:${PORT}/`)
  })
}
