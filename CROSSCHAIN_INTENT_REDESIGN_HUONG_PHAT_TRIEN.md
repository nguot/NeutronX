# Cross-chain Intent Redesign — Model 2 (filler-holds-key)

> Handoff doc cho session sau. Tổng hợp thiết kế lại luồng cross-chain swap sang mô
> hình **intent-based, filler-holds-key**. Bản hiện tại của repo là mô hình cũ
> (backend giữ secret, Merkle slot, timelock theo block, `rebaseBlockNumber`) — doc
> này mô tả bản MỚI cần chuyển sang.

---

## 0. TL;DR — quyết định cốt lõi

- **Mô hình: filler-holds-key** (filler sinh secret S, tạo cả hai escrow). KHÔNG phải
  swapper-holds-key (bản cũ).
- **Timelock: timestamp** (không block-number) → **xóa `rebaseBlockNumber`**. **T2 > T1**    
  (dest đóng SAU source).
- **Backend KHÔNG giữ secret** — filler lộ S công khai trên chain A; backend/relayer chỉ
  đọc S public.
- **Fill liên tục** (mỗi filler mang hashlock riêng) — KHÔNG Merkle tree. Tái dùng ý tưởng
  `remaining` của single-chain `PartialFillReactor`.
- **Bond động** (`DynamicStakeLib`) thay flat `MIN_SAFETY_DEPOSIT`.
- **Gasless**: relayer gửi tx claim hộ (trả gas, bù bằng phí); swapper chỉ ký.
- **Tỉ giá**: KHÔNG có pool chung cross-chain — giá = **filler quote off-chain cạnh tranh**,
  swapper chặn bằng `minOutput`.

---

## 1. Vì sao filler-holds-key (không phải swapper-holds-key)

| Tiêu chí | swapper-holds-key (bản cũ) | **filler-holds-key (chọn)** |
|---|---|---|
| Ai giữ secret | swapper/backend (phải cầm trước reveal) | **filler** (backend đọc S public) |
| Free option | swapper → filler bị chọn ngược, khó lãi | **filler giữ → dễ lãi** |
| Chia order | Merkle N slot rời rạc | **liên tục, filler mang H riêng** |
| Vai timing-critical (reveal) | swapper (retail) | **filler (pro, tự-động-cơ)** |
| UX swapper | phải tự reveal | **thụ động nhận, gasless qua relayer** |
| Bề mặt tấn công | ít (swapper là bên nguy hiểm) | **nhiều hơn → cần đủ phòng thủ** |

Cái giá: filler-holds-key **nhiều đòn tấn công hơn** → phải implement đủ phòng thủ (mục 4),
và swapper gánh buffer (nhưng nhẹ, xem mục 5).

---

## 2. Luồng end-to-end

```
Setup 1 lần: swapper approve Permit2 → EscrowSrcFactory (hoặc dùng permit sig → gasless).

1. Swapper post INTENT: (input_token/amount trên A, output_token/min_output trên B, deadline).
   Ký off-chain (gasless). Passive từ đây.
2. Filler nhận intent → chọn lượng K → sinh S, H=keccak(S) → QUOTE (H, rate, T1, T2).
3. Filler FUND DEST TRƯỚC: tạo EscrowDst(B) bằng H, khóa TokenB, expiry T2, recipient=swapper.
4. Swapper (client, hoặc session key) VERIFY dest trên B (đúng H/amount/recipient/T2 + đủ
   finality) → nếu OK, KÝ order source (ghim H, T1). [ký per-fill, off-chain, gasless]
5. Filler tạo EscrowSrc(A) theo order đã ký → hút TokenA qua Permit2, expiry T1.
6. Filler REVEAL S trên A (withdraw EscrowSrc) → filler lấy TokenA. S công khai.
7. RELAYER (không phải filler) đọc S public → claim EscrowDst(B) → swapper nhận TokenB.
   Gas do relayer trả. Swapper gasless + thụ động.

Nhánh xấu:
- Filler không reveal (abort)  → source refund swapper (T1), dest refund filler (T2). Không mất.
- Filler grief-lock            → bond slash về swapper.
- Relayer chết trước T2        → swapper TỰ claim (trả gas) để tự cứu.
```

