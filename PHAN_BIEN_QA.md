# Chuẩn bị phản biện — NeutronX (DEX aggregator intent-solver)

Tài liệu ôn nhanh trước buổi bảo vệ. Mỗi mục gồm: **biến thể câu hỏi** → **câu chốt** → **lập luận nhiều lớp** → **thừa nhận thành thật** (chỗ không nên bịa).

Nguyên tắc xuyên suốt: **thành thật về hạn chế đúng lúc** thì ghi điểm; **defensive hoặc bịa** thì mất điểm. Biến điểm yếu thành "lựa chọn thiết kế có chủ đích".

---

## Nền tảng (warm-up — thầy hay hỏi mở màn)

**EVM là gì:** máy ảo, môi trường thực thi smart contract. Bản chất là **máy trạng thái**: input + trạng thái cũ → trạng thái mới. Chạy bytecode. **Deterministic** — mọi node ra cùng kết quả (bắt buộc để đồng thuận). Gas giới hạn tính toán, chống vòng lặp vô hạn.

**Blockchain lưu dữ liệu thế nào:** hai tầng. (1) *Chuỗi block:* mỗi block chứa hash block trước → sửa block cũ làm gãy mọi liên kết sau → bất biến. (2) *Trạng thái thế giới:* map `địa chỉ → tài khoản`, lưu trong cây Merkle Patricia Trie; header block chỉ chứa **stateRoot** (1 hash tóm tắt toàn bộ). Dữ liệu **nhân bản trên mọi full node**, không nằm một chỗ. Trên đĩa = một **database key-value** (LevelDB/Pebble), KHÔNG phải mỗi block một file.

**Block trông thế nào:** header (`parentHash`, `stateRoot`, `transactionsRoot`, `timestamp`, `gasUsed`...) + body (danh sách tx). Băm header → hash block; block sau trỏ `parentHash` tới đó.

**Tài khoản / state:** mỗi tài khoản 4 trường `{nonce, balance, storageRoot, codeHash}`. EOA: `codeHash`/`storageRoot` rỗng. **Contract** = tài khoản mà 2 trường đó trỏ tới dữ liệu thật.

**Smart contract là gì, ở đâu, ai chạy:** một tài khoản có gắn **bytecode** + **storage** (map `slot 256-bit → giá trị 256-bit`), nằm trong state, nhân bản mọi node. Chạy khi có **transaction gọi tới**; **mọi node tự chạy lại cùng code** để kiểm chứng — không phải "một server" chạy. Không có tx = không chạy (lý do cần backend watcher kích hoạt).
- Ví dụ storage: `mapping(bytes32=>bool) _cancelled` ở slot 2 → `_cancelled[h]` lưu tại `keccak256(abi.encode(h, 2))`. Ghi `=true` → đổi storageRoot → đổi stateRoot → cam kết vào header.

**Transaction trông thế nào:** `{nonce, to, value, gas, data, chữ ký v/r/s}`. "Gọi hàm" = trường **`data`** = `[4 byte selector] ++ [tham số ABI-encode]`. Selector = `keccak256("tênHàm(kiểu)")[:4]`. EVM đọc 4 byte đầu → biết hàm nào.

**Tại sao swap 2 chain khác nhau khó:** mỗi chain là **máy trạng thái cô lập, không tự nhìn thấy chain kia** — không opcode "đọc chain khác", không đồng hồ chung, không state chung. Token trên A và B là 2 contract trên 2 sổ cái khác → chuyển value bắt buộc là **2 tx trên 2 chain**, không nguyên thủy nào ràng atomic. Phải xây liên kết: **bridge** (có bên giữ tài sản → rủi ro custody), **HTLC** (bí mật chung + timelock → secret lộ ở chain này mở khóa chain kia — *NeutronX dùng*), hoặc **light client/zk**.

**Chain EVM-based:** chain dùng EVM làm runtime (Ethereum, Polygon, BNB, Arbitrum, Base...). Cùng EVM = **cùng contract Solidity deploy được**, NHƯNG **vẫn là chain tách rời** (validator riêng, state riêng). Cùng "ngôn ngữ", không cùng "thế giới" → vẫn không swap trực tiếp được.

---

## 0. "Đồ án chỉ là vài contract khớp lệnh từng phần thôi à?"

**Chốt:** Khớp từng phần chỉ là 1 trong **4 cơ chế**.

Trình bày nhanh cả bốn:
1. **Đấu giá Hà Lan + khớp từng phần** — giá giảm dần theo block, mỗi nhịp tính giá độc lập; vừa cho nhiều filler tham gia vừa hạn chế MEV.
2. **Đặt cọc & phạt (FillAuction)** — filler stake ETH trước khi nhận lệnh, bỏ dở bị slash. Cơ chế **kinh tế**, không phải logic khớp lệnh.
3. **Cơ chế dự phòng (fallback)** — sau hạn filler, bất kỳ ai swap nốt phần dư qua aggregator. Tính chất **an toàn/liveness**: user không bao giờ kẹt.
4. **Xuyên chuỗi không cầu nối** — HTLC + Merkle slot secret, chia nhỏ lệnh xuyên chuỗi mà vẫn atomic. Phần phức tạp nhất: hai lớp timelock T1/T2, 4 hợp đồng phối hợp, backend theo dõi & reveal secret đúng lúc.

Thêm: 149 test (fuzz + invariant), đã qua rà soát bảo mật độc lập (Trufy).

**Tránh:** liệt kê tên hàm; nói "em làm cả frontend" như điểm cộng lớn; giọng phòng thủ.

---

## 1. Atomicity xuyên chuỗi — "Chứng minh hình thức đâu?"

**Biến thể:** "Filler reveal ở B đúng block T2−1 rồi chuỗi A nghẽn thì sao?"

**Chốt thành thật:** Không có formal proof — em chứng minh bằng **lập luận ca + invariant test**, và ghi rõ là hạn chế ở Chương 5.

Lập luận:
- Hashlock + timelock với **T2 < T1**: deadline chuỗi đích (T2) **sớm hơn** chuỗi nguồn (T1).
- Filler buộc phải reveal secret ở chân đích **trước T2**, tức trước khi chân nguồn (T1) hết hạn → user luôn kịp dùng secret công khai để nhận chân nguồn.
- Nếu filler không hành động: user `cancel` lấy lại tài sản sau timelock. **Mất liveness, không mất tiền.**
- Backend cosign kiểm soát T2 (= deadline − t2Buffer), từ chối order có T2 ≥ T1 (đã chặn ở watcher).

**Không bịa proof.** Nếu bị ép: "chứng minh hình thức bằng model checker là hướng phát triển em nêu ở Chương 5."

---

## 2. Cosigner tập trung — "Có thật sự trustless không, hay chỉ đổi bridge thành server của anh?"

