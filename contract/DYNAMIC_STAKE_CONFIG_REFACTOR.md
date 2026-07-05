# Refactor: bảng stake có kích thước + giá trị tùy chỉnh (owner-only)

> Mục tiêu: biến `collateralRate` / `refundTable` / các mốc chia bucket (size,
> time, fill-ratio) từ **cố định trong code** thành **cấu hình động** mà
> owner/dev team đổi được cả **giá trị** lẫn **số lượng bucket**, không cần
> deploy lại. Thay bằng **một** setter atomic có validate.
>
> **Đọc theo thứ tự**: khối 🎯 SCOPE + ✅ CÔNG VIỆC + 🔑 THIẾT KẾ CHỐT dưới đây
> là **kết luận cuối cùng**. Phần I là chi tiết refactor bảng. **Phần II & III
> là tham chiếu DAO — đã HẠ xuống future-work**, chỉ đọc khi cần mở rộng.

---

# 🎯 QUYẾT ĐỊNH SCOPE (chốt cuối session này)

**Mục tiêu = Mức 1-2 (owner/multisig + guardrail + timelock). BỎ DAO/token.**

Lý do (viết vào báo cáo): token trong phạm vi DATN **không có value backing**
→ alignment cử tri không thành lập → DAO **không thêm bảo mật**. An toàn thật
tựa vào **`_validate` + guard + snapshot + timelock**, không phải cái vote.
Nói *"cố tình KHÔNG làm DAO vì với token vô giá trị nó vô nghĩa"* là lập trường
trưởng thành hơn *"làm DAO cho ngầu"*.

| Làm (scope chính) | Bỏ → chỉ mô tả "future work" |
|---|---|
| StakeConfig động + `_validate` (7 bất biến) | Token (ERC20Votes) |
| Guard: maxDelta + cooldown + sàn phạt | Governor + vote + delegate |
| Snapshot `refundRow` + `ratioSnapshot` | Trang Governance/vote/wallet-connect |
| Timelock nới-lỏng (pending-commit) + rollback | — |
| Auth: **AccessControl** (GOVERNOR/GUARDIAN/KEEPER role) | — |
| Owner = **1 EOA hoặc multisig nhỏ** | — |

Off-chain rút gọn theo: chỉ **trang xem bảng (đọc)** + **tab Guardian (rollback)**
+ **indexer history** + (SHOULD) **keeper peg-giá**. KHÔNG governance UI.

---

# ✅ CÔNG VIỆC CHO SESSION TIẾP THEO (theo thứ tự an toàn)

> Nguyên tắc: mỗi bước build + test xanh rồi mới sang bước sau. Guardrail TRƯỚC,
> linh hoạt SAU. Bước 1-4 là contract; 5-6 off-chain.

- [ ] **B1. Đổi auth `owner`→`AccessControl`** (cô lập, ít rủi ro, làm trước)
  - `src/FillAuction.sol`: bỏ `immutable owner`/`onlyOwner`; thêm
    `PARAM_ADMIN_ROLE` / `GUARDIAN_ROLE` / `KEEPER_ROLE` (+ `DEFAULT_ADMIN_ROLE`
    để cấp role); constructor nhận địa chỉ. Xem bảng role ở khối 🔑 THIẾT KẾ CHỐT/A.
  - Sửa test nhóm 1: `setUp()` `grantRole(PARAM_ADMIN_ROLE, address(this))` để giữ
    kiểu gọi setter trực tiếp (`CoreGuards`, `FillAuction.t`, `FrontRunGriefing`,
    `RegistrationForgery`, handler invariant).