**Thứ tự bắt buộc:** filler fund dest TRƯỚC → swapper verify + ký source SAU. Đảo thứ tự này
là chặn được đòn "hút TokenA rồi không fund dest".

---

## 3. Timelock

- **Đơn vị: `block.timestamp` (giây Unix)**, không block-number. Xóa `rebaseBlockNumber` ở cả
  `escrowDstWatcher.ts` và filler `crossChainFill.ts`.
- **T2 > T1** (dest đóng sau source). T1, T2 ghim trong order swapper ký, enforce on-chain.
- **Buffer = T2 − T1 ≥ finality chain B + margin.** Đây là finality của **chain bên-thứ-hai
  (swapper claim dest)**. Chỉ MỘT chain, không phải "đoán độ trễ hai chain" (nhờ timestamp).
- **Filler bị ép reveal SỚM** bởi chính T1 của nó: reveal muộn mà tx source chưa final trước
  T1 → source refund về swapper + S đã lộ → swapper lấy dest → **filler mất cả hai.** Nên
  late-reveal double-dip **tự thua** cho ca honest.

---

## 4. Đòn tấn công của FILLER + phòng thủ

| # | Đòn | Tự thua? | Phòng thủ | Tính chất phòng thủ |
|---|---|---|---|---|
| 1 | Late-reveal double-dip (reveal sát T1 bóp cửa dest) | **Gần như tự thua** (T1 của filler sớm hơn) | buffer T2−T1 ≥ finality B | ⚠ có lõi ngẫu nhiên (finality) |
| 2 | Hashlock lệch (source H1, dest H2) | Không | **ghim H trong chữ ký swapper** | tất định (mật mã) |
| 3 | Không fund dest (hút TokenA rồi reveal) | Không | **thứ tự: ký source SAU verify dest** | tất định |
| 4 | Grief-lock (hút TokenA rồi abort) | Không | **bond `DynamicStakeLib` + T1 không quá xa** | tất định (kinh tế) |
| 5 | Private-relay reveal (giấu S, bóp cửa) | Không | buffer tính theo inclusion, không tin mempool | phần trong buffer |
| 6 | **Censor/nghẽn chain B** (kịp T1 rồi làm swapper lỡ T2) | **KHÔNG tự thua** | buffer + deadline-muộn + claim permissionless | ⚠ **CHƯA giải sạch** |

→ 3 lớp phòng thủ (pin-H, thứ tự, bond) **tất định, không thêm rủi ro mù**. Yếu tố mù duy
nhất là **buffer = finality chain B** (cả Model 1 cũng có, chỉ khác chain).

---

## 5. Phân bổ rủi ro

**Đẩy HẲN sang filler (định giá thành phí):** vốn tồn kho, giá trong cửa sổ, reveal-rồi-source-reorg,
gas 2 escrow + reveal, việc reveal đúng lúc.

**Vật lý — không ai giải:** đuôi reorg-sau-final chain B, sàn tốc độ = finality chain chậm,
không ép được thứ tự tx cross-chain, timestamp bị proposer nhích vài giây.

**Vẫn dính swapper:** free-option/adverse-selection (giảm bằng cửa sổ ngắn + bond, không triệt),
buffer chain B (nhẹ — bên thứ hai deadline muộn + delegatable), phải online, ký per-fill.

**Điểm quan trọng:** swapper là **bên thứ hai** nhưng việc của nó DỄ — deadline muộn hơn (T2),
claim delegatable cho relayer (S public). Việc KHÓ (reveal đúng lúc) ở **filler pro tự-động-cơ**.

---

## 6. Database schema

Backend = **relay + status board**, KHÔNG giữ secret.