**Chốt:** Cosigner **không giữ tài sản** → rủi ro là *liveness*, không phải *mất tiền*. Khác bản chất với bridge.

Lập luận theo lớp (đúng thứ tự):
1. Cosigner chỉ kiểm **tham số** (T2) và relay `claim()`; **không custody** tài sản. Tài sản khóa on-chain bằng HTLC.
2. Xấu nhất cosigner chết/độc: user vẫn `cancel` lấy lại tài sản sau timelock. **Mất liveness, không mất tiền** — bridge sập là mất tiền.
3. Phi tập trung thật = chia cosigner thành **threshold signature / MPC** nhiều bên (cái production làm).
4. *(lớp phụ)* **TEE** giữ key trong enclave + attest code — nhưng thêm giả định tin phần cứng, nên chỉ là tùy chọn bổ sung, **không thay MPC**.

**Về TEE — đừng nói sai:** đa số bridge thật **không** chạy TEE. Mainstream là **MPC/multisig committee** (Wormhole, Ronin) và **zk light client** (Polyhedra). TEE là thiểu số — ví dụ kinh điển *duy nhất* đáng kể là **Avalanche Bridge (Intel SGX)**.

**Bẫy nếu nói TEE:** "SGX bị phá nhiều lần — Foreshadow, Plundervolt, ÆPIC Leak." → trả lời: TEE chỉ bảo vệ key + attest code, **không phải lời giải phi tập trung**; phi tập trung thật là threshold cosigner.

**Chốt câu:**
> "Dù cosigner sập theo cách nào, user vẫn lấy lại được tài sản qua timelock, nên rủi ro ở đây là liveness chứ không phải mất tiền — đó là khác biệt căn bản so với bridge giữ tài sản."

---

## 3. MEV / frontrun — "Settle bằng smart contract = có transaction = frontrun được?"

**Chốt:** Mọi tx **có thể** bị reorder, nhưng frontrun chỉ **có lãi** khi có bề mặt giá lấy từ pool để bóp. Giá user của em **khóa bằng chữ ký**, không đọc pool.

Lập luận:
- Sandwich cần swap đọc **giá pool AMM** để đẩy lệch. Settlement của em: `outputAmount = fillAmount × currentPrice / 1e18`, với `currentPrice = startPrice − blocksPassed × decayPerBlock` — **hàm của tham số đã ký + block.number, KHÔNG đọc pool** (`PartialFillReactor.sol:160-167`, `DecayCursorLib.sol:23-31`).
- `startPrice`, `decayPerBlock` nằm trong **typehash đã ký**. Sàn `minOutputAmount` đã ký chặn đáy.
- → reorder quanh tx settlement **không đổi được** số user nhận.

**TWAP — làm rõ:** TWAP **không** dùng trong settlement (reactor không có dòng TWAP nào). Chỉ dùng ở `DynamicStakeLib` để tính **cọc filler** (ETH notional). Vector riêng (Trufy 3.5), time-weighted nên kháng thao túng 1 block.

**MEV còn sót (thành thật):**

| Bề mặt | Bị MEV? | Ai chịu |
|---|---|---|
| Settlement reactor (giá đã ký) | Không — không đọc pool | — |
| Filler tự gom thanh khoản (swap Uniswap để có token trả) | Có | **Filler** chịu, không phải user; filler dùng private orderflow tự bảo vệ |
| Đường **fallback** (swap qua router AMM) | Có — đường này *có* chạm pool | Sàn đã ký chặn đáy → user tệ nhất chỉ bằng sàn |
| TWAP tính cọc | Vector riêng | Time-weighted + Trufy 3.5 |

**Tầng kiến trúc (mạnh hơn):** vì là intent-based, lệnh user **không xuất hiện công khai trong mempool** → không có tx để sandwich, giống UniswapX/CoW. Đấu giá + sàn là **lớp phòng thủ thứ hai** (phòng filler tự xử như bot, khớp muộn vợt decay spread).

**Chốt câu:**
> "Sandwich cần bề mặt giá lấy từ pool; giá user của em khóa bằng chữ ký nên reorder không đổi được output. MEV còn sót nằm ở phía filler tự gom thanh khoản — chi phí của filler, đã dịch khỏi user. TWAP em chỉ dùng tính cọc, không dính giá user."

---

## 4. Đo MEV — "Đo được giảm bao nhiêu %?"

**Chốt:** MEV là hiện tượng **thực nghiệm quy mô mainnet** — local fork không có mempool/searcher thật để đo. Cái em đảm bảo là **chặn trên giải tích**, không phải con số %.

Lập luận:
- Phân biệt **đo thực nghiệm** (cần mainnet, không làm được/không cần) vs **chặn trên giải tích** (đã có).
- Đã có qua adversarial test: `test_lateFill_skimsDecaySpread_butStaysAboveFloor` (filler muộn chỉ vợt tối đa decay spread, luôn trên sàn), `test_lateFill_belowFloor_reverts` (dưới sàn thì revert).
- Tức là không "đo" mà **chặn**: giá trị MEV tối đa bị giới hạn bởi sàn đã ký.

**Protocol thật đo thế nào:** tự đo nội bộ (CoW công bố surplus, UniswapX công bố price improvement) **+** bên thứ ba độc lập (Flashbots `mev-inspect`, EigenPhi, Dune) — **không phải "thuê"**. Học thuật: **Qin et al. 2022** (`qin2022quantifying`, có trong thư mục của em) là phương pháp chuẩn.

**Chốt câu:**
> "Local fork không có mempool và searcher thật để đo. Cái em đảm bảo là chặn trên giải tích: sàn của em giới hạn giá trị tối đa filler bóc được đúng bằng decay spread, adversarial test chứng minh không bao giờ xuống dưới sàn. Đo mức giảm thực cần mainnet + phương pháp như Qin et al. — đó là hướng phát triển."

**⚠ Check báo cáo:** đảm bảo câu chữ là "**hạn chế/chặn trên** MEV", KHÔNG có con số định lượng kiểu "giảm 40%".

---

## 5. UX — "User chờ lâu quá thì sao?"

**Chốt:** Chờ lâu là **đánh đổi cố hữu** của intent (UniswapX/CoW cũng vậy). Điểm em đảm bảo: thời gian chờ **bị chặn trên** bởi deadline — không bao giờ kẹt vô hạn.

