# Bước tiếp theo: Slither + Mutation Testing

Runbook cho session sau. Mục tiêu: bổ sung hai bằng chứng chất lượng test trước bảo vệ — **phân tích tĩnh (Slither)** và **đo chất lượng bộ test (mutation testing)**. Cả hai khả thi cho sinh viên đơn lẻ sát ngày bảo vệ (xem ước lượng thời gian từng phần).

> Bối cảnh: bộ test hiện có 149 test / 24 suite (unit + fuzz + invariant + fork + adversarial). Đã qua Trufy (AI audit). Hai việc dưới đây lấp lỗ "chưa có static analysis" và "chưa đo chất lượng test".

> ⚠ Lưu ý phiên bản: tooling Solidity đổi nhanh. **Đầu session, verify lại tên/cài đặt công cụ mới nhất** (Claude search hoặc đọc README) trước khi chạy lệnh cứng bên dưới.

---

## Môi trường

- Foundry chạy trong **WSL** (Windows không có forge trên PATH). Mẫu lệnh:
  ```bash
  wsl.exe bash -ic 'export PATH="$PATH:$HOME/.foundry/bin"; cd /mnt/c/Users/vutie/Documents/DATN/dex-aggregator/contract && forge build'
  ```
- Thư mục contract: `contract/`. Có `foundry.toml`, `src/`, `test/`, `lib/`.
- Một số suite là **fork mainnet** (chậm) — quan trọng cho phần mutation (xem dưới).

---

## PHẦN A — Slither (ưu tiên 1, ~vài giờ)

### A1. Cài
```bash
# Trong WSL (cần python3 + pip)
pip install slither-analyzer
# Slither dùng crytic-compile, tự nhận diện Foundry qua foundry.toml
```
Nếu lỗi solc version: cài `solc-select`, chọn version khớp `foundry.toml` (pragma `^0.8.20`).

### A2. Chạy
```bash
cd contract
# Bản đầy đủ ra file markdown:
slither . --checklist --filter-paths "lib/|test/" > slither-report.md 2>&1
# Bớt nhiễu (bỏ Informational/Optimization) nếu quá nhiều:
slither . --exclude-informational --exclude-optimization --filter-paths "lib/|test/"
```
- `--filter-paths "lib/|test/"` bỏ dependency (OpenZeppelin, Uniswap) và test khỏi báo cáo — chỉ soi code của mình.

### A3. Phân loại kết quả (việc chính, Claude hỗ trợ)
Slither **có dương tính giả**. Với mỗi cảnh báo, phân vào 3 nhóm:
1. **Thật, nên fix** → sửa trước bảo vệ.
2. **Thật nhưng đã có phòng vệ** (vd reentrancy ở hàm đã có `nonReentrant`) → giải trình, không cần sửa.
3. **Nhiễu** (sai pattern) → bỏ qua, ghi lý do.

Chỗ cần soi kỹ: các hàm chuyển ETH/token (`PartialFillReactor`, `FillAuction.slash/withdraw`, `EscrowSrc`), low-level `call` ở `FallbackExecutor`, `delegatecall`/clone ở `EscrowSrcFactory`.

### A4. Báo cáo trong luận văn / phản biện
Một câu: "Chạy Slither, ra N cảnh báo; phân loại: X fix, Y giải trình (đã có phòng vệ), Z nhiễu." → thể hiện chỉn chu.

---

## PHẦN B — Mutation Testing (ưu tiên 2, ~1-3 ngày)

### B1. Là gì (nhắc lại)
Công cụ chèn lỗi nhỏ ("mutant": đổi `>=`→`>`, `+`→`-`, xóa `require`) vào code → chạy lại test với từng mutant. Test fail = mutant bị **giết** (tốt). Test vẫn pass = mutant **sống sót** = bộ test có điểm mù. **Mutation score = giết / tổng.** Đo chất lượng test (coverage không đo được điều này).

### B2. Công cụ (verify bản mới nhất đầu session)
- **Gambit** (Certora) — sinh mutant cho Solidity, hợp Foundry. Cần script chạy test cho từng mutant.
- **vertigo-rs** — mutation testing tự động cho Foundry/Hardhat (chạy luôn test).
- Chọn 1; Gambit maintained tốt, vertigo-rs tự động hơn.

### B3. ⚠ Vướng chính: tốc độ
Mutation chạy lại **cả bộ test cho MỖI mutant**. Với fork test (chậm) × hàng trăm mutant → nhiều giờ tới ngày.

**Cách lách — chạy mutation CHỈ trên suite KHÔNG-fork, scope vào logic lõi:**
- File nên mutate (logic thuần, test nhanh): `DynamicStakeLib.sol`, `DecayCursorLib.sol`, `ScaledOutputLib.sol`, `RemainingLib.sol`, `SlotLib.sol`, phần logic trong `FillAuction.sol`, `PartialFillReactor.sol`.
- **Bỏ qua lần đầu:** các path fork mainnet và cross-chain phụ thuộc deploy (chậm).
- Trong Foundry, lọc test fork bằng `--no-match-contract` / `--no-match-test` hoặc tạo profile riêng trong `foundry.toml` chỉ chạy unit+fuzz nhanh.

### B4. Quy trình
1. Sinh mutant cho 1-2 file lõi trước (vd `DynamicStakeLib.sol`) để thử pipeline.
2. Chạy test (suite nhanh) với từng mutant → thu mutation score.
3. **Mutant sống sót** → với mỗi cái:
   - Viết test mới để giết nó (Claude hỗ trợ nhanh), HOẶC
   - Ghi nhận là "equivalent mutant" (mutant không đổi hành vi thật — không giết được, hợp lệ).
