# Drill: code thêm tại chỗ khi phản biện

Hai ask thực tế nhất: **thêm API backend** và **viết thêm Foundry test**. Mấu chốt không phải nghĩ ra tính năng mà là **nhớ scaffold** để gõ nhanh, tự tin. Drill 2-3 cái trước để thành cơ bắp.

---

## A. THÊM API BACKEND (Express + pg)

### A1. Ask hay gặp (xếp khả năng)
1. **GET orders theo swapper** — `GET /orders/by-swapper/:addr` liệt kê lệnh của một địa chỉ.
2. **GET fill history của 1 lệnh** — `GET /orders/:hash/fills`.
3. **GET thống kê** — số lệnh active, tổng volume, số filler.
4. **GET trạng thái 1 lệnh** — `GET /orders/:hash`.

### A2. Scaffold (copy mẫu từ `routes/suggest.ts`)
File mới `backend/src/routes/myroute.ts`:
```ts
import { Router, Request, Response } from 'express'
import { db } from '../db/client'          // pg pool, dùng db.query

const router = Router()

router.get('/:swapper', async (req: Request, res: Response) => {
  try {
    const { rows } = await db.query(
      'SELECT hash, status, input_amount, output_token FROM orders WHERE swapper = $1 ORDER BY block_number DESC',
      [req.params.swapper]                  // LUÔN tham số hóa $1, không nối chuỗi
    )
    res.json(rows)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
```
Đăng ký trong `backend/src/index.ts` (2 dòng):
```ts
import myRouter from './routes/myroute'    // cạnh các import router khác (dòng ~4-13)
app.use('/my-path', myRouter)              // cạnh các app.use('/orders', ...) (dòng ~28-37)
```

### A3. Ví dụ ask "GET /orders/:hash/fills"
```ts
router.get('/:hash/fills', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT filler, fill_amount, output_amount, tx_hash, block_number FROM fills WHERE order_hash = $1 ORDER BY block_number',
      [req.params.hash]
    )
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})
```

### A4. Bẫy / nhớ
- **Quên `app.use(...)` trong index.ts** → route không gắn → 404. Đây là lỗi hay quên nhất.
- **Tên cột phải khớp schema** (xem Phụ lục B của báo cáo): `orders(hash, swapper, input_amount, output_token, status, block_number)`, `fills(order_hash, filler, fill_amount, output_amount, tx_hash, block_number)`. Nếu không chắc cột nào, mở `db/` hoặc một service đang query để xác nhận.
- **Tham số hóa `$1`** (đúng style hiện có) — đừng nối chuỗi (SQL injection).
- **Bọc try/catch** trả `500` — mọi route hiện tại đều vậy.
- Test nhanh: `curl http://localhost:3000/my-path/0x...`.

---

## B. THÊM FOUNDRY TEST (dùng AdversarialBase)

### B1. Ask hay gặp
1. **Revert test** — fill sau deadline / fill lệnh đã hủy / fill dưới minFill bị revert.
2. **Happy-path** — fill 1 lệnh, kiểm output ≥ floor, remaining về 0.
3. **Fuzz** — với mọi `fillAmount` hợp lệ, remaining giảm đúng.
4. **Kịch bản đã bàn** — over-subscription (2 filler đua), fallback loại trừ, fee-on-transfer.

### B2. Scaffold (kế thừa AdversarialBase — đã có sẵn mọi helper)
File mới `contract/test/MyDrill.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "./adversarial/AdversarialBase.sol";

contract MyDrillTest is AdversarialBase {
    address swapper = makeAddr("swapper");
    address filler  = makeAddr("filler");

    function setUp() public {
        _deployCore();               // BẮT BUỘC — dựng reactor/auction/permit2/weth/usdc, vm.roll(100)
    }

    function test_fill_happyPath() public {
        // order: bán 1 WETH, sàn 2000 USDC, nonce 1, deadline = block.number + 100
        PartialFillReactor.SignedOrder memory o =
            _signed(_orderInfo(swapper, 1e18, 2000e6, START_PRICE, 0, 1, block.number + 100));

        _fundSwapper(swapper, 1e18);             // swapper có WETH + approve Permit2
        _fundFiller(filler, 10_000e6, 10 ether); // filler có USDC + approve reactor + ETH cọc
        _register(filler, o, 1e18);              // đăng ký + đặt cọc đúng mức

        vm.prank(filler);
        reactor.executePartialChunk(o, 1e18);    // khớp toàn bộ

        assertEq(usdc.balanceOf(swapper) >= 2000e6, true); // nhận ≥ sàn
    }
}
```