Lập luận:
- Thừa nhận: intent có sàn độ trễ mà AMM 1-block không có (phát lệnh → filler quyết → khớp → confirm, nhiều vòng). **Đừng nói "nhanh như AMM".**
- **Đáy cứng:** lệnh có deadline (mặc định 100 block ≈ **20 phút** Ethereum); tới hạn → **fallback** swap nốt phần dư, đảm bảo hoàn tất. Câu hỏi "chờ bao lâu" **bị chặn trên**.
- **Trường hợp thường nhanh:** backend đặt `startPrice` cao hơn thị trường **+2%** → filler vào sớm; `targetCoverageBps=90%` → chỉ tạo lệnh khi filler phủ được ≥90%; khớp từng phần cho user thấy **tiến độ** thay vì chờ trắng.
- **Scoping thành thật:** lệnh nhỏ ưu tiên tốc độ → AMM hợp hơn, không cạnh tranh ở đó. Mô hình em có giá trị với **lệnh lớn**: user đổi chút độ trễ lấy giá tốt + chống MEV.
- **Xuyên chuỗi** chậm hơn (confirm cả hai chân + reveal secret) — cái giá của **trustless không cầu nối**: bridge nhanh hơn vì có bên giữ tài sản.

**Chốt câu:**
> "Thời gian chờ bị chặn trên bởi deadline — tới hạn fallback tự hoàn tất lệnh, user không kẹt vô hạn. Trường hợp thường, giá khởi điểm +2% để filler vào sớm, khớp từng phần cho thấy tiến độ. Em nhắm lệnh lớn — nơi user sẵn sàng đổi chút độ trễ lấy giá tốt hơn và tránh MEV."

---

## 6. "Sao không có cơ chế skip fallback nếu user không thích?"

**Chốt:** Premise sai — user **đã skip được rồi** qua chính tham số đã ký. Sàn `minOutputAmount` chính là núm tắt fallback; cancel là núm "đổi ý". Một cờ skip riêng vừa trùng lặp vừa tái sinh đúng bài toán fallback sinh ra để giải.

Lập luận:
- **Sàn = núm tắt fallback.** Fallback chỉ chạy nếu kết quả ≥ sàn đã ký. Đặt sàn cao → fallback không đạt → revert → lệnh hết hạn không khớp → **user giữ token**. "Không thích fallback" = "đặt sàn chặt hơn", đã có sẵn.
- **Cancel = núm đổi ý.** `cancelOrder()` / `invalidateNonce()` rút lệnh trước cửa sổ fallback.
- **Không thêm cờ skip vì:** (1) trùng lặp với sàn; (2) tái sinh bài toán treo lệnh — fallback tồn tại để lệnh **luôn hoàn tất khi filler bỏ dở**; (3) thêm bề mặt griefing (filler đăng ký rồi bỏ, user đã opt-out → kẹt); (4) thêm field typehash + nhánh contract đổi lấy thứ sàn đã làm.
- **Thừa nhận:** fallback không bao giờ cho user tệ hơn mức họ tự ký là chấp nhận được. Thị trường thuận lợi → cho giá thị trường; xấu dưới sàn → revert, user giữ token. Không kịch bản nào fallback làm user thiệt hơn sàn của chính họ.

**Chỗ code:**
- Sàn chặn fallback: `FallbackExecutor.sol:111-113` (`signedFloor`, `"below signed min output"`) → `:117` `recordFallbackOutput` → `PartialFillReactor.sol:240` (`"min output total"`).
- Fallback chỉ chạy sát deadline: `FallbackExecutor.sol:16` (`FALLBACK_WINDOW = 10`), `:81-82` (`"order expired"` + `"too early"`).
- Hủy lệnh: `PartialFillReactor.sol:275-280` (`cancelOrder`), `:265-267` (`invalidateNonce`); kiểm khi khớp `:122-126`, `:294-297`.

**Chốt câu:**
> "User đã bỏ qua fallback được rồi: đặt sàn đủ chặt thì fallback không đạt sàn sẽ revert và lệnh hết hạn, user giữ token; hoặc hủy lệnh nếu đổi ý. Sàn đã ký chính là núm điều khiển đó. Một cờ skip riêng vừa trùng lặp với sàn, vừa tái sinh đúng bài toán treo lệnh mà fallback sinh ra để giải — nên em diễn đạt nó qua tham số đã có thay vì thêm cơ chế và bề mặt tấn công mới."

---

## 7. "Vai trò Permit2 là gì, sao dùng nhiều thế, bị hack thì sao?"

**Chốt:** Permit2 là lớp cấp quyền trung gian cho phép user approve **một lần** mà phủ mọi lần kéo token sau này → lệnh tạo gasless, tài sản nằm trong ví tới đúng lúc khớp. An toàn hơn approve max truyền thống. Hệ dùng **AllowanceTransfer** (hạn mức có số lượng + có hạn dùng), không phải witness signature.

**Vai trò cụ thể:**
1. User `ERC20.approve(Permit2, max)` — một lần duy nhất mỗi token.
2. Mỗi lần dùng: `Permit2.approve(spender, amount, expiration)` — hạn mức giới hạn số lượng + hạn thời gian.
3. Contract kéo qua `permit2.transferFrom(swapper, đích, amount, token)`.

**Sao dùng nhiều:** mọi nơi cần kéo input token của user đúng lúc thực thi đều dùng — vì user tạo lệnh gasless (ký off-chain), việc kéo token xảy ra muộn khi filler thực thi. Permit2 cho một lần approve phủ mọi lần kéo, user không phải gửi token trước, không phải approve riêng từng contract.

**An toàn hơn approve thường:** `approve(protocol, max)` = hạn mức vô hạn đứng mãi cho contract ít audit của bạn. Permit2 = standing approval chỉ cấp cho **một contract bất biến đã audit kỹ**, hạn mức từng spender thì có số lượng + tự hết hạn → giảm bề mặt tấn công.

**Nếu Permit2 bị hack (nhiều lớp):**
1. **Bất biến — không admin, không upgrade.** Không khóa vận hành để chiếm; "hack" = tìm bug trong bytecode bất biến đã audit nhiều lần.
2. **Battle-tested toàn hệ sinh thái** (Uniswap, UniswapX, vô số protocol) → rủi ro chung của cả DeFi, không phải lỗi riêng NeutronX.
3. **Phơi nhiễm giới hạn được:** user thu hồi `approve(permit2, 0)` bất cứ lúc nào; hạn mức từng spender tự hết hạn theo `expiration`.
4. **Thay thế tệ hơn:** tự viết approval riêng dễ lỗi hơn nhiều so với tái dùng primitive đã vet rộng.
5. **Thừa nhận:** đúng là phụ thuộc bên ngoài — nhưng với prototype, tái dùng primitive đã vet kỹ là lựa chọn có trách nhiệm.

**Chỗ code:**
- Kéo input cùng chuỗi: `PartialFillReactor.sol:175`.
- Kéo input fallback: `FallbackExecutor.sol:93`.
- Xuyên chuỗi (chuyển input vào escrow clone): `EscrowSrcFactory.sol:300`; luồng approve một lần mô tả ở `EscrowSrcFactory.sol:19-29`; tài sản nằm trong ví tới lúc khớp `EscrowSrc.sol:13-14`.

