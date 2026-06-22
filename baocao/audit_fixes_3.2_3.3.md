# Ghi chú sửa lỗi audit Trufy — 3.2 & 3.3

**Ngày:** 2026-06-19
**Tóm tắt:** Hai phát hiện mức **Cao** trước đây ở trạng thái *Đã giải trình* (3.2) và *Ngoài phạm vi* (3.3) nay đã được **sửa và kiểm chứng**. Sau khi sửa: `forge test` đạt **149/149** (thêm 2 test mới, không hồi quy); backend `tsc --noEmit` **0 lỗi** trong `src/`.

---

## 3.2 — Token fee-on-transfer qua kế toán danh nghĩa (Cao)

### Vấn đề
Hợp đồng `PartialFillReactor` kiểm tra mức sàn output (chống trượt giá) dựa trên **số danh nghĩa** mà nó yêu cầu filler chuyển, chứ không phải số người dùng **thực nhận**. Với token thu phí khi chuyển (fee-on-transfer), người dùng nhận ít hơn số danh nghĩa → mức sàn "đạt trên giấy" nhưng người dùng bị trả thiếu.

### Nguyên nhân gốc
Tại `executePartialChunk`, các kiểm tra sàn (`require(outputAmount >= minChunk)` và `paid >= minOutputAmount`) cùng biến kế toán `_paidOutput` đều tính trên `outputAmount` danh nghĩa, đặt **trước** lần chuyển token.

### Cách sửa
File: [`contract/src/PartialFillReactor.sol`](../contract/src/PartialFillReactor.sol) — hàm `executePartialChunk`.
Đo **chênh lệch số dư thực tế** của người dùng quanh lần chuyển output và áp mọi kiểm tra sàn + kế toán trên số *thực nhận*:

```solidity
uint256 balBefore = IERC20(order.info.outputToken).balanceOf(order.info.swapper);
IERC20(order.info.outputToken).safeTransferFrom(msg.sender, order.info.swapper, outputAmount);
uint256 received = IERC20(order.info.outputToken).balanceOf(order.info.swapper) - balBefore;

require(received >= minChunk, "min output");
uint256 paid = _paidOutput[orderHash] + received;
_paidOutput[orderHash] = paid;
if (newRemaining == 0) require(paid >= order.info.minOutputAmount, "min output total");
```

- Sự kiện `PartialFillExecuted` nay phát **số thực nhận** thay vì số danh nghĩa.
- An toàn reentrancy: state quan trọng (`_remaining`) vẫn được ghi **trước** khi chuyển; phần ghi sau lần chuyển được bảo vệ bởi `nonReentrant` sẵn có. Nếu kiểm tra sàn thất bại, cả giao dịch revert (nguyên tử).

### Kiểm chứng
- Mock token thu phí: [`contract/test/mocks/FeeOnTransferToken.sol`](../contract/test/mocks/FeeOnTransferToken.sol) (skim 2%).
- Test: [`contract/test/FeeOnTransfer.t.sol`](../contract/test/FeeOnTransfer.t.sol)
  - `test_feeOnTransferOutput_belowFloor_reverts`: số danh nghĩa 2500 ≥ sàn 2475, nhưng phí 2% còn 2450 < 2475 → **revert "min output"** (trước khi sửa sẽ âm thầm trả thiếu).
  - `test_feeOnTransferOutput_aboveFloor_creditsActualReceived`: số thực nhận 2450 ≥ sàn 2400 → thành công, người dùng được ghi đúng **2450** (không phải 2500).

### Mức lan toả
**Khu trú** trong `PartialFillReactor`. Không đổi chữ ký EIP-712, không đổi schema lệnh, không đụng backend/frontend. Token ERC-20 chuẩn (không phí) cho `received == outputAmount` nên 147 test cũ không đổi hành vi.

---

## 3.3 — Watcher bỏ qua sự kiện lịch sử sau outage dài (Cao)

### Vấn đề
Sau khi backend dừng lâu rồi khởi động lại, checkpoint của watcher **nhảy thẳng về block hiện tại**, bỏ qua mọi sự kiện (`SlotFilled`/`EscrowCreated`, `PartialFillExecuted`...) trong khoảng trống → người dùng có thể bị kẹt chờ.