```sql
orders  -- intent của swapper
  order_id        PK
  swapper, src_chain_id, dst_chain_id
  input_token, input_amount      -- tổng, chain A
  output_token, min_output       -- tổng, chain B (sàn swapper chấp nhận)
  deadline_base                  -- mốc T1 gốc
  status          open | partial | filled | expired | cancelled
  permit2_ref, created_at

fills  -- mỗi filler = MỘT dòng = MỘT cặp chấm trên timeline
  fill_id         PK
  order_id        FK
  filler          addr
  fill_amount                    -- phần input filler này ăn
  hashlock        H              -- của filler
  t1, t2                         -- timestamp (t2 > t1)
  rate, bond_amount
  escrow_src_addr, escrow_dst_addr
  swapper_sig                    -- authorization per-fill; NULL tới khi swapper ký
  secret          S              -- NULL tới khi filler REVEAL; điền từ event public
  status          quoted | dst_funded | authorized | src_locked
                  | revealed | claimed | aborted | slashed
  dst_funded_tx, src_created_tx, reveal_tx, claim_tx
  quoted_at, dst_funded_at, authorized_at, src_locked_at, revealed_at, claimed_at
```

**State machine của một fill:**
```
quoted ─(filler fund dest B)→ dst_funded ─(swapper verify+ký)→ authorized
       ─(filler tạo src A)→ src_locked ─(filler reveal S)→ revealed
       ─(relayer claim dest B)→ claimed ✓
   nhánh xấu: aborted (filler bỏ→refund) | slashed (grief→bond về swapper)
```

**Mấu chốt:** `secret` NULL cho tới lúc filler reveal (điền từ event public trên chain A);
`swapper_sig` NULL tới khi swapper ký per-fill. Phản ánh đúng "backend không cầm secret".

---

## 7. UI / UX

**Mockup đã dựng (artifact):** https://claude.ai/code/artifact/04993a54-dab9-46d5-bed9-7cb802859f33
(file gốc: `scratchpad/cc-order-ui.html`)

**View chính = Timeline hai chain, mỗi filler = một cặp chấm nối dọc:**
```
Chain A (ETH · EscrowSrc)   ●────────●──────●───●┈┈┈   (dot = escrow nguồn)
                            │        │      │   │
                            ✓        🔑     🔒  ✍   (state ở giữa connector)
                            │        │      │   │
Chain B (USDC · EscrowDst)  ●────────●──────●───●┈┈┈   (dot = escrow đích)
                           α:done  β:key  γ:lock δ:sign  trống
```
- **Bề rộng cột ∝ lượng fill** → timeline kiêm thanh tiến độ.
- **5 trạng thái/màu:** ✓ done (xanh) · 🔑 revealed/claimable (tím) · 🔒 locked (xanh dương) ·
  ✍ cần ký (hổ phách) · ＋ trống (xám).
- **"Lúc có key":** chấm β tím + chip 🔑, **chấm dest rỗng** (chưa claim); cột `Key (S)` bảng:
  "chưa lộ" → "0xa1c9… public".
- **Claim:** nút [Nhận X USDC] — permissionless, relayer/watchtower nhận hộ, không cần secret.
- **Ký per-fill:** card "Cần chữ ký" ghi rõ "dest đã fund đúng token/amount/recipient · đủ
  finality" → verify-rồi-ký.

**2 action nổi lên TRÊN CÙNG** ("Cần bạn — N việc"): ký per-fill + nhận key. UI để *thao tác*.

**Gasless UX:** swapper chỉ ký (off-chain). Relayer gửi claim + trả gas, bù bằng phí. Có
**session key** thì swapper hoàn toàn thụ động (client tự verify-rồi-ký per-fill) → chỉ còn
"nhận tiền tự động". Ca relayer chết → swapper tự-claim (trả gas) làm fallback.

**Design tokens (mockup):** warm/cool tách hai chain (ETH hổ phách / USDC ngọc lam) làm nhãn
rail; màu bão hòa dành cho state; mono cho mọi số/hash + `tabular-nums`; pulse chỉ trên 2 chấm
action; theme-aware sáng/tối.