- [ ] **B2. StakeConfig động + snapshot** (Phần I + điểm nguy hiểm #3)
  - `DynamicStakeLib.sol`: bucket funcs → vòng lặp động; `computeCollateral/Refund`
    chữ ký mảng động.
  - `FillAuction.sol`: `StakeConfig _config`; `Registration.refundRow: uint32[]`
    **+ `uint256[] ratioSnapshot`**; vòng snapshot `for i<R`.
  - Sửa test nhóm 2 (~10 file, nặng nhất `DynamicStakeLibStake.t.sol`).
- [ ] **B3. `setStakeConfig` + `_validate` (7 bất biến)** + cận ngoài IMMUTABLE
  - Bỏ/wrap `setCollateralRate`/`setRefundTable`.
  - `_validate`: độ dài khớp, threshold tăng, rate ∈ [MIN,MAX], refund row đơn
    điệu & kết 10000, trần `MAX_BUCKETS`.
- [ ] **B4. Guard 2 prompt + timelock nới-lỏng + rollback** — ⚠️ theo **mục 🔑 D** (4 lỗ logic đã chốt), KHÔNG theo pseudocode II.3(c)
  - `_isLoosening`/`maxDelta` **so theo OUTPUT qua sampling** (shape-independent — D1).
  - Sàn phạt **lấy mẫu tại fill cố định [1,5,20]%** (né reshape bucket — #2).
  - `_apply()` gom transition (one-deep — D2); cooldown gate **cả 2 nhánh** + **một
    pending** (`setStakeConfig` revert nếu đang treo — D3).
  - `_isLoosening`→`pending`+`LOOSEN_DELAY`; `commitPending()` (gọi `_apply`);
    `cancelPendingConfig()`/`rollback()` (guardian, `rollback` xóa `_pending` — D4).
  - **FOLD `minCollateral` vào `StakeConfig`**; `setReactor`→`DEFAULT_ADMIN_ROLE` (D4).
  - Test nhóm 3: reject từng vi phạm; **đổi-số-bucket+loosening**; **commit-nới rồi
    rollback về đúng 1 bước**; **spam nới bị cooldown+one-pending chặn**; ghi-đè-pending
    revert; rollback xóa pending; hạ minCollateral = loosening→pending; sàn phạt;
    **register↔đổi-config↔fill giữ snapshot** (#5).
- [ ] **B5. Deploy script + ABI**
  - Deploy `FillAuction` với owner = multisig/EOA + wire các role.
  - Regenerate ABI ở **3 nơi**: `filler/*/abis.ts`, frontend, backend.
- [ ] **B6. Off-chain tối thiểu (MUST + SHOULD)**
  - Indexer: sự kiện `StakeConfigUpdated`/`PendingConfigQueued`/`ConfigRollback`
    → bảng `stake_config_history`, `pending_configs`.
  - FE: **trang xem bảng** (render động + đếm ngược pending) + **tab Guardian**
    (rollback/cancel, ví-gated).
  - (SHOULD) keeper peg-giá dùng `KEEPER_ROLE` (chỉ `sizeThresholds`).

**Future work (chỉ mô tả trong báo cáo, KHÔNG code)**: Token + Governor + Timelock
DAO (Phần II NICE) + governance UI (Phần III NICE) — kèm lý do vì sao chưa làm.

**Nhắc test E2E**: ưu tiên **Foundry E2E tầng 1** (deploy full + tua thời gian
bằng `vm.warp`/`vm.roll`, phủ guard + timelock + snapshot) trước khi dựng E2E
toàn hệ. Bẫy: **delegate phiếu**, **tua đủ các mốc thời gian**, **oracle cho keeper**.

---

# 🔑 THIẾT KẾ CHỐT (scope cuối — đọc cái này, KHÔNG đọc DAO ở Phần II)

## A. Role & điều kiện để thành role

Dùng `AccessControl`. **Không có Timelock contract, không có Governor** ở scope này —
"timelock" = pending-commit trong FillAuction. Đổi tên `GOVERNOR_ROLE`→`PARAM_ADMIN_ROLE`
cho khỏi hiểu nhầm là DAO.

| Role | Quyền | Ai giữ | Điều kiện TRỞ THÀNH |
|---|---|---|---|
| **DEFAULT_ADMIN_ROLE** | Cấp/thu hồi role khác | Deployer → chuyển cho multisig | Được default-admin `grantRole`; lúc deploy = người deploy |
| **PARAM_ADMIN_ROLE** (was GOVERNOR) | Gọi `setStakeConfig` | EOA/multisig team | DEFAULT_ADMIN `grantRole` — **không permissionless** |
| **GUARDIAN_ROLE** | `rollback`, `cancelPendingConfig` | Ví/multisig **riêng** (≠ param-admin) | DEFAULT_ADMIN `grantRole`; nếu Safe → thêm signer M-of-N |
| **KEEPER_ROLE** | **Chỉ** dời `sizeThresholds` | Ví backend | DEFAULT_ADMIN `grantRole` |
| *Ops admin* (off-chain) | Sửa `.env` | 1 tài khoản | Biết password |

**Multisig là TÙY CHỌN lúc deploy, KHÔNG phải deliverable.** `AccessControl` gán
role cho *một địa chỉ* — địa chỉ đó là EOA hay Safe M-of-N thì **code y hệt**.
→ **Demo DATN: mỗi role một EOA riêng** (đã đủ thể hiện tam quyền phân lập). Multisig
chỉ cần *mô tả trong báo cáo* là "địa chỉ giữ role trong production".

Khởi tạo lúc deploy:
```
deployer giữ DEFAULT_ADMIN
grantRole(PARAM_ADMIN, teamAddr)
grantRole(GUARDIAN,    guardianAddr)   // ví KHÁC param-admin
grantRole(KEEPER,      backendAddr)
chuyển DEFAULT_ADMIN cho multisig → renounce của deployer
```

## B. Flow tổng thể

**Vai**: *đề xuất* (backend suggest / người phân tích — KHÔNG có quyền) → *thay đổi*
(PARAM_ADMIN) → *kiểm duyệt tự động* (contract) → *phanh* (GUARDIAN) → *peg máy móc*
(KEEPER). Đề xuất ≠ thay đổi ≠ kiểm duyệt.

**Flow A — đổi rate/refund (con người):**
```
backend suggest ─(gợi ý)─► PARAM_ADMIN ─setStakeConfig─► _validate (7 bất biến + maxDelta + cooldown + sàn phạt)
                                                              │
                              ┌──── SIẾT (an toàn hơn) ───────┴──── NỚI (yếu đi) ────┐
                              ▼ áp NGAY                                ▼ PENDING + LOOSEN_DELAY(7d)
                        _config mới                    ┌─ GUARDIAN cancelPending ─► hủy
                                                       └─ hết hạn ─ commitPending ─► áp dụng
```
**Flow B — peg giá (máy móc):** `Chainlink ─► KEEPER tính sizeThresholds ─► chỉ đổi MỐC, không rate`
**Flow C — lỡ sai:** `PARAM_ADMIN set nhầm ─► GUARDIAN rollback() ─► _previousConfig`
**Filler được bảo vệ:** `register ─► SNAPSHOT (refundRow + ratioSnapshot) ─► bảng đổi sau KỆ, settle theo snapshot cũ`

## C. Rollback — quy tắc (tinh chỉnh chốt)

1. **CHỈ one-deep** (về `_previousConfig`), **KHÔNG rollback-về-bảng-bất-kỳ**.
   Lý do: rollback-bất-kỳ = guardian chọn được bảng lịch sử có lợi = **guardian ≡
   param-admin → sập phân lập quyền**. Guardian là phanh, không phải vô-lăng.
2. **Rollback MIỄN check tương đối** (`maxDelta`/`cooldown` — vì nó là cú nhảy lớn
   để hoàn tác) nhưng **VẪN qua bất biến tuyệt đối** (đơn điệu, sàn phạt, MIN/MAX).
3. **KHÔNG làm contract history riêng.** Cần history → **ring buffer last-K** trong
   FillAuction hoặc **indexer off-chain** (đã có `stake_config_history`). Contract
   riêng chỉ thừa storage.
4. **KHÔNG thêm hard-ratchet** `require(refund↓ && collateral↑)`. Hướng an toàn đúng
   nhưng làm cứng = bất khả đảo → "chết nhưng an toàn". Đã thay bằng `_isLoosening →
   pending-delay` (cho nới nhưng chậm + guardian phủ quyết).
5. `cancelPendingConfig`/`rollback` nên **rate-limit hoặc chỉ trong cửa sổ ngắn sau
   thay đổi** → chống guardian veto-war khóa hệ.

## D. Bốn quyết định logic B4 (CHỐT trước khi code — lỗ hổng thật, không nitpick)

> Pseudocode ở II.3(c) có 4 lỗ logic. Đây là bản đúng, **ghi đè II.3(c)**.

**D1 — `_isLoosening`/`maxDelta` phải so theo OUTPUT, không theo ô.** Mục tiêu
refactor là đổi được SỐ bucket → khi shape khác nhau **không có ô 1-1 để so**.
So hai config như hai HÀM tại lưới điểm cố định (độc lập shape, giống sàn phạt):
```
lưới immutable: SAMPLE_NOTIONALS [0.5,5,50,500] ETH × SAMPLE_FILLS [1,5,20,50,100]%
collateral_i = computeCollateral(cfg, notional_i, refDeadline)
penalty_ij   = collateral_i × (1 − refundFrac(cfg, notional_i, fill_j))
LOOSENING(new) ⟺ ∃ điểm: collateral_new < old  HOẶC  penalty_new < old
maxDelta OK    ⟺ ∀ điểm: |Δcollateral| ≤ MAXΔ·old  VÀ  |Δpenalty| ≤ MAXΔ·old
```
Gọi compute trên `c` và `_config` (đều view). Known limitation: lưới rời rạc có
thể bỏ sót giữa 2 điểm → chọn lưới đủ dày.

**D2 — Gom transition vào `_apply()` để giữ one-deep.** `commitPending` HIỆN
thiếu `_previousConfig=_config` → sau khi commit một nới-lỏng, `rollback` nhảy về
config trước cú SIẾT gần nhất, **vi phạm one-deep (C.1)**. Fix:
```solidity
function _apply(StakeConfig memory cfg) internal {
    _previousConfig = _config;   // LUÔN chụp bản bị thay
    _config = cfg; lastChange = block.timestamp;
}
// nhánh SIẾT gọi _apply(c);  commitPending() cũng gọi _apply(_pending);
// rollback(): _config = _previousConfig (giữ _previousConfig → lần 2 no-op) + delete _pending
```

**D3 — Cooldown gate CẢ hai nhánh + chỉ MỘT pending.** Pseudocode chỉ set
`lastChange` ở nhánh siết → PARAM_ADMIN spam `setStakeConfig` ghi đè `_pending`
nhiều lần (nới dần) **không bị cooldown chặn — đúng con đường salami guard #1 sinh
ra để chặn**. Fix:
- cooldown check ở đầu `setStakeConfig`, cập nhật `lastChange` khi **khởi tạo** thay
  đổi (cả siết-áp-ngay lẫn queue-pending).
- **Chỉ một `_pending`**: nếu đang treo → `setStakeConfig` **revert "pending exists"**.
  N lần nới = queue→7d→commit→cooldown→queue lại: chậm & lộ liễu.

**D4 — Chốt 4 câu treo:**
| Câu | Chốt |
|---|---|
| `setStakeConfig` khi có `_pending` | **revert** — cancel/commit trước |
| `rollback()` xóa `_pending`? | **CÓ** (`delete _pending`) |
| `setReactor` → role | **`DEFAULT_ADMIN_ROLE`** (wiring cấu trúc, set-once) |
| `setMinCollateral` → role | **FOLD vào `StakeConfig`** (field `minCollateral`) → bị `_validate`/loosening/maxDelta/pending phủ. Để riêng = hạ về 0 **lách hết guard** |

**Test B4 thêm (cho chính 4 điểm trên):** đổi-số-bucket+loosening (sampling đúng);
commit-nới rồi rollback phải về ĐÚNG 1 bước (trước cú nới, không trước cú siết);
spam nới liên tiếp bị cooldown+one-pending chặn; ghi-đè-pending revert; rollback
xóa pending; hạ `minCollateral` bị coi là loosening → vào pending.

---

## 1. Trạng thái hiện tại (để đối chiếu)

Mọi kích thước đang **cứng trong kiểu dữ liệu**:

| Thứ | Khai báo hiện tại | Ở đâu |
|---|---|---|
| collateralRate | `uint32[4]` | `FillAuction.sol:66` |
| refundTable | `uint32[5][4]` | `FillAuction.sol:74` |
| snapshot refund | `uint32[5] refundRow` trong struct Registration | `FillAuction.sol:29` |
| mốc size | `1 / 10 / 100 ETH` (if-chain) | `DynamicStakeLib.sol:35-40` |
| mốc fill-ratio | `2 / 10 / 30 / 70 %` (if-chain) | `DynamicStakeLib.sol:19-30` |
| mốc time + hệ số | `50/20/5 block` → `1x/1.5x/3x/5x` (if-chain) | `DynamicStakeLib.sol:13-18, 108-115` |
| setter | `setCollateralRate(bucket,val)`, `setRefundTable(s,r,val)` — sửa **1 ô** | `FillAuction.sol:150-160` |

Số `4`, `5` nằm trong *type* → không resize runtime được. Đó là lý do phải
đổi sang **mảng động**.

---

## 2. Thiết kế đích: một struct cấu hình, một setter atomic

```solidity
struct StakeConfig {
    uint256[] sizeThresholds;    // len = S-1  → S size bucket
    uint32[]  collateralRate;    // len = S    (bps)
    uint256[] timeThresholds;    // len = T-1  → T time bucket (blocks-left, giảm dần logic)
    uint32[]  timeMult;          // len = T    (bps, 10000 = 1x)
    uint256[] ratioThresholds;   // len = R-1  → R fill-ratio bucket (đơn vị %/bps của tỉ lệ)
    uint32[]  refundTable;       // len = S*R  (ép phẳng row-major: [s*R + r])
}
```

Đổi cả kích thước lẫn giá trị **trong một transaction**:

```solidity
function setStakeConfig(StakeConfig calldata c) external onlyOwner {
    _validate(c);      // kiểm TOÀN BỘ bất biến trước
    _config = c;       // ghi một phát — không có trạng thái nửa vời
    emit StakeConfigUpdated(...);
}
```

Bỏ 2 setter cũ (`setCollateralRate`, `setRefundTable`) — hoặc giữ lại như
wrapper sửa 1 ô *trong* cấu hình hiện tại (không đổi kích thước).

### Bất biến `_validate` BẮT BUỘC (thiếu = mở lại lỗ hổng cũ)

```
1. collateralRate.length == sizeThresholds.length + 1
2. timeMult.length       == timeThresholds.length + 1
3. refundTable.length    == collateralRate.length * (ratioThresholds.length + 1)   [chữ nhật]
4. mọi threshold TĂNG dần ngặt (size ↑, ratio ↑); time bucket đúng thứ tự
5. mỗi collateralRate ∈ [MIN_COLLATERAL_RATE, MAX_COLLATERAL_RATE]   (chặn DƯỚI + trên)
6. mỗi HÀNG refund đơn điệu không giảm & kết ở 10000 (100%)
7. 1 ≤ mỗi .length ≤ MAX_BUCKETS  (chống mảng khổng lồ ăn hết gas / DoS)
```

---

## 3. Danh sách file bị đổi + đổi như thế nào

### A. Code sản xuất (bắt buộc)

| File | Thay đổi |
|---|---|
| **`src/libs/DynamicStakeLib.sol`** | `getOrderSizeBucketETH`, `getFillRatioBucket`, `getTimeBucket`, `_getTimeMultiplier` từ if-chain cứng → **vòng lặp** duyệt mảng threshold truyền vào. `computeCollateral` nhận `uint32[] storage` thay `uint32[4]`. `computeRefund` nhận `uint32[] memory refundRow` thay `uint32[5]`, và **phải nhận cả ratioThresholds đã snapshot** (xem mục 4, điểm nguy hiểm #3). |
| **`src/FillAuction.sol`** | Thay 2 biến `collateralRate`/`refundTable` bằng `StakeConfig _config` (mảng động). `struct Registration.refundRow: uint32[5]` → `uint32[] refundRow` **+ thêm `uint256[] ratioSnapshot`** (snapshot mốc ratio, xem #3). Constructor seed default bằng mảng động. Vòng snapshot `for i<5` → `for i<R`. Bỏ/đổi `setCollateralRate`/`setRefundTable` thành `setStakeConfig` + `_validate`. Thêm `MIN_COLLATERAL_RATE`, `MAX_BUCKETS`, event `StakeConfigUpdated`. Các lời gọi `computeCollateral/Refund` cập nhật chữ ký mới. |

### B. Test (phải sửa để build lại — 10 file, ~152 chỗ tham chiếu)

| File | Vì sao đụng |
|---|---|
| `test/libs/DynamicStakeLibStake.t.sol` (43 chỗ) | Nặng nhất — hardcode 4×5, `liveRefundTable`, check đơn điệu. Viết lại theo chiều động. |
| `test/libs/DynamicStakeLib.t.sol` (16) | Gọi trực tiếp bucket/compute functions với chữ ký cũ. |
| `test/CoreGuards.t.sol` (19) | Dùng setter cũ / đọc bảng. |
| `test/RegistrationForgery.t.sol` (8), `test/FrontRunGriefing.t.sol` (8) | Đọc collateral/refund. |
| `test/invariant/FillAuctionHandler.sol` (12), `FillAuctionInvariant.t.sol` (2) | Handler bơm config. |
| `test/FillAuction.t.sol` (5) | Setup deploy + đọc bảng. |
| **Thêm mới**: test `setStakeConfig` reject mọi cấu hình vi phạm 7 bất biến; test đổi số bucket giữa register↔fill (điểm #3). |

### C. Tài liệu (cập nhật cho khớp, không chặn build)

`test/libs/DynamicStakeLibStake.md`, `TESTCASE_DETAILED.md`, `audit.md`,
`slither-report.md` (mô tả bảng theo chiều động).

### D. Script deploy

`script/Deploy.s.sol` — nếu truyền default table thì cập nhật; nếu để
constructor seed thì không đụng.

---

## 4. CÓ NGUY HIỂM KHÔNG? — phân tích rủi ro

**Tóm tắt: không có rủi ro "mất tiền tức thì", nhưng có 3 cạm bẫy đúng-sai
thật sự, phải xử đúng nếu không sẽ hỏng lúc settle.** Xếp theo mức độ:

### 🔴 #3 (NGHIÊM TRỌNG) — Đổi số bucket giữa register và fill làm hỏng registration đang bay

Đây là rủi ro lớn nhất và **dễ bỏ sót nhất**.

- `refundRow` được **snapshot lúc register** (M-2). Nhưng chỉ số cột `rBucket`
  lại được `getFillRatioBucket` tính theo mốc ratio **hiện tại** lúc fill.
- Nếu owner gọi `setStakeConfig` **tăng số ratio bucket** (vd 5→7) trong lúc
  một filler đã register (refundRow chỉ có 5 phần tử), thì lúc `onFillSuccess`
  `rBucket` có thể = 6 → **index vượt mảng `refundRow` 5 phần tử → revert**.
  Fill hợp lệ bị chặn, cọc kẹt.
- **Cách chặn**: snapshot **cả `ratioThresholds`** vào Registration
  (`ratioSnapshot`), và `computeRefund` tính bucket theo *snapshot* của chính
  registration đó, không theo config toàn cục hiện tại. Khi đó mỗi
  registration **tự nhất quán**, miễn nhiễm với thay đổi config sau này. Đây
  chính là lý do struct phải thêm `uint256[] ratioSnapshot` ở mục 3.A.
- **Kiểm bằng test bắt buộc**: register → đổi config (thêm/bớt bucket) → fill →
  refund vẫn đúng theo snapshot cũ.

### 🟠 #1 (CAO) — Setter nới lỏng = mở lại mọi lỗ hổng đã vá

Càng linh hoạt, `_validate` càng là tuyến phòng thủ duy nhất. Nếu thiếu một
bất biến:
- thiếu chặn dưới collateral → set 0 → đăng ký miễn phí → griefing (như đã bàn).
- thiếu check đơn điệu on-chain → hàng refund lởm chởm → mở lại sniping.
- thiếu check chữ nhật/độ dài → mảng lệch chiều → index lỗi khi tính bucket.

→ `_validate` phải **đủ 7 điều** + **test phủ từng điều reject đúng**. Đây
không phải "nice to have" — nó là bảo mật cốt lõi.

### 🟠 #2 (CAO) — Đổi storage layout struct Registration

`refundRow: uint32[5]` (inline, cố định) → `uint32[]` + `uint256[]` (động, con
trỏ storage) **đổi bố cục storage**.
- `FillAuction` là contract **immutable, không proxy** → chỉ cần **deploy mới**
  là xong, không có migration. **NHƯNG**: nếu đã có contract chạy trên
  testnet/mainnet với registration đang tồn tại → bản mới **không đọc được**
  state cũ. Với DATN (deploy sạch) thì an toàn; chỉ cần nhớ **không** nâng cấp
  đè lên contract đã có dữ liệu.

### 🟡 Rủi ro phụ (thấp, cần lưu ý)

| Rủi ro | Ghi chú |
|---|---|
| **Gas tăng** | Mảng động + vòng lặp + snapshot 2 mảng động mỗi lần `register` đắt hơn if-chain cứng. Chặn trần bằng `MAX_BUCKETS`. Không đáng kể ở quy mô bucket nhỏ (≤ ~10). |
| **DoS gas qua mảng lớn** | Owner (hoặc key owner bị lộ) set `MAX_BUCKETS` khổng lồ → register/fill tốn gas vô hạn. `_validate` phải chặn trần độ dài. |
| **Chưa có timelock** | Owner đổi config có hiệu lực tức thì → filler đang có cọc bị đổi luật. Không phải lỗ hổng của refactor này (snapshot #3 đã bảo vệ refund), nhưng nên cân nhắc timelock cho `setStakeConfig` như bước sau. |
| **Regenerate ABI/bindings** | Backend/solver/frontend đọc bảng qua ABI cũ (`collateralRate()`, `refundTable()`) sẽ vỡ. Phải cập nhật nơi off-chain đọc 2 getter này. |

---

## 5. Đánh giá mức độ & khuyến nghị

- **Quy mô**: trung bình-lớn. ~2 file code, ~10 file test, đụng struct +
  storage layout + chữ ký library. Không phức tạp về thuật toán, nhưng **rộng**.
- **Nguy hiểm nhất là #3** (snapshot ratio) — nếu làm đúng ngay từ đầu thì
  phần còn lại chủ yếu là công sức sửa test.
- **Đề xuất thứ tự an toàn**:
  1. Làm `_validate` + `StakeConfig` + snapshot đầy đủ (`refundRow` +
     `ratioSnapshot`) **trước**, kèm test reject cấu hình xấu và test
     register↔đổi-config↔fill.
  2. Sửa `DynamicStakeLib` sang chiều động.
  3. Sửa loạt test còn lại cho build xanh.
  4. (Tùy chọn) thêm timelock cho `setStakeConfig`.
- **Có nên làm không cho DATN**: đáng làm nếu muốn thể hiện "cấu hình động +
  bất biến an toàn on-chain". Nhưng nếu chỉ cần *đổi giá trị* (không đổi số
  bucket), thì làm **#1+#2 trong bản gốc** (thêm guardrail cho setter cũ + đưa
  mốc ra storage) **rẻ và ít rủi ro hơn nhiều** — không phải đụng storage
  layout struct hay snapshot #3. Chỉ khi *thật sự cần đổi SỐ bucket* mới nên
  làm full refactor này.

---

## 6. Quyết định cần chốt trước khi code

1. Có **thật sự cần đổi số lượng bucket** không, hay chỉ cần đổi giá trị + mốc?
   (Nếu chỉ giá trị+mốc → không cần refactor lớn này.)
2. Giữ lại setter sửa-1-ô như wrapper, hay chỉ còn `setStakeConfig` atomic?
3. Có thêm timelock ngay không, hay để bước sau?

---

# PHẦN II — THIẾT KẾ GOVERNANCE DAO  ⚠️ FUTURE-WORK, KHÔNG LÀM Ở SCOPE NÀY

> ⚠️ **CẢNH BÁO ĐỒNG BỘ**: phần này viết TRƯỚC khi chốt scope (khối 🎯 ở đầu file
> đã **bỏ DAO**). Giữ lại làm **tham chiếu cho hướng mở rộng tương lai** + mô tả
> trong báo cáo. **KHÔNG code phần Token/Governor/Timelock ở scope hiện tại.**
>
> Các điểm dưới đây **BỊ GHI ĐÈ** bởi khối 🔑 THIẾT KẾ CHỐT:
> - II.3(a) ghi `GOVERNOR_ROLE = NeutronTimelock` → **SAI với scope cuối**. Đúng là
>   `PARAM_ADMIN_ROLE = EOA/multisig`, **không có Timelock contract** (timelock =
>   pending-commit trong FillAuction). Xem mục A + C ở khối THIẾT KẾ CHỐT.
> - Sơ đồ II.1 (Token→Governor→Timelock) là kiến trúc DAO đầy đủ — chỉ dùng nếu
>   sau này làm tầng NICE.
>
> Phần *guard kinh tế* (maxDelta/cooldown/sàn phạt/pending-commit/rollback) trong
> II.3(c) **VẪN đúng** và đã đưa vào scope chính.

## II.1 Kiến trúc tổng thể

```
   [Token holder] --propose/vote--> NeutronGovernor --queue--> NeutronTimelock
                                          |                          |
                              (GovernorProposalGuardian)     có DELAY (vd 2 ngày)
                                          |                          |
                                          v                          v
                                     hủy proposal          gọi FillAuction.setStakeConfig(...)
                                                                     |
   [Guardian multisig] --rollback()------------------------------>  FillAuction
                                                                     | _validate (7 bất biến + guard)
                                                                     | pending-commit cho nới-lỏng
                                                                     v
                                                              _config (StakeConfig động)
```

Hai lớp trì hoãn/kiểm soát khác nhau:
- **Timelock của Governor**: delay chung cho *mọi* proposal (cơ chế OZ chuẩn).
- **Pending-commit trong FillAuction**: chỉ áp cho *nới-lỏng*, để đóng cửa sổ
  snapshot (mục #5 phần trước) *bất kể ai gọi setter* — kể cả owner/timelock bị chiếm.

## II.2 Contract cần THÊM (đều fork OZ)

| Contract mới | Kế thừa OZ | Vai | Ước lượng |
|---|---|---|---|
| **NeutronToken** | `ERC20`, `ERC20Votes` (`ERC20Permit`) | Token quản trị, có checkpoint phiếu | ~20 dòng |
| **NeutronTimelock** | `TimelockController` | Chủ thật của FillAuction; giữ delay | ~0 (chỉ deploy + config) |
| **NeutronGovernor** | `Governor` + `GovernorSettings` + `GovernorCountingSimple` + `GovernorVotes` + `GovernorVotesQuorumFraction` + `GovernorTimelockControl` + `GovernorProposalGuardian` | Nhận propose/vote, đẩy qua timelock; guardian hủy được proposal | ~40 dòng (chỉ ghép + override) |

Ba contract này là **compose + override hàm bắt buộc**, không có logic tự chế —
đúng pattern OZ Wizard sinh ra.

## II.3 Thay đổi trong FillAuction (đây là phần code THẬT)

### (a) Đổi auth: `owner`/`onlyOwner` → `AccessControl`

Hiện `address public immutable owner` = msg.sender. Thay bằng:

```solidity
import "@openzeppelin/contracts/access/AccessControl.sol";

bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR"); // = NeutronTimelock
bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN"); // = multisig riêng

// setStakeConfig, setReactor, setMinCollateral: onlyRole(GOVERNOR_ROLE)
// rollback, cancelPendingConfig:               onlyRole(GUARDIAN_ROLE)
```

Constructor nhận địa chỉ governor (timelock) + guardian thay vì lấy msg.sender.
→ **Đây là thay đổi phá nhiều test nhất** (mọi `onlyOwner` cũ).

### (b) StakeConfig động + setStakeConfig + _validate (Phần I)

Như Phần I: mảng động, snapshot `refundRow` + `ratioSnapshot`, 7 bất biến.

### (c) Guard từ 2 prompt — gắn vào setStakeConfig

```solidity
// hằng số IMMUTABLE (cận ngoài, chốt hồi quy meta-param #6)
uint32  public constant MAX_COLLATERAL_RATE = 1_000_000;
uint32  public constant MIN_COLLATERAL_RATE = ...;      // chặn dưới (prompt A)
uint256 public constant MAX_DELTA_BPS       = 2000;     // ≤20% mỗi lần (prompt A)
uint256 public constant CHANGE_COOLDOWN     = 1 days;   // chống salami (#1)
uint256 public constant LOOSEN_DELAY        = 7 days;   // ma sát bất đối xứng (#5)
uint256 public constant MIN_PENALTY_BPS     = ...;      // sàn phạt (prompt B)
uint8[] SAMPLE_FILLS = [1, 5, 20];                      // điểm lấy mẫu cố định (#2)

function _validate(StakeConfig calldata c) {
    // 7 bất biến hình dạng (Phần I)
    // + mỗi collateralRate ∈ [MIN, MAX]
    // + |c.rate - current.rate| ≤ MAX_DELTA_BPS  (mọi ô)
    // + với mỗi f in SAMPLE_FILLS:  penaltyAt(c, f) ≥ MIN_PENALTY_BPS   // sàn phạt né-nắn-bucket
}

function setStakeConfig(StakeConfig calldata c) external onlyRole(GOVERNOR_ROLE) {
    require(block.timestamp >= lastChange + CHANGE_COOLDOWN, "cooldown"); // #1
    _validate(c);
    if (_isLoosening(c)) {          // ma sát bất đối xứng
        _pending = c;                // chưa active
        _pendingEffective = block.timestamp + LOOSEN_DELAY;
    } else {
        _previousConfig = _config;   // lưu để rollback (prompt B)
        _config = c;                 // siết → áp ngay
        lastChange = block.timestamp;
    }
}

function commitPending() external { require(now ≥ _pendingEffective); ... } // ai cũng gọi được
function cancelPendingConfig() external onlyRole(GUARDIAN_ROLE) { delete _pending; } // #4 veto nới-lỏng
function rollback() external onlyRole(GUARDIAN_ROLE) { _config = _previousConfig; }  // prompt B
```

`_isLoosening` = so từng ô: collateral giảm HOẶC refund tăng (hai chiều yếu đi).

## II.4 Bảng "dùng gì có sẵn của OpenZeppelin"

| Nhu cầu | OZ dùng | Tự viết? |
|---|---|---|
| Token có phiếu + checkpoint | `ERC20Votes` | Không |
| Delegation phiếu | có sẵn trong `Votes` | Không |
| Bỏ phiếu For/Against/Abstain | `GovernorCountingSimple` | Không |
| Quorum theo % cung | `GovernorVotesQuorumFraction` | Không |
| Voting delay/period, proposal threshold | `GovernorSettings` | Không |
| Đẩy thi hành qua timelock | `GovernorTimelockControl` + `TimelockController` | Không |
| Guardian hủy proposal | `GovernorProposalGuardian` | Không |
| Phân vai GOVERNOR/GUARDIAN | `AccessControl` | Không |
| **maxDelta, cooldown, sàn phạt, pending-commit nới-lỏng, rollback** | — | **CÓ — logic riêng của FillAuction** |

→ Toàn bộ *khung DAO* là OZ. Chỉ **các guard kinh tế đặc thù** (2 prompt) là
code tự viết, và chúng nằm trong FillAuction, không đụng OZ.

## II.5 CÓ ẢNH HƯỞNG TEST KHÔNG? — Có, ba nhóm

### Nhóm 1 — Vỡ vì đổi auth (owner → AccessControl)  ⚠️ nhiều nhất
Mọi test gọi setter với tư cách `owner` sẽ fail. Ảnh hưởng: `CoreGuards.t.sol`
(19), `FillAuction.t.sol`, `FrontRunGriefing.t.sol`, `RegistrationForgery.t.sol`,
handler invariant...
- **Cách sửa rẻ**: trong `setUp()`, `grantRole(GOVERNOR_ROLE, address(this))` cho
  chính test contract → giữ nguyên kiểu gọi `fillAuction.setStakeConfig(...)`
  trực tiếp, **không cần dựng cả Governor** cho unit test bảng.

### Nhóm 2 — Vỡ vì bảng động (Phần I)
Các test hardcode 4/5 bucket, `setCollateralRate/setRefundTable` cũ. Sửa sang
`setStakeConfig` + chiều động (đã liệt kê ở Phần I, ~10 file).

### Nhóm 3 — Test MỚI phải viết
- Governor E2E: propose → vote → queue → execute `setStakeConfig` (fork mẫu test
  Governor của OZ).
- Token: delegate + voting power snapshot.
- Guard: `_validate` reject từng vi phạm; **salami + cooldown**; **sàn phạt né
  reshape bucket**; **loosening vào pending, guardian cancel được**;
  **register↔đổi-config↔fill giữ snapshot** (#3/#5).
- Guardian: rollback khôi phục đúng; guardian **không** set arbitrary được.

## II.6 Scope đề xuất cho DATN (chia MUST / NICE)

| Tầng | Việc | Mức |
|---|---|---|
| **MUST** | StakeConfig động + `_validate` 7 bất biến + auth AccessControl + guard maxDelta/cooldown/sàn-phạt + snapshot ratio | Bảo mật lõi, ăn điểm audit |
| **MUST** | Pending-commit nới-lỏng + rollback (guardian) | Đóng cửa sổ snapshot + phanh khẩn |
| **NICE** | Token + Governor + Timelock (DAO đầy đủ) | Minh họa governance; token **không có value backing** → viết rõ giới hạn |
| **KHÔNG** | Cho filler vote / tự tính "bảng tốt nhất" on-chain | Đã bác bỏ (capture / bài toán B bất khả tính) |

**Khuyến nghị**: làm trọn **MUST** (đây là phần bảo mật thật, self-contained
trong FillAuction, không cần token). **NICE** (DAO/token) làm sau hoặc chỉ để
demo + mô tả — vì với DATN token vô giá trị nên an toàn vẫn phải tựa vào
`_validate`+guard, không phải cái vote (đúng kết luận cả chuỗi thảo luận).

## II.7 Thứ tự triển khai an toàn

1. Đổi auth owner→AccessControl (sửa test nhóm 1) — cô lập, làm trước.
2. StakeConfig động + snapshot ratio + `_validate` 7 bất biến (sửa test nhóm 2).
3. Guard 2 prompt: maxDelta+cooldown, sàn phạt, pending-commit nới-lỏng, rollback.
4. (NICE) Token + Governor + Timelock, cấp `GOVERNOR_ROLE` cho timelock.
5. Test mới nhóm 3.

---

# PHẦN III — THIẾT KẾ BACKEND / FRONTEND (chưa code)

> **Phân biệt scope** (chi tiết ở III.5): **THUỘC scope** = regenerate ABI, indexer
> `stake_config_history`/`pending_configs`, **trang xem bảng (đọc)**, **tab Guardian**,
> (SHOULD) keeper peg-giá. **FUTURE-WORK** (đi kèm DAO) = trang Governance/vote/propose,
> `/governance` API cho proposal/vote, index token/proposal, wallet-connect cho vote.
> Chỗ nào nhắc "governance UI / proposal / Governor" = future-work.

## III.0 Hiện trạng (khảo sát thực tế)

| Thành phần | Đụng bảng stake thế nào |
|---|---|
| **Fillers** (`CoWFiller`, `WhaleFiller`) | Đọc thật: gọi `fillAuction.previewCollateral(...)` **on-chain** rồi `register({value: stake})`. **Không tự tính bảng** → miễn nhiễm với đổi shape. Có `abis.ts` nhúng ABI FillAuction. |
| **Backend** (`routes/admin.ts`, `adminAuth.ts`) | Admin = username/password → ghi **`.env`**. **Không** set bảng on-chain. Có sẵn `/suggest-params` (`PARAM_SUGGESTION.md`) — mô hình off-chain gợi ý *tham số order* bằng market rate + binary search. |
| **Frontend** (`pages/Admin.tsx`: ConfigTab/FillersTab/ChainTab) | Panel admin sửa config off-chain; **không** có UI set bảng stake on-chain. |

→ **Tin tốt**: đổi bảng động ít phá off-chain vì filler hỏi `previewCollateral`
chứ không nhân bảng. **Việc mới chủ yếu là governance UI + indexer**, không phải
sửa luồng cũ.

## III.1 Fillers — ảnh hưởng NHỎ NHẤT

- ✅ Luồng `previewCollateral → register(value)` **giữ nguyên** — vẫn hỏi contract.
- ⚠️ **Regenerate `abis.ts`**: nếu ABI cũ có getter `collateralRate()`/`refundTable()`
  (mảng cố định) → chữ ký đổi thành `stakeConfig()` (struct động). Bất kỳ chỗ nào
  gọi 2 getter đó phải cập nhật. `previewCollateral` chữ ký không đổi → an toàn.
- 🆕 (tùy chọn) thêm view `previewRefund(orderHash, actualFill)` để filler biết
  trước sẽ được hoàn bao nhiêu nếu under-deliver — hiện chưa có, hữu ích cho UX filler.

## III.2 Backend — thêm 4 trách nhiệm

### (a) Indexer: index sự kiện mới
Thêm handler + bảng DB cho: `StakeConfigUpdated`, `PendingConfigQueued`,
`ConfigRollback`, và sự kiện Governor (`ProposalCreated`, `VoteCast`,
`ProposalQueued`, `ProposalExecuted`) + Token (`DelegateChanged`). DB mới:
`stake_config_history`, `governance_proposals`, `votes`, `pending_configs`.
→ Cấp nguồn cho toàn bộ UI governance (frontend chỉ đọc từ đây, không quét chain trực tiếp).

### (b) Keeper peg-giá (dịch vụ nền MỚI) — "backend lo liveness"
Job định kỳ: đọc **Chainlink ETH/USD** → tính lại `sizeThresholds` giữ mốc ở
mức đô cố định → gọi setter cập nhật **chỉ mốc size**, KHÔNG đụng rate.
- Honor **staleness** (`updatedAt`), **maxDelta**, **cooldown** (contract cũng
  chặn lại — backend chỉ là tuyến 1).
- Nên chạy bằng **KEEPER_ROLE riêng** (quyền hẹp: chỉ đổi threshold, không đổi
  rate) — hiện thực đúng nguyên tắc *backend = liveness, on-chain = safety*.
  (→ gợi ý thêm một role thứ 3 ngoài GOVERNOR/GUARDIAN.)

### (c) `/suggest-params` → mở rộng `/suggest-stake-config` — "expert proposer"
Mô hình off-chain đã có sẵn cho order params **tổng quát hóa** để **đề xuất bảng
stake** (đúng vai Gauntlet): chạy phân tích/mô phỏng → xuất một `StakeConfig` ứng
viên + lý do → **con người/DAO proposer** đem submit lên Governor. **Backend KHÔNG
có quyền đổi on-chain** — chỉ *gợi ý*. Giữ đúng pattern "chuyên gia đề xuất, holder duyệt".

### (d) API cho frontend governance
`GET /governance/config` (hiện tại + pending + countdown), `/governance/proposals`,
`/governance/proposal/:id` (trạng thái vote), `/governance/history`. Chỉ đọc từ DB indexer.

### (e) ⚠️ Tách MÔ HÌNH AUTH (điểm thiết kế tinh tế)
Hiện admin = **username/password → token**. Governance mới = **ký ví on-chain**.
Hai mô hình tin cậy song song:
- **Ops config** (chains, fillers, .env) → giữ password (off-chain, tập trung, OK).
- **Governance** (propose/vote/rollback) → **ví ký tx** (token holder / guardian
  multisig). KHÔNG dùng password — vì đây là quyền on-chain thật.
→ Đừng nhét quyền governance vào cổng password cũ; đó là hai trục quyền khác nhau.

## III.3 Frontend — thêm bề mặt governance (phần lớn là MỚI)

| Màn hình | Nội dung | Auth |
|---|---|---|
| **Config viewer** (công khai) | Bảng `StakeConfig` hiện tại (render **động N×M**), lịch sử, pending kèm **đếm ngược hiệu lực** | không cần — minh bạch = trust-minimization (filler thấy trước điều khoản) |
| **Governance / DAO** (mới) | Danh sách + chi tiết proposal; **tạo proposal** (soạn StakeConfig → encode calldata `setStakeConfig`); **vote** For/Against/Abstain (tx ví); nút **queue/execute** sau timelock; **delegate** phiếu token | **ví** (token holder) |
| **Guardian panel** (mới) | Nút **rollback**, **cancelPendingConfig**, xem pending nới-lỏng + đếm ngược | **ví guardian multisig** |
| **Filler-facing** (mở rộng) | Hiển thị collateral rate hiện tại + đường cong refund để filler hiểu điều khoản trước khi register | không cần |

- 🆕 Cần **kết nối ví** (wagmi/ethers + WalletConnect) — hiện panel admin dùng
  password, chưa có wallet-based governance UI.
- ⚠️ Bảng render **động** (không hardcode 4×5) — component đọc kích thước từ config.
- ConfigTab cũ (nếu có nút set param on-chain) → chuyển sang luồng governance;
  còn chỉnh .env off-chain thì giữ nguyên.

## III.4 Cross-cutting

- **Regenerate ABI FillAuction** ở **cả 3 nơi** nhúng nó: `filler/*/abis.ts`,
  frontend, backend. Thêm ABI mới: NeutronToken, Governor, Timelock.
- **`owner()` → role**: chỗ nào backend/frontend đọc `owner()` để hiển thị/kiểm
  tra sẽ vỡ → đổi sang đọc `hasRole(...)`.
- **Swapper/luồng order KHÔNG đổi**: swapper không đụng bảng stake (collateral là
  phía filler). UX swapper giữ nguyên, chỉ thêm minh bạch (tùy chọn). Ranh giới scope rõ.

## III.5 Scope off-chain đề xuất cho DATN

| Việc | Mức | Ghi chú |
|---|---|---|
| Regenerate ABI (filler+FE+BE) | **MUST** | Nếu không, off-chain gọi getter cũ sẽ vỡ |
| Indexer sự kiện config + DB history | **MUST** | Rẻ, và là nguồn cho mọi UI |
| Config viewer (đọc, render động) | **MUST** | Minh bạch điều khoản — đúng tinh thần trust-minimization |
| Keeper peg-giá (KEEPER_ROLE) | **SHOULD** | Giải quyết #1 (mốc trôi) — phần "cơ học" thực tế nhất |
| `/suggest-stake-config` | **NICE** | Tổng quát hóa cái đã có; vai expert-proposer |
| Governance UI + Guardian panel + wallet auth | **NICE** | Đi kèm tầng DAO (Phần II NICE); nhiều việc FE |

**Khuyến nghị off-chain**: bám **MUST + keeper** — chúng thật, self-contained,
và khớp tầng MUST của contract. Governance UI (wallet, proposal, vote) là khối
lớn nhất và chỉ cần khi làm DAO đầy đủ → gộp vào phần NICE/demo, mô tả trong báo cáo.