### Nguyên nhân gốc
File [`backend/src/db/checkpoint.ts`](../backend/src/db/checkpoint.ts), hàm `resolveCheckpoint`: khi độ lệch giữa checkpoint và tip vượt `MAX_CHECKPOINT_LAG = 1000`, nó **rewind về tip** (vốn là tiện ích cho anvil fork reset trong môi trường dev), khiến outage thật cũng bị bỏ qua. Ngoài ra mỗi vòng poll gọi `queryFilter` cho **toàn bộ** dải `[last+1, current]` trong một lần — dải lớn sau outage dễ vượt giới hạn của RPC.

### Cách sửa
File: [`backend/src/db/checkpoint.ts`](../backend/src/db/checkpoint.ts)

1. `resolveCheckpoint` phân biệt 2 tình huống:
   - **Checkpoint vượt tip** (chain reset/rollback) → rewind về tip (không thể index tương lai).
   - **Checkpoint sau tip** (backlog thật) → **giữ nguyên `last` để backfill**. Chỉ rewind khi độ lệch lớn bất thường **và** backfill chưa bật (mặc định dev), để tránh quét một fork cũ đã chết. Production mặc định `INDEXER_BACKFILL=true` nên luôn replay.
2. Thêm `queryFilterChunked(...)` — quét dải block theo **từng đoạn có giới hạn** (`INDEXER_CHUNK`, mặc định 2000) để một lần `eth_getLogs` không vượt giới hạn RPC.

Đã thay `queryFilter` bằng `queryFilterChunked` ở:
- [`backend/src/indexer/eventIndexer.ts`](../backend/src/indexer/eventIndexer.ts) (PartialFillExecuted, FallbackExecuted)
- [`backend/src/chain/escrowDstWatcher.ts`](../backend/src/chain/escrowDstWatcher.ts) (EscrowCreated — luồng xuyên chuỗi mà finding nhắm tới)

### Biến môi trường mới (đều có mặc định an toàn)
| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `INDEXER_BACKFILL` | `true` nếu `NODE_ENV=production`, ngược lại `false` | Bật replay backlog sau outage |
| `INDEXER_CHUNK` | `2000` | Kích thước đoạn quét mỗi `eth_getLogs` |
| `INDEXER_DEV_REWIND_LAG` | `5000` | Ngưỡng lệch để dev rewind khi backfill tắt |

### Kiểm chứng
- `tsc --noEmit`: **0 lỗi** trong `src/` (các lỗi báo còn lại đều nằm trong `node_modules/@uniswap/...`, là khai báo type thiếu của thư viện bên thứ ba, không liên quan).
- Chưa có unit test tự động: backend không có harness test sẵn (script `test` là stub) và việc tái hiện cần Postgres + RPC + outage thật. Hàm `queryFilterChunked` là hàm thuần, dễ kiểm thủ công; logic `resolveCheckpoint` được kiểm bằng lập luận theo 2 nhánh ở trên.

### Mức lan toả
**Chỉ backend.** Không đổi một dòng contract, không đổi schema/chữ ký. Tập trung trong module checkpoint dùng chung + 2 điểm gọi ở watcher.

---

## Ảnh hưởng tới báo cáo (ĐỀ XUẤT — chưa áp vào DoAn)

1. Bảng Trufy (mục 4.4.1): chuyển **3.2** và **3.3** từ *Đã giải trình / Ngoài phạm vi* → **Đã sửa**.
2. Mục 4.4.2 "Phát hiện đã khắc phục": bổ sung mô tả 3.2 và 3.3 (hiện chỉ có 3.7).
3. Bỏ 3.2 và 3.3 khỏi mục 4.4.3 "Các phát hiện chỉ kiểm chứng được trên production".
4. Số test: **147 → 149**, số bộ test **23 → 24**; cập nhật Bảng 4.1 (nhóm PartialFillReactor 36 → 38, tổng 149) và câu ở §4.1, §4.3.

> Lưu ý: 3.1 (cọc cố định) vẫn nên giữ *Đã giải trình* — sửa đúng là thay đổi xâm lấn (thêm field vào lệnh ký), không hợp lý cho một đồ án chạy local.

## Lệnh kiểm chứng

```bash
# Contract (WSL, foundry)
cd contract && forge test --summary           # 149 passed, 0 failed
forge test --match-contract FeeOnTransferTest -vv

# Backend typecheck
cd backend && node node_modules/typescript/bin/tsc --noEmit   # 0 lỗi trong src/
```