---

## 8. Tỉ giá 2 coin trên 2 chain (KHÔNG có pool chung)

**Vấn đề:** một pool là một contract trên một chain; TokenA (A) và TokenB (B) không thể ở chung
pool. Không có AMM nào bắc qua hai chain.

**Giải:**
1. **Rate = FILLER quote off-chain, cạnh tranh.** Swapper nêu intent + `min_output` (sàn). Filler
   tự tính giá từ **CEX + DEX/oracle TỪNG CHAIN riêng + mô hình tồn kho** rồi quote. Quote tốt
   nhất thắng. `min_output` bảo vệ swapper khỏi giá tệ. → đây là bản chất **intent-based**:
   swapper nêu ý định, thị trường (filler) tìm giá.
2. **On-chain chỉ có giá PER-CHAIN:** oracle/DEX TWAP trên A cho giá ETH; trên B cho USDC. Dùng
   cho **sizing bond** (`DynamicStakeLib` lấy TWAP pool trên chain filler để quy collateral ra
   ETH) — KHÔNG phải tỉ giá cross-chain.
3. **UX:** backend hiện **giá tham chiếu** (ghép oracle/CoinGecko hai chain, như `marketRate.ts`
   single-chain) để swapper biết thế nào là công bằng trước khi đặt `min_output`. Nhưng **giá
   ràng buộc là quote của filler**, không phải số tham chiếu.

**Hệ quả:** filler vừa **định giá (quote)** vừa **chịu rủi ro tồn kho** = một vai → cần **filler
chuyên nghiệp lắm vốn** (điểm tập trung hóa mọi fast-cross-chain phải chấp nhận).

---

## 9. Gasless (chi tiết)

- Swapper: **chỉ ký** (intent + per-fill). Approve Permit2 một-lần-đời (né được bằng permit sig).
- **Relayer gửi tx claim** trên B → tiền về ví swapper. Gas relayer trả, bù bằng phí.
- **Relayer claim bằng S PUBLIC → KHÔNG custody secret** (khác Model 1 phải đưa secret cho relayer).
  → Model 2 gasless sạch hơn.
- **Relayer là liveness-critical** (phải claim trước T2, không thì filler refund → swapper mất)
  **nhưng KHÔNG cướp được** (recipient cố định). Fallback: swapper tự-claim.
- Production: relayer = hạ tầng protocol (tập trung), nuôi bằng phí (như 1inch/Across). **Relayer
  gasless PHI TẬP TRUNG, permissionless** mới là bài toán mở.

---

## 10. Thay đổi contract cần làm (so với code hiện tại)

| File | Đổi |
|---|---|
| `EscrowSrc.sol` / `EscrowDst.sol` | `block.number` → `block.timestamp` cho mọi `expiry` check |
| `OrderInfo` (EscrowSrcFactory) | bỏ `merkleRoot`/`numSlots`; thêm **`hashlock H`, `t1`, `t2`** |
| `EscrowSrcFactory.fillSlot` | giữ `_verifySig(swapperSig)`; **bỏ `cosignerSig`** (không còn Merkle/backend-secret); bond = `DynamicStakeLib.requiredStake(...)` thay `MIN_SAFETY_DEPOSIT` flat |
| `EscrowDstFactory` | **không thêm sig** — filler fund với H; swapper verify off-chain rồi mới ký source. (Hoặc enforce T2>T1 nếu ghim cả hai vào order.) |
| Backend `crosschainService` | bỏ `rootSecret` (cột DB + logic); bỏ `getCosignerWallet` khỏi đường cross-chain |
| `escrowDstWatcher.ts` | **xóa `rebaseBlockNumber`**; đổi vai từ "derive+reveal secret" → "đọc S public + relayer claim"; so T2/T1 trực tiếp (timestamp) |
| filler `crossChainFill.ts` | **xóa `rebaseBlockNumber`**; filler sinh S per-fill; reveal trên source |
| Frontend | client sinh/không-cần secret của swapper (filler sinh); verify dest + ký per-fill; session key (optional) |