### B3. Ví dụ revert: fill sau deadline
```solidity
function test_fill_afterDeadline_reverts() public {
    PartialFillReactor.SignedOrder memory o =
        _signed(_orderInfo(swapper, 1e18, 2000e6, START_PRICE, 0, 1, block.number + 10));
    _fundSwapper(swapper, 1e18);
    _fundFiller(filler, 10_000e6, 10 ether);
    _register(filler, o, 1e18);

    vm.roll(block.number + 11);             // vượt deadline
    vm.prank(filler);
    vm.expectRevert(bytes("expired"));      // chuỗi revert đúng như trong reactor
    reactor.executePartialChunk(o, 1e18);
}
```

### B4. Ví dụ fuzz
```solidity
function testFuzz_remainingDecreases(uint256 fill) public {
    fill = bound(fill, 1e15, 1e18);          // trong [0.001, 1] WETH
    PartialFillReactor.SignedOrder memory o =
        _signed(_orderInfo(swapper, 1e18, 0, START_PRICE, 0, 1, block.number + 100));
    _fundSwapper(swapper, 1e18);
    _fundFiller(filler, 10_000e6, 10 ether);
    _register(filler, o, fill);

    vm.prank(filler);
    reactor.executePartialChunk(o, fill);
    assertEq(reactor.remainingInput(_hash(o.info), 1e18), 1e18 - fill);
}
```

### B5. Chạy
```bash
# WSL
export PATH="$PATH:$HOME/.foundry/bin"
cd contract && forge test --match-contract MyDrillTest -vvv
```

### B6. Bẫy / nhớ
- **Quên `_deployCore()` trong setUp** → mọi thứ address(0) → revert khó hiểu.
- **Thứ tự bắt buộc:** `_fundSwapper` + `_fundFiller` + `_register` TRƯỚC `executePartialChunk`. Thiếu register → "not registered"; thiếu fund → revert chuyển token.
- **`block.number = 100`** sau `_deployCore` (vm.roll(100)); deadline phải `> block.number`.
- **Oracle tắt** (factory==0) → cọc = fill amount, tất định; dùng `_stake(info, fill)` nếu cần số cọc.
- **Chuỗi revert phải khớp ĐÚNG** chữ trong contract: `"expired"`, `"cancelled"`, `"fallback initiated"`, `"fill > remaining"`, `"not registered"`, `"min output"`...
- **`_hash(info)`** trong harness phải khớp `ORDER_TYPE_HASH` của reactor — nếu ai đó bảo thêm field vào order, sửa CẢ: struct OrderInfo, `ORDER_TYPE_HASH` (reactor), `_hash` (harness), `_hashOrder` (FallbackExecutor), và backend. Quên một bản → chữ ký lệch → revert.

---

## C. VIẾT CONTRACT MỚI / TÍNH NĂNG KHÓ (ask 30-60 phút)

### C0. Khung tư duy 6 bước (áp cho mọi contract)
1. **Một câu: contract làm ĐÚNG việc gì?** → hỏi lại examiner để chốt scope.
2. **State nào phải lưu?** → address, amount, hashlock, timelock, cờ.
3. **Ai gọi gì?** → mỗi actor + hành động = một hàm.
4. **Khung:** SPDX + pragma + state + constructor + hàm stub.
5. **Mỗi hàm theo CEI:** Checks (quyền + require) → Effects (ghi state) → Interactions (chuyển tiền cuối).
6. **Phản xạ an toàn:** `nonReentrant`, pull-payment, event, không bỏ qua return của call, bất biến.