4. Mở rộng dần sang các file lõi còn lại.

### B5. Mục tiêu thực tế
- **Không cần** giết 100% (equivalent mutant tồn tại).
- Báo cáo được "mutation score X% trên các module lõi, đã thêm K test giết mutant sống sót" là **đủ mạnh** cho phản biện.
- Đừng sa đà vào fork/cross-chain mutation — tốn thời gian, để future work.

---

## PHẦN C — Thí nghiệm kháng thao túng TWAP (ưu tiên cao về "đóng góp", ~1-2 ngày)

### C1. Vì sao đáng làm
Khác Slither/mutation (đo chất lượng test chung), thí nghiệm này **gắn trực tiếp với cơ chế của đồ án** và **định lượng hóa Trufy 3.5**: nâng lập luận "cửa sổ TWAP ngắn dễ thao túng" từ **định tính** lên **đo được**. Một đòn thực nghiệm nặng ký cho phản biện.

### C2. Giả thuyết cần chứng minh
Cọc filler tính qua TWAP (`DynamicStakeLib.toEthNotional` → `computeCollateral`). Khi kẻ tấn công đẩy giá pool tham chiếu:
- **Cửa sổ NGẮN** (vd 60s): cọc lệch **mạnh** → under-collateralize được.
- **Cửa sổ DÀI** (vd 1800s): cọc lệch **~0** → kháng thao túng.

### C3. Cách làm (Foundry test trên fork mainnet)
> Lưu ý quan trọng: order NeutronX **không** tạo observation cho TWAP. Phải **swap thật trên chính pool Uniswap V3 tham chiếu** để đẩy giá. Fork mainnet đã mang sẵn lịch sử observation nên đọc được cả TWAP dài.

1. `forge test --fork-url <MAINNET_RPC> --fork-block-number <N>` — chọn block mà pool `(inputToken, WETH)` có `observationCardinality` đủ phủ cửa sổ dài (pool lớn thường đã mở rộng).
2. Deploy FillAuction với **cửa sổ ngắn** (60s); đọc cọc cho một order mẫu qua `previewCollateral(...)` → ghi `C_short_baseline`.
3. **Thao túng:** dùng `deal()` cấp lượng lớn token, `prank` một địa chỉ, swap lượng lớn trên pool V3 để đẩy giá lệch.
4. `vm.roll` + `vm.warp` tiến 1-2 block (để giá lệch lọt vào cửa sổ TWAP ngắn với trọng số đáng kể).
5. Đọc lại cọc → `C_short_attacked`. Tính `Δ_short = |C_short_attacked − C_short_baseline| / C_short_baseline`.
6. Lặp toàn bộ với FillAuction **cửa sổ dài** (1800s) → `Δ_long`.
7. **Khẳng định:** `Δ_short` lớn (vd >20%), `Δ_long` nhỏ (vd <2%). Có thể `assertLt(Δ_long, Δ_short / 5)` hoặc tương tự.

### C4. Đầu ra cho báo cáo
Một bảng "Độ dài cửa sổ TWAP vs độ lệch cọc dưới tấn công" → đưa vào Chương 4 (kiểm thử), củng cố mục Trufy 3.5. Tùy chọn nâng cao: ước lượng **chi phí thao túng** (vốn cần + lỗ do arb) theo độ dài cửa sổ — khó hơn, làm sau nếu còn thời gian.

### C5. Vướng & caveat
- Pool tham chiếu phải có `observationCardinality` đủ lớn cho cửa sổ dài; nếu không, đọc TWAP dài revert "OLD". Chọn pool lớn (vd USDC/WETH 0.05%).
- Lượng swap thao túng phải **lớn so với thanh khoản pool** mới đẩy giá đáng kể.
- Đây là **chứng minh cơ chế của đồ án**, không phải chứng minh lại Uniswap — giữ trọng tâm ở "độ lệch cọc", không sa vào mô phỏng thị trường.

---

## Thứ tự đề xuất cho session sau

1. **Slither** trước (vài giờ, ROI tức thì) → có `slither-report.md` + phân loại.
2. **Mutation trên 1 file lõi** (`DynamicStakeLib`) để dựng pipeline + lấy con số mẫu.
3. Mở rộng mutation sang các lib + logic FillAuction/Reactor nếu còn thời gian.
4. **Thí nghiệm kháng thao túng TWAP (PHẦN C)** — ưu tiên cao nhất về *đóng góp* (gắn trực tiếp cơ chế đồ án, định lượng Trufy 3.5). Cân nhắc làm trước mutation nếu mục tiêu là "điểm nhấn phản biện" hơn là "độ phủ test".
5. Cập nhật Chương 4 (kiểm thử): tiểu mục "Phân tích tĩnh và đánh giá chất lượng test" (Slither + mutation score) + bảng kháng thao túng TWAP.
6. Cái KHÔNG làm (ghi future work ở Chương 5): formal verification đầy đủ, testnet cross-chain + soak test, mô phỏng kinh tế tác nhân.

## Liên kết
- Phân tích đầy đủ "test đã đủ chưa / protocol thật làm gì / thiếu gì": xem phần kiểm thử trong `PHAN_BIEN_QA.md` ở gốc repo (chưa đưa thành mục riêng — nằm trong thảo luận về kiểm thử).
- Báo cáo kiểm thử: `baocao/Chuong/4_Kiem_thu.tex`.