**Chốt câu:**
> "Permit2 cho phép user approve một lần mà phủ mọi lần kéo token sau này, để lệnh tạo gasless và tài sản nằm trong ví tới đúng lúc khớp. Nó an toàn hơn approve max truyền thống vì hạn mức từng bên có số lượng và hạn dùng. Nếu Permit2 bị hack thì đó là sự kiện toàn hệ sinh thái — nó bất biến, không admin, đã audit nhiều lần; em chọn tin một primitive được vet kỹ thay vì tự viết approval dễ lỗi hơn. User cũng thu hồi approval bất cứ lúc nào."

---

## 8. "Ký startPrice/decayPerBlock/feeTier vào lệnh — tác dụng cụ thể là gì?"

**Chốt:** Sàn `minOutputAmount` chỉ chặn ĐÁY, không bảo vệ GIÁ. Nếu không ký đường cong, filler ép user xuống **đúng bằng sàn mọi lần** mà vẫn qua kiểm tra sàn → nuốt mất phần thưởng đấu giá. Ký đường cong = thứ biến "sàn" từ GIÁ thành SÀN. (3 trường chống **2 tấn công khác nhau**.)

**Tấn công 1 — ép giá về sàn (startPrice / decayPerBlock):**
- Giá user nhận = `currentPrice = startPrice − blocksPassed × decayPerBlock`, `output = fillAmount × currentPrice / 1e18`.
- Ví dụ: bán 1 WETH, thị trường 3850. Đường cong ký: `startPrice=3927`, decay≈1,16/block về sàn `minOutput=3811` trong 100 block.
  - Filler trung thực ở block 10: `price = 3927 − 10×1,16 = 3915` → user nhận **3915**.
  - Nếu KHÔNG ký: filler tự đặt `startPrice=3811, decayPerBlock=0` → user nhận đúng **3811**, filler nuốt **104 USDC**. **Vẫn hợp lệ** vì sàn `3811 ≥ 3811` đạt! Sàn không bắt được vì ép xuống *đúng* sàn, không *dưới* sàn.
- → Ký đường cong buộc filler chạy đúng đường giảm giá công bằng → user thật sự nhận phần thưởng đấu giá (giá cao lúc đầu).

**Tấn công 2 — làm rẻ cọc (feeTier):**
- `feeTier` chọn pool Uniswap V3 làm oracle tính cọc filler (`DynamicStakeLib.sol:70` `getPool(inputToken, weth, feeTier)` → TWAP → ETH notional → số cọc).
- Filler tự chọn `feeTier` → trỏ pool mỏng/dễ thao túng → TWAP báo ETH-notional thấp → **cọc nhỏ đi** → under-collateralize, răn đe slashing yếu. Ký `feeTier` cố định pool tham chiếu chuẩn (gắn Trufy 3.5 — gia cố TWAP).

**Vì sao "cosigner xác thực" mới đủ:** lệnh có **hai chữ ký** — user (cho phép swap) + cosigner (xác nhận tham số hợp lý: startPrice≈thị trường+2%, giảm tới sàn đúng hạn, feeTier trỏ pool đủ thanh khoản). Cả 3 trường ở trong **typehash đã ký** (`PartialFillReactor.sol:53`). Đổi bất kỳ giá trị nào → **cả hai chữ ký vô hiệu** → revert ngay ở bước verify. Filler buộc chạy đúng đường cong đã xác thực.

**Chỗ code:**
- 3 trường trong typehash: `PartialFillReactor.sol:53` (và `FallbackExecutor.sol:25`).
- Tính giá theo đường cong: `PartialFillReactor.sol:160-167`, `DecayCursorLib.sol:23-31`.
- feeTier → oracle cọc: `PartialFillReactor.sol:111` → `FillAuction.sol:162-199` → `DynamicStakeLib.sol:70`.

**Chốt câu:**
> "Sàn chỉ chặn đáy, không bảo vệ giá. Không ký đường cong thì filler tự đặt startPrice thấp / decay nhanh để ép user xuống đúng bằng sàn mọi lần — vẫn qua kiểm tra sàn nhưng nuốt mất phần thưởng đấu giá. Đưa startPrice/decayPerBlock vào dữ liệu ký, được cả user và cosigner xác thực, buộc filler chạy đúng đường giảm giá công bằng. feeTier cũng ký để filler không trỏ oracle vào pool dễ thao túng nhằm làm rẻ cọc."

---

## 9. "Công thức P(b) = max(0, P₀ − (b−b₀)·d) — block là gì, sao không tự nặn được, sao tính thế?"

**Block là gì:** `block.number` = số thứ tự block hiện tại, tăng đều, **mọi node thấy cùng giá trị** khi chạy một tx (~12s/block trên Ethereum). Là **đồng hồ chung chống giả mạo** — cách contract "biết thời gian" (EVM không có đồng hồ thật).
- `b` = block lúc khớp; `b₀` = `lastResetBlock` = block khởi tạo/reset đường cong gần nhất (mỗi chunk re-anchor); `b−b₀` = số block trôi qua = "thời gian" đấu giá.

**Vì sao công thức thế (đấu giá Hà Lan tuyến tính):**
| Thành phần | Nghĩa | Code |
|---|---|---|
| `(b−b₀)` | block trôi qua | `blocksPassed = block.number − lastResetBlock` |
| `(b−b₀)·d` | tổng giảm tới giờ | `decayed = blocksPassed × decayPerBlock` |
| `P₀ − ...` | giá hiện tại | `return currentStartPrice − decayed` |
| `max(0,...)` | không cho âm | `if (decayed >= startPrice) return 0` |

- **`max(0,...)` hai mục đích:** (a) giá không âm; (b) **chống underflow** `uint` — nếu `decayed > P₀` thì `P₀ − decayed` tràn ngược.
- **Tuyến tính:** rẻ gas (1 nhân + 1 trừ), deterministic, dễ đặt tham số để chạm sàn đúng deadline, dễ kiểm chứng tay.
- **Giảm giá (Hà Lan):** bắt đầu cao hơn thị trường → giảm tới khi filler thấy có lãi → dò giá không cần sổ lệnh; cạnh tranh đẩy filler khớp sớm (tốt cho user).

**⚠ Sao "không tự nặn" — câu chữ báo cáo cũ tựa SAI cột (đã sửa trong Chương 3):**
Lý do thật dựa trên **HAI cột**, báo cáo cũ chỉ nêu một:
1. **`b` = block.number do CHUỖI cấp** — không ai nhét số giả (cột báo cáo cũ nêu).
2. **`P₀, d, b₀` khóa bằng chữ ký** (typehash, Mục 8) — **cột chính, báo cáo cũ thiếu.** Không có nó thì block.number công khai vô dụng: filler đặt `startPrice=sàn` là ép user về sàn (104 USDC ở Mục 8).
- **Nuance:** filler (nếu kiêm proposer) chọn được **thời điểm** khớp → giá nào. Nhưng chỉ trong block thật/tuần tự; chờ muộn → giá thấp hơn nhưng **bị sàn chặn** (`test_lateFill_skimsDecaySpread`, `test_lateFill_belowFloor_reverts`). MEV còn lại bounded.