> Mẹo lớn: bạn **đã có reference trong đầu** — EscrowSrc là HTLC, DecayCursorLib là Dutch auction, FillAuction là staking/slashing. Ask "viết mới" thường là **lột gọn cái mình đã có**.

### C1. Skeleton tham chiếu: MiniHTLC
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract MiniHTLC {
    address public immutable depositor;
    address public immutable recipient;
    bytes32 public immutable hashlock;   // keccak256(secret)
    uint256 public immutable timelock;
    bool    public claimed;
    bool    public refunded;
    event Claimed(bytes32 secret);
    event Refunded();

    constructor(address _recipient, bytes32 _hashlock, uint256 _timelock) payable {
        depositor = msg.sender; recipient = _recipient;
        hashlock = _hashlock;   timelock = _timelock;
    }
    function claim(bytes32 secret) external {
        require(!claimed && !refunded, "settled");
        require(keccak256(abi.encode(secret)) == hashlock, "bad secret");
        require(block.timestamp < timelock, "expired");
        claimed = true;                                       // EFFECT trước
        (bool ok,) = recipient.call{value: address(this).balance}(""); require(ok, "xfer");
        emit Claimed(secret);
    }
    function refund() external {
        require(!claimed && !refunded, "settled");
        require(block.timestamp >= timelock, "too early");
        refunded = true;
        (bool ok,) = depositor.call{value: address(this).balance}(""); require(ok, "xfer");
        emit Refunded();
    }
}
```

### C2. So với protocol thật — bạn THIẾU gì (gap → có code được trong 1h?)
| Gap | Code 30-60p? | Đụng |
|---|---|---|
| **Pausable / circuit breaker** | Dễ-TB ✓✓ | modifier vào hàm lõi |
| **Bitmap nonce** (hủy không thứ tự) | TB ✓ | thay mapping nonce |
| **Phí giao thức** (fee → treasury) | TB ✓ | kế toán output |
| **Exclusivity period** (filler độc quyền N block đầu) | TB-Khó ✓ | order + reactor |
| **Role-based access** (OZ AccessControl) | Dễ-TB ✓ | thay owner-only |
| **Native ETH** (không chỉ WETH) | TB ✓ | wrap/unwrap |
| **Slashing theo đường cong** | TB ✓ | DynamicStakeLib |
| **Relayer phi tập trung + bounty** | TB-Khó ✓ | EscrowDst.claim |
| **Batch settlement / giá đồng nhất (CoW)** | Khó, cả tiếng ⚠ | gap kiến trúc lớn nhất |
| **Light-client cross-chain** | Quá khó cho 1h ✗ | ngoài tầm |

### C3. Top 4 ask khó + tư duy nhanh
**1. Pausable (khả năng cao nhất):** kế thừa OZ `Pausable`, thêm `whenNotPaused` vào execute/fillSlot, `pause()/unpause()` onlyOwner. **Gotcha: KHÔNG pause `cancel`/`refund`** — user vẫn phải rút được khi hệ dừng. Điểm ăn: "pause luồng vào, không pause luồng thoát."

**2. Bitmap nonce:** `mapping(uint256=>uint256)`; `word=nonce>>8`, `bit=nonce&0xff`; check `bitmap[word] & (1<<bit)`. Mỗi word 256 nonce — đúng cái Permit2 làm.

**3. Phí giao thức:** sau khi đo `received` (chỗ vừa sửa 3.2), trừ `fee = received*feeBps/10000` gửi treasury. **Gotcha: user vẫn phải ≥ sàn SAU phí.**

**4. Relayer phi tập trung + bounty:** cho bất kỳ ai gọi `claim(secret)` trên EscrowDst, thưởng nhỏ cho người relay. **Vá đúng điểm yếu #1 cosigner** → nối thẳng câu phản biện trustless.

### C4. Meta-strategy ask khó
1. **Tái dùng OpenZeppelin** (`Pausable`, `AccessControl`, `ReentrancyGuard`) — đừng tự viết.
2. **Core đúng trước, edge sau** — code lõi chạy được rồi NÓI ra edge case sẽ xử nếu có thời gian.
3. **Viết 1 test nếu kịp** (AdversarialBase) — cực ăn điểm.
4. **Nói ra suy nghĩ khi gõ** — CEI, ai gọi được, bất biến gì.
5. Cảnh giác **bẫy pause hàm thoát** và **bẫy typehash** (thêm field order = sửa reactor + harness + FallbackExecutor + backend).

---

## D. TÍNH NĂNG BACKEND KHÓ (ask 30-60 phút)

### D0. So với backend protocol thật — thiếu gì
| Gap | Code 30-60p? | Đụng |
|---|---|---|
| **Pagination + filter** trên list endpoint | Dễ-TB ✓ | route + SQL LIMIT/OFFSET |
| **Adapter aggregator mới** (1inch/0x) | TB ✓ | `services/aggregators/` |
| **Index một event mới** vào DB | TB ✓ | `indexer/eventIndexer.ts` |
| **Real-time đẩy trạng thái** (SSE/WebSocket) | TB-Khó ✓ | route + provider |
| **Rate limiting** | TB ✓ | middleware |
| **Auth admin** (API key/JWT) | TB ✓ | `routes/admin.ts` |
| **Cache quote/market rate** | TB ✓ | service layer |
| **Reorg rollback** trong indexer | Khó ⚠ | checkpoint + DB |

### D1. Adapter aggregator mới (mẫu từ `services/aggregators/kyberswap.ts`)
Job: gọi API aggregator mới → trả về `(router, routeCalldata, minOut)` đúng shape FallbackExecutor cần.
```ts
// services/aggregators/oneinch.ts
export async function getOneInchRoute(p: {
  inputToken: string; outputToken: string; amountIn: string; chainId: number
}): Promise<{ router: string; calldata: string; minOut: string }> {
  const url = `https://api.1inch.dev/swap/v6.0/${p.chainId}/swap?...`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.ONEINCH_KEY}` } })
  const j = await r.json()
  return { router: j.tx.to, calldata: j.tx.data, minOut: j.toAmount }  // (to, data) = đúng cặp đã bàn
}
```
**Gotcha:** router phải nằm trong **whitelist của FallbackExecutor** mới gọi được; `calldata` là blob mù — backend không cần hiểu nội dung.