---

## 11. Magic number / workaround cần dọn

**Xóa hẳn (workaround bẩn):**
- `rebaseBlockNumber` (escrowDstWatcher:11, crossChainFill:46) — timestamp thay thế.
- Timelock theo `block.number` — → timestamp.
- Backend `rootSecret` (crosschainService:231) — filler sinh S.
- Flat `MIN_SAFETY_DEPOSIT = 0.001 ether` (EscrowSrcFactory:148) — → `DynamicStakeLib`.
- `ORDER_TYPE_HASH`/`computeOrderHash` copy ×5 file — → 1 module chung.

**Dồn vào config (`config/chains.ts` + `chains.json`):**
- `pollingInterval=12000` (×4), `RESCAN_LAG=30`, retry `10×1500ms`, `finalitySeconds` (mới, cho
  client tính margin buffer), `CHAIN_A_ID/B_ID` hardcode, `TOKEN_META`, các timeout marketRate.

**Đặc thù test (biến mất ở production):** `contract.on` không fire → checkpointed getLogs;
`pollingInterval=12000` né Anvil TCP wedge → prod dùng websocket/indexer thật.

---

## 12. Chưa giải sạch (ưu tiên làm tiếp, cao → thấp)

1. **⚠ Censor/nghẽn chain B** (đòn #6, KHÔNG tự thua) — filler kịp T1 rồi làm swapper lỡ T2.
   Buffer + deadline-muộn *giảm*, chưa *triệt*. **Lỗ hổng thật còn mở.**
2. **Sizing bond dưới biến động giá** — bond phải > giá trị grief; nhỏ quá grief rẻ, lớn quá
   filler không tham gia. Bài toán tuning.
3. **Relayer/watchtower phi-tập-trung** — production nuôi bằng phí (tập trung) là xong; bản
   permissionless là mở.
4. **Đối soát partial-fill cross-chain** — remaining tracking, chống over-fill, filler hút
   TokenA rồi fill hỏng. Cần cơ chế remaining thống nhất (single-chain làm on-chain, cross-chain
   phải ghép escrow + backend).
5. **Registry token/giá cho bond** — `DynamicStakeLib` cần TWAP pool đúng; feed giá cross-chain.
6. **Race source-filler binding** giữa 2 watcher (vòng retry) — robust-able, chưa clean.

**Ngoài phạm vi (thật nhưng chưa đụng):** N-chain (>2), non-EVM (Bitcoin/Solana), gas chain đích
cho swapper (đỡ bằng relayer), hiệu quả vốn khi swap fail (vốn kẹt tới timeout).

---

## 13. So sánh nhanh Model 1 vs Model 2 (giả sử đủ phòng thủ)

| | Model 1 (swapper key) | **Model 2 (filler key — chọn)** |
|---|---|---|
| Backend giữ secret | có (hoặc swapper cầm) | **không** (đọc S public) |
| Đòn tấn công của filler | ~0 (swapper là bên nguy hiểm) | ~6 (cần đủ phòng thủ) |
| Yếu tố ngẫu nhiên trong phòng thủ | 1 (buffer chain A) | 1 (buffer chain B) — phần thêm đều tất định |
| Filler lãi | khó (bị chọn ngược) | **dễ** (giữ option) |
| Fill | rời rạc (Merkle) | **liên tục** |
| Gasless qua relayer | phải đưa secret cho relayer | **relayer dùng S public, không custody** |
| UX swapper | phải tự reveal | **thụ động + gasless** |
| Buffer gánh bởi | filler (pro) | swapper (retail, nhưng nhẹ + delegatable) |
| Độ phức tạp code/audit | thấp | **cao** (nhiều lớp phòng thủ) |

**Kết luận:** Model 2 tốt hơn về trust/kinh tế/linh hoạt/UX; cái giá là code phòng thủ phức
tạp hơn (nhưng tất định, không rủi ro mù) + swapper ký per-fill.