**Chỗ code:** `DecayCursorLib.sol:23-31` (getCurrentPrice), `PartialFillReactor.sol:160-167` (áp giá vào output), `:53` (3 trường trong typehash).

**Chốt câu:**
> "Giá an toàn nhờ hai thứ: `b` là block.number do chuỗi cấp nên không ai nhét số giả, VÀ `P₀, d, b₀` nằm trong dữ liệu ký nên filler không sửa được. Filler chỉ chọn được thời điểm khớp trong các block thật — chờ muộn thì giá thấp hơn nhưng luôn bị sàn đã ký chặn đáy. Công thức tuyến tính vì rẻ gas, deterministic và dễ đặt tham số để chạm sàn đúng deadline; max(0,…) vừa chặn giá âm vừa chống underflow."

---

## 10. FillAuction — slash, cơ chế toán học, bảng tham số, hiệu chỉnh

### 10a. Hàm `slash` — "ai cũng gọi được à?"

**Chốt:** Đúng, permissionless — cố ý, pattern keeper giống thanh lý DeFi. Nhưng chỉ THÀNH CÔNG khi filler thật sự bỏ dở.
- Cọc chia: **10% người gọi (bounty), 90% treasury** (`FillAuction.sol:247-251`).
- 6 chốt `require` đọc từ state có thẩm quyền, người gọi không bẻ được: có đăng ký thật; chưa tất toán/slash/release; **sau hạn + SLASH_WINDOW**; **không bị hủy** (H-2); **không bị vô hiệu nonce** (3.3); **vẫn còn phần chưa khớp** (H-1). (`FillAuction.sol:234-243`)
- Vì sao permissionless: không phụ thuộc một bên tập trung phải online; thưởng 10% trả công gas cho người thực thi. Filler trung thực không bao giờ bị slash (test H-1, H-2, slash_revert_tooEarly).

### 10b. Ba công thức

**Cọc lúc đăng ký** (`computeCollateral`, `DynamicStakeLib.sol:125-140`):
```
C = N_eth × (r[s] / 10000) × (m[t] / 10000)
```
- `N_eth` = giá trị lệnh quy ETH (qua TWAP); `s` = bucket cỡ (`<1,1-10,10-100,>100` ETH); `r[s]` = tỉ lệ cọc bps (owner đặt); `t` = bucket thời gian còn lại (`>50,>20,>5,≤5` block); `m[t]` = hệ số `1/1.5/3/5x` (10000/15000/30000/50000). Cộng sàn `minCollateral` (Trufy 3.1).
- Ví dụ: lệnh 5 ETH, `>50` block, `r=500` → `C = 5×0.05×1 = 0.25 ETH`. Sát hạn (3 block, m=5x) → `1.25 ETH` (gấp 5).
- Tuyến tính theo notional (không chiều fill-ratio) → chống ceiling-shopping.

**Notional qua TWAP** (`toEthNotional`, `:59-85`): tick trung bình qua cửa sổ W giây → giá trung bình hình học, kháng thao túng 1 block. WETH→1:1; `factory==0`→tắt oracle.

**Hoàn cọc** (`computeRefund`, `:152-161`):
```
R = S × (rho[b] / 10000),   b = bucket(fill_thực / cam_kết)
```
- `b`: `0-2/2-10/10-30/30-70/70-100%`. Tỉ lệ so với **cam kết của CHÍNH filler** (D-2): giao đủ → 100% bất kể cỡ; thiếu → phần còn lại sung treasury. Bảng chốt vào Registration lúc đăng ký (M-2).

### 10c. Vì sao chia 10^4

Solidity **không có số thực** → dùng dấu phẩy tĩnh. `10000 = basis points` (1 bps = 0.01%): `r=500`→5%, `m=15000`→1.5x. Chia 10^4 để tháo scale; **chia 2 lần** vì 2 thừa số (`r` và `m`).
- **Nhân TRƯỚC chia SAU** (`mulDiv`): chia số nguyên làm tròn xuống → chia trước thì `500/10000 = 0` → cọc = 0 (hỏng). `FullMath.mulDiv` dùng trung gian 512-bit nên không tràn.
- Chọn 10^4 vì bps là chuẩn DeFi, granularity 0.01% (10^2 quá thô, 10^18 thừa).

### 10d. Vì sao bảng như vậy — KHÔNG cảm tính (suy từ mục đích)

Cọc để **răn đe bỏ dở** → `cọc ≥ lợi/thiệt hại của việc bỏ chạy`. Ví như **tiền cọc thuê đồ**, mỗi chiều bảng = một chiều rủi ro:

| Chiều bảng | Rủi ro thật | Hình dạng bị ép ra |
|---|---|---|
| notional | giá trị-bỏ-chạy (đồ đắt → cọc lớn) | cọc **tỉ lệ thuận** |
| thời gian còn lại | **thiệt hại nếu bỏ dở** = khả năng cứu vãn (hủy phút chót hại hơn) | hệ số **lồi tăng** khi sát hạn (cứu vãn sụp phi tuyến) |
| tỉ lệ giao/cam kết | mức giữ lời (trả đồ nguyên vẹn → lấy lại cọc) | hoàn cọc **tăng theo** |

→ Hình dạng (thuận/lồi/tăng) **bắt buộc**; chỉ **độ dốc cụ thể** (`50/20/5`, `5x`...) là calibration.

### 10e. Hiệu chỉnh: code, độ khó, dữ liệu

**Về code — 2 mức:**
- **Độ lớn (hot):** owner gọi `setCollateralRate(sBucket,value)` / `setRefundTable(sBucket,rBucket,value)` (`FillAuction.sol:144-154`) — ghi đè 1 ô bps, tức thời, không redeploy.
- **Cấu trúc bucket (cold):** ranh giới `1/10/100` ETH, `2/10/30/70%`, `50/20/5` block, hệ số `1/1.5/3/5x` **hardcode** trong DynamicStakeLib → sửa phải **redeploy + di trú state**.

**Tại sao khó:** không khó ở việc ghi, mà ở **biết đặt giá trị nào** — là điểm cân bằng trong trò chơi với filler:
```
rate quá CAO  → khóa vốn đắt → không ai đăng ký → mất thanh khoản
rate quá THẤP → răn đe vô dụng → filler bỏ dở thoải mái
```
Là **vòng phản hồi**: đổi rate → filler thích nghi → quan sát lại → chỉnh tiếp. Cần lặp với người chơi thật theo thời gian.