### D2. Index một event mới (mẫu từ `indexer/eventIndexer.ts`)
```ts
const ABI = ['event MyEvent(bytes32 indexed orderHash, address indexed who, uint256 amount)']
const c = new ethers.Contract(addr, ABI, provider)
provider.on('block', async (bn) => {
  if (bn <= last) return
  const logs = await queryFilterChunked(c, c.filters.MyEvent(), last + 1, bn)
  for (const log of logs) {
    const { orderHash, who, amount } = log.args!
    await db.query('INSERT INTO my_table(order_hash, who, amount, tx_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [orderHash, who, amount.toString(), log.transactionHash])
  }
  last = bn; await setCheckpoint('my_event', last)
})
```
**Gotcha:** dùng `queryFilterChunked` (không `queryFilter` trần — vượt giới hạn RPC sau outage); `ON CONFLICT DO NOTHING` để idempotent; checkpoint để không index lại.

### D3. Real-time trạng thái lệnh qua SSE (nhẹ hơn WebSocket, không cần thư viện)
```ts
router.get('/:hash/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.flushHeaders()
  const timer = setInterval(async () => {
    const { rows } = await db.query('SELECT status FROM orders WHERE hash=$1', [req.params.hash])
    res.write(`data: ${JSON.stringify(rows[0] ?? {})}\n\n`)
  }, 2000)
  req.on('close', () => clearInterval(timer))
})
```
**Gotcha:** nhớ `clearInterval` khi client đóng (rò timer); SSE đơn giản hơn WebSocket và đủ cho "đẩy trạng thái".