**Dữ liệu thật cần:** tỉ lệ bỏ dở theo từng mức rate; độ phủ filler theo rate; biến động giá từng cặp token; chi phí vốn filler; thời gian cứu vãn thực (hiệu chỉnh `50/20/5`); thiệt hại user mỗi lần bỏ dở (hiệu chỉnh `1/1.5/3/5`). → Chỉ có khi chạy **mainnet, filler thật, khối lượng thật, qua thời gian** — Anvil local 2 filler demo không sinh ra được → hướng phát triển.

**Điểm yếu thừa nhận:** bucketing tạo **vách nhảy** ở ranh giới (9.99 vs 10.01 ETH); cấu trúc bucket phải redeploy mới đổi; chưa calibrate bằng dữ liệu thật; bucket thời gian đếm block nên phụ thuộc chain; hệ số thời gian phạt cả filler muộn-nhưng-trung-thực (công cụ cùn).

**Chốt câu (10d+10e):**
> "Hình dạng bảng suy từ mục đích răn đe: cọc tỉ lệ giá trị lệnh, lồi tăng khi sát hạn vì bỏ dở muộn khó cứu vãn hơn, hoàn cọc theo tỉ lệ giữ lời — ba chiều ánh xạ ba chiều rủi ro nên không cảm tính. Chỉ độ dốc cụ thể là tham số: owner chỉnh độ lớn qua setter tức thời, còn cấu trúc bucket hardcode phải redeploy. Khó ở chỗ biết đặt giá trị nào — đó là điểm cân bằng cần dữ liệu thật (tỉ lệ bỏ dở, độ phủ filler, biến động giá, chi phí vốn) chỉ có khi chạy mainnet, nên đồ án local để mở."

---

## 11. "Bridge giữ tài sản nên dễ bị tấn công — escrow của anh khác gì?"

**Chốt:** Bridge **gom tài sản mọi người vào một honeypot** và đúc token dựa trên **chứng thực validator** → phá một cổng = vét tất cả. NeutronX **không gom, không đúc**: mỗi slot một escrow riêng, liên kết hai chuỗi bằng **hashlock mật mã** (không có validator để chiếm, không message để giả).

**Tấn công bridge là gì / mục đích:**
- Cơ chế lock-and-mint: user khóa tài sản chuỗi 1 → validator chứng thực "đã khóa" → đúc token bọc chuỗi 2. Hợp đồng bridge gom tài sản TẤT CẢ user = **honeypot**.
- Tính chất an toàn cốt lõi: chỉ đúc/mở khóa khi có **chứng thực hợp lệ** (validator/multisig hoặc mã verify).
- **Tấn công = phá cổng chứng thực:** Ronin (625tr$, chiếm 5/9 khóa validator), Wormhole (325tr$, giả message deposit → đúc 120k wETH từ hư không), Nomad (190tr$, lỗi init khiến mọi message hợp lệ).
- **Mục đích:** vét cạn quỹ gom. **Cơ chế:** một cổng chứng thực kiểm soát một kho khổng lồ → phá một lần = lấy tất cả.

**Vì sao escrow khó hơn (đối chiếu):**
1. **Không honeypot** — mỗi `EscrowSrc` (clone CREATE2) giữ đúng 1 slot của 1 lệnh. Phá 1 escrow = 1 slot của 1 người, không phải tiền tất cả.
2. **Không chứng thực tin cậy để giả** — liên kết là hashlock: mở chỉ cho ai trình `S_i` sao cho `keccak256(S_i)==h_i`. An toàn quy về **kháng tiền ảnh keccak256**, không phải "validator có trung thực không".
3. **Không giữ tài sản đứng yên** — Permit2 giữ input trong ví tới đúng lúc khớp; escrow chỉ giữ tạm.
4. **Timelock cứu hộ** — hỏng đâu thì sau T1 user `cancel()` lấy lại. Xấu nhất = tiền về user, không mất.

**Tấn công vào NeutronX & vì sao fail:**
| Muốn | Bị chặn |
|---|---|
| Rút EscrowSrc không trả chân đích | cần `S_i`, secret chỉ lộ khi chân đích đã claim (đã trả user) — không bữa trưa miễn phí |
| Khớp bằng hashlock tự biết secret | leaf `(h_i,i)` phải thuộc cây Merkle đã ký, verify trước khi kéo tiền (`EscrowSrcFactory.sol:286-287`) |
| T2 ≥ T1 (claim đích, để nguồn hết hạn, hủy lấy lại) | watcher từ chối lộ secret khi `dstExpiry > t2` đã duyệt |
| Chiếm cosigner | có tham số + relay, không giữ tài sản; user cứu qua timelock → mất liveness, không mất tiền |

**Thừa nhận:** không an toàn hơn mọi mặt — **đổi** rủi ro honeypot lấy **phức tạp mỗi lệnh + liveness yếu hơn** (chậm, cần watcher); cũng không tổng quát như bridge (chỉ swap, không chuyển message tùy ý). Điểm mạnh cốt lõi: **bỏ được kho honeypot tập trung**.

**Chốt câu:**
> "Bridge gom tài sản mọi người vào một hợp đồng và đúc token dựa trên chứng thực validator, nên phá một lần cái cổng đó — giả message hoặc chiếm khóa — là vét cả kho; Ronin, Wormhole, Nomad mất hàng trăm triệu kiểu vậy. Đồ án em không gom, không đúc: mỗi slot một escrow giữ đúng phần của nó, liên kết hai chuỗi là hashlock mật mã nên không có validator để chiếm hay message để giả. Tài sản không nằm đứng yên nhờ Permit2, hỏng thì sau timelock user tự lấy lại. Đổi lại em chịu phức tạp và độ trễ cao hơn — nhưng bỏ được honeypot là điểm an toàn cốt lõi."

---

## 12. FallbackExecutor — generic router, routeCalldata & vì sao không tự route

### 12a. Vì sao aggregator có "định dạng dữ liệu riêng"
Mỗi aggregator là **một hợp đồng router khác nhau, hàm khác nhau, mã hóa calldata khác nhau**: Uniswap dùng `exactInput(...)`, KyberSwap router khác với hàm `swap(...)` riêng, 1inch lại kiểu khác. "Đường đi" (pool nào, chia ra sao) do **API off-chain của từng aggregator** tính rồi trả về **blob calldata mã hóa sẵn** cho router của nó. **Không có chuẩn chung.**