### D4. Pagination + filter
```ts
router.get('/', async (req, res) => {
  const limit  = Math.min(Number(req.query.limit ?? 20), 100)
  const offset = Number(req.query.offset ?? 0)
  const status = req.query.status as string | undefined
  const { rows } = await db.query(
    `SELECT hash, status FROM orders ${status ? 'WHERE status=$3' : ''} ORDER BY block_number DESC LIMIT $1 OFFSET $2`,
    status ? [limit, offset, status] : [limit, offset]
  )
  res.json({ data: rows, limit, offset })
})
```
**Gotcha:** clamp `limit` (chống lấy cả bảng); luôn `$1/$2` tham số hóa.

### D5. Rate limit + auth admin (nhanh)
- **Rate limit:** `npm i express-rate-limit` → `app.use('/quote', rateLimit({ windowMs: 60000, max: 30 }))`.
- **Auth admin:** middleware kiểm header → `if (req.headers['x-api-key'] !== process.env.ADMIN_KEY) return res.status(401).json({error:'unauthorized'})`, gắn vào `adminRouter`.

### D6. Decode lỗi contract ("hexa khó hiểu") — ask hay gặp
Error của contract = **selector + ABI-encode**, giống calldata. 3 dạng:
| Dạng | Selector | Nghĩa |
|---|---|---|
| `Error(string)` | `0x08c379a0` | `require(c,"msg")` — phần lớn lỗi project |
| `Panic(uint256)` | `0x4e487b71` | lỗi máy: overflow `0x11`, chia 0 `0x12`, mảng vượt biên `0x32` |
| Custom error | 4 byte của `keccak256("Tên(kiểu)")` | cần ABI mới đọc tham số |

```ts
import { ethers } from 'ethers'
const PANIC: Record<number,string> = { 0x01:'assert', 0x11:'tràn số', 0x12:'chia 0', 0x32:'mảng vượt biên' }

export function decodeContractError(err: any, iface?: ethers.utils.Interface): string {
  if (err?.reason) return err.reason                                  // revert string (đa số)
  const data: string | undefined =
    err?.data ?? err?.error?.data ?? err?.error?.error?.data          // ⚠ lồng khác nhau tùy provider
  if (typeof data !== 'string' || !data.startsWith('0x') || data.length < 10)
    return err?.message ?? 'lỗi không xác định'
  const sel = data.slice(0, 10)
  if (sel === '0x08c379a0')
    return ethers.utils.defaultAbiCoder.decode(['string'], '0x'+data.slice(10))[0]
  if (sel === '0x4e487b71') {
    const [c] = ethers.utils.defaultAbiCoder.decode(['uint256'], '0x'+data.slice(10))
    return `Panic: ${PANIC[Number(c)] ?? `mã ${c}`}`
  }
  if (iface) { try { const e = iface.parseError(data); return `${e.name}(${e.args.join(', ')})` } catch {} }
  return `lỗi chưa biết (${sel})`
}
// dùng: catch (e) { console.error(decodeContractError(e, reactor.interface)) }
```
**Gotcha:** (1) revert data **lồng khác nhau tùy provider** — phải dò `err.data ?? err.error.data ?? ...`; (2) custom error **cần ABI** (interface) mới decode tham số, không thì chỉ ra selector; (3) contract của bạn chủ yếu revert string nên `err.reason` phủ phần lớn, chỉ Panic + custom cần decode tay; (4) `iface.parseError` có từ ethers 5.5+ (bạn 5.8 OK).

### D7. Meta-strategy backend
- **Tái dùng package** (express-rate-limit, ws) thay vì tự viết.
- **Tham số hóa SQL** ($1) — đừng nối chuỗi.
- **Idempotent + checkpoint** cho mọi thứ đụng chain (indexer/watcher).
- Test nhanh bằng `curl`.

---

## E. Drill trước (khuyến nghị)
Làm tay 1 lượt trước bảo vệ: (1) thêm `GET /orders/:hash/fills`, (2) 1 revert test + 1 fuzz test, (3) **Pausable** (gần như chắc bị hỏi) + **protocol fee** (đụng đúng chỗ đã sửa 3.2), (4) một adapter aggregator hoặc index event mới. Gõ một lần = phản xạ lúc bảo vệ.