### 12b. FallbackExecutor code kiểu gì mà dùng được cho mọi aggregator
Mẫu **"router + calldata mù"**. Backend đưa vào `executeFallback(order, router, routeCalldata, minAmountOut)` (`FallbackExecutor.sol:67-72`):
```solidity
require(allowedRouters[router], "router not allowed");          // :73  whitelist
permit2.transferFrom(swapper, address(this), rem, inputToken);  // :93  kéo input
inputToken.forceApprove(router, rem);                           // :101
uint256 balBefore = outputToken.balanceOf(swapper);             // :103
(bool ok,) = router.call(routeCalldata);                        // :105  ← GỌI MÙ, chuyển blob nguyên xi
uint256 amountOut = outputToken.balanceOf(swapper) - balBefore; // :108  đo KẾT QUẢ
```
**Mấu chốt: hợp đồng KHÔNG hiểu định dạng nào — chỉ chuyển tiếp blob rồi kiểm KẾT QUẢ**, không kiểm định dạng. An toàn nhờ 4 lớp thay cho "hiểu định dạng":
1. **Whitelist** (`:73`) — chỉ gọi router đã duyệt.
2. **Sàn balance-delta** (`:111-113`) — đo chênh số dư của *chính swapper*, bắt buộc `≥ signedFloor`, sai là revert. Route gửi output đi đâu khác → swapper không đủ sàn → revert.
3. **Xác thực lệnh** (cosigner sig, `:79`) trước khi động tiền.
4. **Hoàn input dư** (`:122-126`) — route exact-output tiêu ít hơn `rem` thì trả phần thừa.
→ Thêm aggregator mới = viết adapter backend + whitelist router, **không sửa hợp đồng**. Điểm tin cậy duy nhất: whitelist (owner chỉ thêm router chính thống).

### 12c. routeCalldata bản chất là gì
**Là CALLDATA (payload), KHÔNG phải transaction.** Transaction là phong bì `{from,to,value,gas,nonce,data,chữ ký}`; routeCalldata chỉ là **trường `data`** = `[4B selector] ++ [tham số ABI-encode]`. Ở tầng EVM không có "hàm", chỉ có **gửi byte tới một địa chỉ**; bên nhận tự giải mã (4 byte đầu = selector định danh hàm).
- Aggregator API trả về **cặp (to=router, data=routeCalldata)** — backend dùng `iface.encodeFunctionData(...)` dựng blob.
- Swap thường: **user** gửi tx `to=router, data=routeCalldata`. Fallback: **hợp đồng** chạy `router.call(routeCalldata)` — cùng payload, nhưng gọi hợp đồng-tới-hợp đồng, router tách riêng làm tham số.

### 12d. Ví dụ route được encode như nào (Uniswap V3 `exactInput`)
`path` là **byte đóng gói**: `token0(20B) ++ fee0(3B) ++ token1(20B) ++ fee1(3B) ++ token2(20B) ++ ...`. Route USDC →(0.3%) WETH →(0.3%) DAI:
```
a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48   USDC (20B)
000bb8                                     3000 = 0.3% (3B)
c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2   WETH (20B)
000bb8                                     3000 (3B)
6b175474e89094c44da98b954eedeac495271d0f   DAI  (20B)
```
= 66 byte nối liền. Router đọc tuần tự suy ra chuỗi pool. **Cả đường đa hop nằm gọn trong byte này.** (`fee` = uint24/3B: 3000→000bb8, 500→0001f4.)
- **Nhiều hop** = một path nhiều đoạn nối tiếp.
- **Chia nhánh song song (split)** = danh sách nhiều lệnh swap trong một calldata (vd UniversalRouter: `commands` + `inputs[]`, mỗi lệnh một path + một phần khối lượng). 1inch có encoding riêng (pool + trọng số) nhưng ý tưởng y hệt.

### 12e. "Sao filler không tự route / sao chỉ là demo?" — delegate cho aggregator
**Alpha Router (Smart Order Routing) gần như không đánh bại bằng tay** vì nó giải bài tối ưu trên toàn bản đồ thanh khoản:
- Tìm đường đồ thị đa hop trên mọi pool (V2/V3/V4).
- **Tối ưu chia nhỏ** — price impact lồi theo khối lượng, chia 60/40 qua nhiều pool giảm tổng trượt giá; tay mơ một đường ăn trọn impact → thua ngay.
- Cân gas (tối ưu output *ròng* sau gas).
- State thời gian thực hàng nghìn pool + cả team Uniswap duy trì.

→ Muốn bằng = dựng lại Alpha Router (việc của cả đội). Nên thiết kế đồ án **delegate routing cho aggregator** (FallbackExecutor gọi router bằng calldata, không tự route) và **scope chiến lược filler ra ngoài** (Chương 1.2.2). Đây là giá trị intent-based: cạnh tranh giữa filler (đứa routing/thanh khoản tốt hơn) lo giá tốt cho user.

**Chốt câu (12e — narrative mạnh nhất):**
> "Em từng thử cho filler tự trade qua nhiều DEX và không bằng Alpha Router của Uniswap — routing tối ưu là bài toán chia nhỏ giảm price impact, cộng tìm đường đa hop và cân gas, cần index toàn bộ pool và cả một team duy trì. Nên em chủ động delegate routing cho aggregator qua calldata thay vì tự làm, và scope chiến lược filler ra ngoài: kiến trúc intent để chính sự cạnh tranh giữa các filler lo việc đó cho người dùng."

**Chốt câu (12a-d — kỹ thuật):**
> "Mỗi aggregator là router riêng với mã hóa calldata riêng, không chuẩn chung. Em không nhúng định dạng nào vào hợp đồng — backend tính sẵn (router, calldata mù), hợp đồng kiểm whitelist rồi `call` chuyển tiếp nguyên khối. routeCalldata bản chất là trường data của lời gọi: 4 byte selector + tham số mã hóa, ví dụ path V3 đóng gói token+phí+token thành 66 byte. An toàn dựa vào KẾT QUẢ — đo chênh số dư output của user ≥ sàn đã ký — không dựa vào hiểu định dạng. Nhờ vậy thêm aggregator chỉ cần adapter backend + whitelist, không sửa hợp đồng."

---

## 13. "Register vs remaining — filler đăng ký chồng nhau, khi nào remaining mới trừ?"

**Chốt:** `register` **không** trừ `_remaining` → filler đăng ký chồng nhau, tổng vượt cả order vẫn được (over-subscription) — đây là **mô hình đua (race)**. `_remaining` chỉ giảm khi **thực sự khớp** trong `executePartialChunk`, ở bước Effects **ngay trước** khi chuyển tiền (CEI), không phải sau khi tiền về ví.

**Register không đụng remaining:**
- `register(order, fillAmount)` (`PartialFillReactor.sol:101-110`) chỉ chuyển yêu cầu cọc sang FillAuction, **không sửa `_remaining`**.
- Chặn lúc đăng ký: `fillAmount <= orderTotal` (FillAuction.register). Không có "kho chung" bị trừ.
- → Đăng ký chỉ là "giấy phép + cọc để cạnh tranh"; nhiều filler đăng ký chồng nhau hợp lệ.

**Remaining trừ lúc fill, theo CEI:**
```solidity
require(fillAmount <= currentRemaining, "fill > remaining");  // :141 CHECK
uint256 newRemaining = currentRemaining - fillAmount;         // :149 EFFECT
_remaining[orderHash] = ... pack(newRemaining);               // :150-152 ghi state
permit2.transferFrom(swapper, msg.sender, fillAmount, ...);   // :175 INTERACTION (tiền chuyển)
```
→ Trừ ở `:149-152`, **trước** transfer `:175`. Trừ trước để một cuộc gọi reentrancy không tiêu cùng `remaining` hai lần.

**Vì sao over-subscription vẫn an toàn:** `_remaining` là **nguồn sự thật duy nhất** chặn over-fill. 3 filler đều đăng ký 100% cùng gọi execute:
- Filler đầu: remaining 100% → fill → về 0.
- Filler 2,3: `require(fillAmount <= currentRemaining)` với remaining=0 → **revert** (hoặc chỉ fill phần dư).
→ Order không bao giờ bị fill quá. Filler thua đua (remaining đã 0) **không bị slash** — lấy lại đủ cọc (H-1, `test_H1_loserReclaimsStake`).

**Chốt câu:**
> "Đăng ký không trừ remaining nên filler đăng ký chồng nhau thoải mái, mỗi cái không vượt tổng order — đây là mô hình đua. `_remaining` chỉ giảm khi thực sự khớp trong executePartialChunk, ở bước Effects ngay trước khi Permit2 chuyển tiền theo CEI chống reentrancy, không phải sau khi tiền về ví. `_remaining` là cổng duy nhất chặn fill quá: kẻ đến sau bị 'fill > remaining' chặn, filler thua đua lấy lại cọc chứ không bị phạt."

---

## 14. "Fallback và khớp thường loại trừ lẫn nhau — cụ thể bằng cơ chế gì?"

**Chốt:** Phần có thể bị xử lý hai lần = **input chưa khớp `rem` của user**. Chặn bằng **HAI chốt độc lập**, đặt **nguyên tử và TRƯỚC khi gọi sàn ngoài** (đó mới là điểm an toàn thật).

**markFallbackInitiated làm 2 việc nguyên tử** (`PartialFillReactor.sol:224-229`):
```solidity
_fallbackInitiated[orderHash] = true;                // :227  bật CỜ
_remaining[orderHash] = RemainingLib.fullyFilled();  // :228  remaining về 0
```

**executePartialChunk bị chặn bởi 2 chốt độc lập** (chốt nào cũng đủ — defense-in-depth):
```solidity
require(!_fallbackInitiated[orderHash], "fallback initiated");  // :123  CHỐT 1 (cờ)
require(fillAmount <= currentRemaining, "fill > remaining");    // :141  CHỐT 2 (remaining=0)
```

**Điểm an toàn thật (thường bị giấu):** trong `executeFallback`, `markFallbackInitiated` (`FallbackExecutor.sol:89`) chạy **TRƯỚC** `router.call(routeCalldata)` (`:105`), cả hàm `nonReentrant`.
- Nếu zero remaining **sau** swap ngoài → cửa sổ reentrancy của lời gọi ngoài là khe để filler chen `executePartialChunk` rút cùng `rem`.
- Khóa cờ + remaining **trước** lời gọi (+ nonReentrant) → bịt khe đó. Đây là lý do "cùng một bước" quan trọng.

**Vì sao là double-spend nếu không chặn:** nếu cả fallback (swap `rem` qua aggregator) lẫn một filler `executePartialChunk` cùng xử lý `rem` → **input của user bị kéo hai lần** → mất tiền/insolvency.

**Chốt câu:**
> "Phần có thể bị xử lý hai lần là input chưa khớp của user. FallbackExecutor gọi markFallbackInitiated làm hai việc nguyên tử — bật cờ `_fallbackInitiated` và đưa remaining về 0 — và làm việc đó TRƯỚC khi gọi swap sang sàn ngoài, dưới nonReentrant. Sau đó mọi executePartialChunk revert vì hoặc cờ đã bật hoặc remaining=0, hai chốt độc lập. Vì khóa đặt trước lời gọi ngoài nên không có khe reentrancy để filler chen vào rút cùng phần đó — đó là cách hai luồng loại trừ lẫn nhau trên cùng biến remaining."

---

## 15. "Vì sao lá Merkle phải băm hai lần?"

**Chốt:** Chuẩn OpenZeppelin chống **second-preimage attack** (nhầm lá với nút trong). Băm kép ép tiền ảnh của lá đúng **32 byte**, khác hẳn **64 byte** của nút trong → lá và nút không lẫn được.

**Vấn đề nếu băm 1 lần:** nút trong = `H(con_trái ‖ con_phải)` = băm của **64 byte**. Verify proof **không phân biệt** lá hay nút — chỉ băm cặp dần lên gốc. Nên một nút trong `N = H(L1‖L2)` có **tiền ảnh biết sẵn** là `L1‖L2`. Kẻ tấn công trình `leafData = L1‖L2`, claim `H(L1‖L2)=N` là một **lá hợp lệ** → giả được proof thành viên cho một `(hashlock, slotIndex)` chưa từng là lá thật.
- Trong hệ này = thảm họa: kẻ tấn công nhét **hashlock nó biết secret** vào cây → qua check Merkle ở `fillSlot` → **rút tài sản nguồn của user** mà không trả chân đích.

**Băm 2 lần khóa được:** `leaf = keccak256(keccak256(abi.encode(h_i, i)))` (`EscrowSrcFactory.sol:286`).
- Lá = `keccak256` của **32 byte** (output băm trong).
- Nút trong = `keccak256` của **64 byte**.
- → Phân tách miền theo độ dài tiền ảnh. Muốn giả nút trong thành lá cần tiền ảnh 32 byte băm ra `N`, nhưng cái duy nhất biết là `L1‖L2` = 64 byte → sai độ dài → không thay được.

**Chốt câu:**
> "Băm hai lần là chuẩn OpenZeppelin chống second-preimage attack. Nút trong là băm của 64 byte (hai hash con ghép), nên nếu lá chỉ băm một lần thì một nút trong có thể bị trình ngược như một lá — kẻ tấn công dùng chính 64 byte hai con làm dữ liệu lá để giả proof. Băm lá hai lần ép tiền ảnh lá đúng 32 byte, khác 64 byte của nút, nên không lẫn. Thiếu nó, một filler có thể nhét hashlock mình biết secret vào cây, qua check Merkle ở fillSlot rồi rút tài sản nguồn của user."

---

## Nhắc cuối

- 3 "hố" nguy hiểm nhất nếu đào sâu: **atomicity không proof**, **cosigner tập trung**, **đo MEV**. Cả ba đều thắng bằng cách thừa nhận đúng + chuyển thành "thiết kế có chủ đích / hướng phát triển".
- Ranh giới vàng: **mất liveness ≠ mất tiền**. Lặp lại motif này ở cosigner, xuyên chuỗi, UX.
- Đừng bịa proof, đừng bịa con số, đừng nói sai về bridge thật.
