# Kịch bản Slide Bảo vệ Đồ án — NeutronX (DEX Aggregator Intent + Partial-Fill + Filler Permissionless)

> Mục tiêu: trình bày 10–15 phút. Mỗi slide gồm 3 phần:
> **[BỐ CỤC]** vẽ sẵn bằng text để biết đường dựng slide · **[NÓI]** lời thoại (đã chỉnh bớt kỹ thuật, nói như kể chuyện) · **[CHUYỂN]** câu nối sang slide sau.
>
> Ký hiệu nhân vật xuyên suốt: **Swapper** = người muốn đổi token · **Filler** = người thực thi lệnh hộ (kiếm lời từ chênh lệch) · **Order/Lệnh** = ý định đổi token đã ký.
>
> Tổng: 16 slide chính + vài slide testcase + phụ lục. Canh ~12–13 phút, chừa ~2 phút hỏi đáp.

---

## SLIDE 1 — Trang bìa (~20 giây)

**[BỐ CỤC]**
```
┌─────────────────────────────────────────────┐
│         [LOGO TRƯỜNG]                        │
│                                              │
│   XÂY DỰNG DEX AGGREGATOR THEO MÔ HÌNH        │
│   INTENT VỚI CƠ CHẾ PARTIAL-FILL VÀ          │
│   FILLER KHÔNG CẦN CẤP PHÉP                   │
│              (NeutronX)                       │
│                                              │
│   SVTH: [Tên bạn] — MSSV: [...]              │
│   GVHD: [Tên thầy/cô]                         │
│                          Tháng .../2026       │
└─────────────────────────────────────────────┘
```

**[NÓI]** "Em xin trình bày đồ án tốt nghiệp: xây dựng một sàn đổi token hoạt động theo mô hình 'ý định' (intent), cho phép nhiều người cùng khớp một lệnh mà không ai phải xin phép trước."

**[CHUYỂN]** "Trước tiên em xin điểm qua nội dung trình bày."

---

## SLIDE 2 — Mục lục (~20 giây)

**[BỐ CỤC]**
```
NỘI DUNG TRÌNH BÀY

  1 ─ Bài toán
  2 ─ Mục tiêu đồ án
  3 ─ Thiết kế hệ thống        ◀ trọng tâm
  4 ─ Kiểm thử                 ◀ trọng tâm
  5 ─ Kết luận & Hướng phát triển
```

**[NÓI]** "Bài trình bày gồm 5 phần. Em sẽ đi nhanh phần bài toán và mục tiêu, rồi tập trung vào phần thiết kế và kiểm thử — đây là đóng góp chính của đồ án."

**[CHUYỂN]** "Bắt đầu từ câu hỏi: các sàn đổi token hiện nay hoạt động thế nào và bất tiện ở đâu."

---

## SLIDE 3 — Bài toán: từ AMM aggregator đến mô hình Intent (~1 phút 15)

**[BỐ CỤC]** — hai khối so sánh, mũi tên ở giữa
```
   AGGREGATOR TRUYỀN THỐNG          MÔ HÌNH INTENT
 ┌──────────────────┐         ┌──────────────────────────┐
 │ Swapper tự gửi    │        │ Swapper chỉ KÝ intent:    │
 │ giao dịch lên     │  ───▶  │ "đổi X, nhận tối thiểu Y" │
 │ các pool AMM      │        │                           │
 │ • tự chịu slippage │       │ • filler lo thực thi      │
 │ • dễ bị sandwich   │       │ • gasless (không trả gas) │
 │ • giao dịch có thể │       │ • được đảm bảo min output │
 │   fail vẫn mất gas │       │                           │
 └──────────────────┘         └──────────────────────────┘
    swapper gánh rủi ro            filler gánh rủi ro

   → Mô hình phổ biến hiện nay: 1 order chỉ 1 filler khớp trọn
```

**[NÓI]** "Aggregator truyền thống chỉ định tuyến qua các pool AMM: swapper tự gửi giao dịch và tự gánh mọi rủi ro — slippage, bị sandbox chèn lệnh ăn chênh, thậm chí giao dịch fail vẫn mất gas. Mô hình intent làm ngược lại: swapper chỉ ký một intent — 'đổi số token này, nhận về tối thiểu chừng này' — rồi để filler lo thực thi và gánh rủi ro, đổi lại swapper được đảm bảo mức output tối thiểu và không phải trả gas. Nhưng hầu hết hệ hiện nay, một order chỉ do đúng một filler khớp trọn."

**[CHUYỂN]** "Vậy các hệ đã có làm điều này tốt tới đâu, và còn thiếu gì?"

---

## SLIDE 4 — Khoảng trống & Mục tiêu đồ án (~1 phút 15)

**[BỐ CỤC]** — bảng so sánh + khung mục tiêu
```
             │ UniswapX   │ 1inch      │ CoW Swap
 ────────────┼────────────┼────────────┼───────────
 Khớp order  │ all-or-    │ partial    │ batch
             │ nothing    │ fill       │ (gộp lô)
 Filler      │ phải       │ permissio- │ phải thi
             │ onboard    │ ned/duyệt  │ tuyển
 Hệ quả      │ order to   │ rào cản    │ rào cản
             │ chờ lâu    │ filler cao │ filler cao

 ┌─────────────── MỤC TIÊU ĐỒ ÁN ───────────────┐
 │ • Order được khớp NHANH nhờ NHIỀU filler cùng │
 │   partial-fill                                │
 │ • Filler PERMISSIONLESS — ai cũng tham gia    │
 │   được, không cần whitelist                   │
 │ • Vẫn AN TOÀN dù mở cửa: chặn filler ôm order │
 │   rồi bỏ, chặn gian lận                        │
 └───────────────────────────────────────────────┘
```

**[NÓI]** "Ba hệ lớn nhất hiện nay. UniswapX theo kiểu all-or-nothing, nên một order lớn phải chờ một filler đủ sức ôm trọn. 1inch và CoW cho partial-fill hoặc gộp lô, nhưng filler bị permissioned — phải onboard, được duyệt mới tham gia được. Đồ án của em nhắm tới ba điều: order được nhiều filler cùng partial-fill cho nhanh; filler permissionless, ai cũng tham gia được không cần whitelist; và quan trọng là mở cửa nhưng vẫn an toàn, bằng cách bắt filler đặt stake thay vì phải xin duyệt."

**[CHUYỂN]** "Để làm được ba điều đó, hệ thống được thiết kế như sau."

---

## SLIDE 5 — Kiến trúc tổng thể (~1 phút)

**[BỐ CỤC]** — 4 tầng xếp dọc
```
 ┌── FRONTEND ─────────────────────────────────────┐
 │ Swapper ký order · Dashboard cho filler          │
 └───────────────────────┬─────────────────────────┘
 ┌── BACKEND ──────────────────────────────────────┐
 │ Orderbook (nơi gặp gỡ) · cosigner ký order ·     │
 │ watcher/indexer trạng thái · relayer (cross-chain)│
 └───────────────────────┬─────────────────────────┘
 ┌── SETTLEMENT LAYER (smart contract on-chain) ───┐
 │  ┌ Single-chain swap ┐   ┌ Cross-chain swap ┐    │
 │  └───────────────────┘   └──────────────────┘    │
 └───────────────────────┬─────────────────────────┘
 ┌── FILLER ───────────────────────────────────────┐
 │ Agent off-chain, bất kỳ ai chạy được             │
 └─────────────────────────────────────────────────┘
```

**[NÓI]** "Hệ thống có bốn phần. Frontend để swapper ký order và cho filler theo dõi qua dashboard. Backend làm orderbook — nơi gặp gỡ giữa order và filler — kèm cosigner ký xác thực đường giá của order, watcher theo dõi trạng thái on-chain, và relayer lo khâu claim ở cross-chain. Lưu ý phần định giá thật của collateral là một oracle on-chain nằm trong settlement layer, không phải backend. Settlement layer là phần lõi chạy on-chain bằng smart contract, chia hai nhánh — single-chain swap và cross-chain swap. Cuối cùng, filler là agent off-chain mà bất kỳ ai cũng chạy được. Em xin đi sâu vào settlement layer vì đó là đóng góp chính."

**[CHUYỂN]** "Trước hết là nhánh single-chain swap."

---

## SLIDE 6 — Single-chain swap: các contract (~1 phút)

**[BỐ CỤC]** — sơ đồ 4 hộp + vai trò
```
 ┌─ Reactor ───────────────┐   ┌─ FillAuction ───────────┐
 │ Giữ remaining của order, │  │ Giữ stake của filler     │
 │ khớp từng chunk, chuyển  │──│ Hoàn stake khi làm đúng  │
 │ token (qua Permit2)      │  │ Slash khi ôm rồi bỏ      │
 └──────────────────────────┘  └──────────────────────────┘
 ┌─ DynamicStakeLib ───────┐   ┌─ FallbackExecutor ───────┐
 │ Công thức tính stake &   │  │ Sát deadline chưa xong → │
 │ refund theo bảng bucket  │  │ route qua aggregator khác│
 └──────────────────────────┘  └──────────────────────────┘
```

**[NÓI]** "Nhánh này có bốn contract. Reactor giữ trạng thái order còn lại bao nhiêu, khớp từng chunk và chuyển token qua Permit2. FillAuction quản lý stake của filler — hoàn lại khi họ làm đúng, slash khi họ ôm order rồi bỏ. DynamicStakeLib là công thức quyết định stake bao nhiêu là hợp lý. Và FallbackExecutor là phương án cuối: nếu sát deadline mà order vẫn chưa khớp xong, nó tự route phần còn lại qua một aggregator khác để swapper vẫn nhận đủ. Điểm cốt lõi của tính permissionless nằm ở FillAuction và DynamicStakeLib."

**[CHUYỂN]** "Vậy làm sao mở cửa cho mọi filler mà vẫn không bị phá? Đây là cơ chế stake."

---

## SLIDE 7 — Cơ chế permissionless: DynamicStakeLib (~1 phút 30 — SLIDE QUAN TRỌNG)

**[BỐ CỤC]** — câu lõi + 3 bảng nhỏ + ô nhấn mạnh
```
 Không whitelist ai cả — thay bằng STAKE (đặt cọc).
 Muốn khớp thì phải stake. Ôm order rồi bỏ thì MẤT stake.

 stake = giá trị order × rate theo size × multiplier theo thời gian
                                            (có minCollateral làm sàn)

 Order size       rate         Thời gian còn lại   multiplier
 ────────         ─────        ─────────────────   ──────────
 nhỏ              thấp         còn nhiều            1×
 vừa              vừa          ít dần               1.5× → 3×
 lớn              cao          sắp hết              5×  (stake cao nhất)

 REFUND TABLE (hoàn stake theo % đã fill so với cam kết):
   fill <2%  → hoàn  5%      fill 30–70% → hoàn 50%
   fill <10% → hoàn 10%      fill ≥70%   → hoàn 100%
   fill <30% → hoàn 25%

 ┌────────────────────────────────────────────────┐
 │ Ngưỡng kinh tế (worst-case): chọn tham số sao   │
 │ cho MỌI kiểu "fill một tí rồi bỏ" đều LỖ.       │
 └────────────────────────────────────────────────┘
```

**[NÓI]** "Thay vì whitelist, filler nào muốn khớp chỉ cần stake. Stake cao hay thấp tính theo ba yếu tố: order giá trị bao nhiêu, còn bao nhiêu thời gian tới deadline, và có một mức sàn tối thiểu là minCollateral. Khi fill xong, stake được hoàn theo refund table: làm đúng cam kết thì lấy lại đủ; còn filler ôm order để chặn người khác rồi chỉ fill một tí thì bị tịch thu phần lớn stake, coi như 'phí sniping'. Điều quan trọng nhất: mọi con số này đều phải qua một ngưỡng kinh tế — đảm bảo không tồn tại cách nào để fill một tí rồi bỏ mà có lời. Nhờ vậy mở cửa cho tất cả filler mà vẫn an toàn."

*(Nếu dư giờ, thêm một câu: "Bảng stake này còn chỉnh được lúc runtime qua governance, nhưng phải qua cooldown và có guardian phủ quyết, để không ai lén nới lỏng luật.")*

**[CHUYỂN]** "Ghép lại, một lượt single-chain swap diễn ra như sau."

---

## SLIDE 7b — Ngưỡng kinh tế: cách tính worst-case (~50 giây) — TUỲ CHỌN / DỰ PHÒNG HỎI ĐÁP

> Mở rộng cho ô "ngưỡng kinh tế" ở slide 7 — trả lời câu "làm sao chứng minh snipe luôn lỗ".

**[BỐ CỤC]**
```
 Filler snipe = fill x% rồi bỏ. Có lời KHI:
     chênh giá ăn được  >  cọc bị tịch thu
        x · N · κ         >     S · (1−φ)
   N = giá trị order · S = stake · φ = tỉ lệ hoàn cọc · κ = chênh giá (edge)

 Cho breakeven (lời = 0), rút ra chênh giá tối thiểu để snipe có lời:

               collateralRate × timeMult × penalty
   κ (bps)  =  ───────────────────────────────────
                          10000 × x
     penalty = 10000 − refund_bps   (phần cọc bị mất)
     x       = % fill tại mép bucket bị phạt cuối cùng

 worstCaseKappa = MIN κ qua mọi (cỡ order × thời gian × bucket)
 → Config chỉ được nhận nếu worstCaseKappa ≥ 1000 bps (10%)

 VÍ DỤ (config mặc định) — điểm DỄ snipe nhất:
   order nhỏ (rate 2000) · nhiều thời gian (mult 10000 = 1×) · dừng sát mép 70%
   penalty = 10000 − 5000 = 5000 ;  x = 7000
   κ = 2000 × 10000 × 5000 / (10000 × 7000) ≈ 1429 bps ≈ 14.3%
   → phải ăn chênh giá >14% mới có lời → phi thực tế → AN TOÀN (≥10%)
```

**[NÓI]** "Ô 'ngưỡng kinh tế' ở slide trước được tính cụ thể thế này. Một filler định snipe — fill một phần rồi bỏ — chỉ có lời khi chênh giá nó ăn được trên phần đã fill lớn hơn phần cọc bị tịch thu. Cho hai vế bằng nhau, em rút ra được mức chênh giá tối thiểu κ để snipe hoà vốn: bằng tỉ lệ cọc nhân hệ số thời gian nhân phần phạt, chia cho phần trăm fill. Hàm worstCaseKappa quét mọi tổ hợp cỡ order, thời gian và bucket để lấy giá trị nhỏ nhất — tức điểm dễ snipe nhất — và config chỉ được chấp nhận nếu con số đó vẫn ≥ 10%. Lấy ví dụ config mặc định: chỗ dễ snipe nhất là order nhỏ, còn nhiều thời gian, dừng ngay sát mép 70%; tính ra filler vẫn phải ăn được hơn 14% chênh giá mới có lời — điều không thực tế — nên config được coi là an toàn."

**[CHUYỂN]** "Quay lại luồng chạy: ghép các mảnh trên, một lượt single-chain swap diễn ra như sau."

---

## SLIDE 8 — Luồng single-chain swap (~1 phút)

**[BỐ CỤC]** — sơ đồ tuần tự đánh số
```
 1  Swapper KÝ order (một lần) ───────────────▶ backend
 2  Filler A: đặt STAKE, register
 3  A fill một chunk → chuyển token cho swapper
                     → được HOÀN STAKE ngay
 4  Nhiều filler B, C… cùng fill phần còn lại
                     → remaining vơi dần về 0  ✅
 ─────────────────────────────────────────────
 Nhánh phụ:
   · Sát deadline chưa xong → FALLBACK route nốt qua aggregator
   · Filler nào ôm stake rồi bỏ → bị bất kỳ ai SLASH để lấy thưởng
```

**[NÓI]** "Swapper ký một lần. Filler register kèm stake rồi fill từng chunk — hệ thống tự chuyển token và hoàn stake ngay khi họ làm đúng. Vì nhiều filler cùng fill song song nên order lớn tan rất nhanh. Nếu sát deadline vẫn còn dư, fallback tự route nốt qua một aggregator khác để swapper luôn nhận đủ. Còn filler nào ôm stake rồi bỏ ngang thì bất kỳ ai cũng có thể slash họ và nhận một phần thưởng — nên luôn có người sẵn sàng làm việc đó."

**[CHUYỂN]** "Với cross-chain swap thì phức tạp hơn, vì hai chuỗi không dùng chung một cuốn sổ."

---

## SLIDE 9 — Cross-chain swap: các contract (~1 phút)

**[BỐ CỤC]** — hai cột chuỗi + hashlock ở giữa
```
   CHAIN A (token swapper)          CHAIN B (token filler)
 ┌───────────────────────┐        ┌───────────────────────┐
 │ EscrowSrc: giữ token   │        │ EscrowDst: giữ token   │
 │ swapper + bond filler  │        │ filler bỏ vào          │
 └───────────┬───────────┘        └───────────┬───────────┘
             │      cùng một HASHLOCK (H)      │
             └───────────┬────────────────────┘
                    hai timelock:
                    T1 (EscrowSrc) < T2 (EscrowDst)

 • Mỗi fill = một cặp escrow clone riêng → lỗi cái nào chỉ mất cái đó
 • FILLER tự giữ secret (chìa khoá của hashlock)
```

**[NÓI]** "Cross-chain không có orderbook chung, nên em dùng HTLC — hashed timelock. Hai bên bỏ token vào hai escrow, một trên mỗi chain, cùng khoá bằng một hashlock. Mỗi lần fill tạo một cặp escrow clone riêng, nên nếu có trục trặc thì chỉ ảnh hưởng đúng fill đó. Điểm đặc biệt trong thiết kế của em là chính filler giữ secret, và swapper chỉ đồng ý mở escrow bên mình sau khi đã verify escrow bên kia là thật."

**[CHUYỂN]** "Luồng swap và cách timelock bảo vệ swapper diễn ra thế nào?"

---

## SLIDE 10 — Luồng cross-chain swap (~1 phút 15)

**[BỐ CỤC]** — tuần tự 2 chuỗi + trục thời gian
```
 1  Filler fund EscrowDst trên CHAIN B trước
 2  Swapper verify EscrowDst là thật → KÝ cho phép mở EscrowSrc
 3  Filler withdraw EscrowSrc lấy token → việc này LÀM LỘ secret
 4  Relayer dùng secret vừa lộ, claim EscrowDst trả token cho swapper ✅
 ─────────────────────────────────────────────────────
 Nếu filler BỎ CUỘC (đỏ):
   Sau T1: cancel EscrowSrc → swapper HOÀN token + LẤY bond filler
   Sau T2: chỉ filler tự refund token EscrowDst của mình
   → không ai ăn hai đầu

  thời gian:  bây giờ ──▶ T1 (cancel Src) ──▶ T2 (refund Dst)
```

**[NÓI]** "Filler fund EscrowDst trên chain B trước. Swapper verify rồi mới ký cho phép mở escrow bên mình. Filler withdraw EscrowSrc để lấy token — và chính hành động đó tự động làm lộ secret công khai. Từ secret đó, relayer claim EscrowDst để trả token cho swapper. Nếu filler bỏ cuộc giữa chừng, secret không bao giờ lộ; sau timelock T1 swapper được hoàn token cộng thêm bond bị tịch thu. Còn token trong EscrowDst thì chỉ filler mới tự refund được sau T2. Nhờ vậy không ai ăn hai đầu."

**[CHUYỂN]** "Vì sao T1 phải sớm hơn T2, và bond bao nhiêu là đủ — đây là phần thiết kế động cơ cho filler."

---

## SLIDE 11 — Thiết kế động cơ: vì sao không ai ăn được hai đầu (~1 phút 30 — SLIDE QUAN TRỌNG)

**[BỐ CỤC]** — luật + 3 luận điểm + trục thời gian
```
 T1 (EscrowSrc: swapper đòi lại input)  <  T2 (EscrowDst: filler đòi lại output)
 secret S mở cả hai escrow, nhưng mỗi hàm chỉ trả cho ĐÚNG một bên cố định.

 ① KHÔNG AI ĂN ĐƯỢC CẢ HAI
   · Filler withdraw EscrowSrc = lấy input, NHƯNG lộ S ra công khai
     → swapper claim EscrowDst ngay (claim luôn trả swapper).
   · Filler không lộ S → quá T1 swapper cancel: lấy input + bond;
     filler chỉ refund lại EscrowDst của mình sau T2.
   ⇒ Mỗi bên chỉ lấy được phần của mình. Bỏ cuộc = filler mất bond.

 ② FILLER LUÔN MUỐN LẤY EscrowSrc CÀNG SỚM CÀNG TỐT
   quá T1 là swapper cancel, filler mất cả input lẫn bond
   → filler lộ S sớm → swapper dư thời gian claim. Lợi ích trùng nhau.

 ③ FINALITY = mốc giao dịch được đảm bảo KHÔNG bị đảo (reorg).
   Buffer T2 − T1 ≥ finality chain đích: sau khi S lộ, claim bên đích
   phải kịp FINAL trước T2 — nếu không, filler vừa lấy input vừa
   refund EscrowDst = ăn hai đầu. Đây là giả định phi-mật-mã DUY NHẤT.

   bây giờ ──[fill]──▶ T1 (cancel Src) ──buffer≥finality──▶ T2 (refund Dst)
```

**[NÓI]** "Ý tưởng cốt lõi: một secret mở được cả hai escrow, nhưng mỗi hàm chỉ trả tiền cho đúng một bên cố định — nên không cách nào một người ôm cả hai. Cụ thể: nếu filler withdraw EscrowSrc để lấy input thì chính hành động đó làm lộ secret, và hàm claim của EscrowDst luôn trả cho swapper, nên swapper lấy được output ngay — filler không giữ được cả hai. Ngược lại nếu filler không lộ secret thì quá T1 swapper cancel, lấy lại input cộng luôn bond, còn filler chỉ đòi lại được output của chính mình sau T2. Kết cục xấu nhất là mỗi bên lấy lại phần của mình, và bên bỏ cuộc — filler — mất bond.

Điểm hai: vì quá T1 là swapper cancel mất input và bond, nên filler luôn có xu hướng withdraw EscrowSrc càng sớm càng tốt. Mà withdraw sớm nghĩa là lộ secret sớm, tức swapper càng có nhiều thời gian claim bên kia — động cơ ích kỷ của filler lại trùng với sự an toàn của swapper.

Điểm ba là finality — điểm em muốn nhấn. Finality là thời điểm một giao dịch được blockchain đảm bảo không thể bị đảo ngược; trước finality, một cú reorg có thể xoá giao dịch vừa xảy ra. Toàn bộ an toàn cross-chain dựa vào chuỗi 'secret lộ ở chain nguồn thì claim được ở chain đích', mà timing giữa hai chain thì contract không ép được. Nên buffer giữa T1 và T2 phải đặt dài hơn finality của chain đích, để sau khi secret lộ, giao dịch claim của swapper kịp final trước T2. Nếu buffer quá ngắn, filler có thể vừa lấy input vừa refund output — ăn hai đầu. Đây là giả định duy nhất không dựa trên mật mã mà dựa trên tham số, nên phải đặt thận trọng."

**[CHUYỂN]** "Vậy rủi ro thực tế đọng lại ở mỗi bên là gì?"

---

## SLIDE 11b — Rủi ro còn lại ở swapper & filler (~40 giây, có thể gộp vào slide 11)

**[BỐ CỤC]** — bảng rủi ro
```
 BÊN       RỦI RO                              GIẢM THIỂU
 ────      ──────                              ──────────
 Swapper   ký cho mở EscrowSrc khi EscrowDst   verify EscrowDst là clone
           chưa final → nó bị reorg mất mà      thật + chờ chain đích final
           input vẫn bị hút                      RỒI mới ký (Điểm A)

           relayer chết → không tự nhận output  tự claim (permissionless),
                                                miễn trước T2

 Filler    fund EscrowDst TRƯỚC → nếu swapper   chỉ khoá vốn tạm, refund
           không ký thì vốn bị khoá tới T2       lại sau T2 (mất gas + thời
                                                gian, không mất gốc)

           lộ S mà withdraw bị reorg → mất       withdraw sớm, chờ đủ
           output nhưng chưa chắc lấy được input  confirm trước khi coi xong
```

**[NÓI]** "Đọng lại, mỗi bên còn một ít rủi ro. Về phía swapper: nếu ký cho phép mở EscrowSrc khi EscrowDst bên kia chưa final rồi nó bị reorg mất, thì input vẫn bị hút mà không có output — nên swapper phải verify escrow đích là thật và chờ nó final rồi mới ký, đây là điểm verify mà em gọi là Điểm A. Rủi ro thứ hai chỉ là liveness: relayer chết thì swapper không tự nhận, nhưng tự claim được vì secret đã public, miễn còn trước T2. Về phía filler: nó phải fund EscrowDst trước nên nếu swapper không ký thì vốn bị khoá tạm tới T2 — mất gas và thời gian chứ không mất gốc; đây là cái giá của việc 'đi trước', hợp lý vì filler là bên chuyên nghiệp. Nói chung swapper chỉ cần làm đúng thứ tự verify là an toàn, còn filler gánh rủi ro vận hành để đổi lấy lợi nhuận."

**[CHUYỂN]** "Các tính chất an toàn này đều được kiểm chứng bằng test. Sau đây là kết quả."

---

## SLIDE 12 — Kết quả & Bản đồ kiểm thử (~1 phút)

**[BỐ CỤC]** — môi trường + con số + bảng nhóm
```
 MÔI TRƯỜNG: Foundry (forge), có fork mạng thật để test phần
 oracle định giá, hai chain Anvil giả lập cho cross-chain.

        ┌─────────────────────────────────┐
        │   173 / 173  test ĐẠT            │
        └─────────────────────────────────┘

 Nhóm test                     Chứng minh điều gì
 ───────────────               ──────────────────
 Thư viện nền                  Tính stake/refund đúng
 Governance & guard            Không ai lén nới lỏng config
 Adversarial / MEV             Chặn front-run, chặn reentrancy
 Kinh tế stake                 Hoàn/slash đúng người
 Cross-chain                   Không ai ăn hai đầu
 Fuzz / invariant              Order LUÔN settle được
```

**[NÓI]** "Em test bằng Foundry, có fork mạng thật để thử phần oracle định giá, và hai chain Anvil giả lập cho phần cross-chain. Tổng cộng 173 test đều đạt, gồm cả fuzzing. Em chia thành sáu nhóm, quan trọng nhất là adversarial và cross-chain. Em xin đi qua vài trường hợp tiêu biểu, mỗi cái là một tình huống và cách contract xử lý."

**[CHUYỂN]** "Ngoài bộ test tự viết, em còn dùng thêm phân tích tĩnh, mutation testing và một audit độc lập."

---

## SLIDE 12b — Rà soát bảo mật & phân tích tĩnh (~50 giây)

> Nội dung Chương 4 của báo cáo — tăng độ tin cậy, nên đưa lên trước phần testcase.

**[BỐ CỤC]**
```
 Ngoài 173 test động, dùng thêm 3 lớp:

 ▸ SLITHER (phân tích tĩnh, Trail of Bits)
   101 detector · 34 contract → 32 cảnh báo
   → 4 sửa · 2 High không thực chất (reentrancy đã guard + false-positive)
   → 0 lỗ hổng khai thác được

 ▸ MUTATION TESTING (Vertigo-rs) — chèn lỗi vào 4 thư viện thuần
   20 mutant: ban đầu bắt 8/20 (40%) → thêm 4 test biên → 20/20 (100%)

 ▸ TRUFY (audit độc lập bằng AI) — 8 phát hiện: 3 Cao · 4 TB · 1 Thấp
   → 3 ĐÃ SỬA (fee-on-transfer, watcher bỏ sự kiện sau outage, withdraw kẹt ETH)
   → 2 phát hiện cross-chain (bond cố định, không reopen được slot) đã được
     GIẢI QUYẾT khi thiết kế lại cross-chain: bond ĐỘNG + bỏ mô hình slot
   → còn lại giải trình (TWAP/nonce cần môi trường production) + 1 ngoài phạm vi

 ▸ THÍ NGHIỆM ĐỊNH LƯỢNG TWAP (fork mainnet) — mức sụt cọc theo cửa sổ:
     cửa sổ 60s   : −21% (30M) / −100% (300M)
     cửa sổ 1800s : −1.5% (30M) /  −81% (300M)
   → sàn minCollateral chặn; nới cửa sổ + oracle độc lập là hướng đi
```

**[NÓI]** "Ngoài 173 test động, em dùng thêm ba lớp. Phân tích tĩnh bằng Slither của Trail of Bits chạy trên toàn bộ contract, 32 cảnh báo nhưng sau khi rà thì 4 cái đáng sửa đã sửa, hai cảnh báo mức Cao là không thực chất, và không có lỗ hổng nào khai thác được. Mutation testing tự chèn lỗi vào các thư viện để đo chất lượng bộ test — ban đầu chỉ bắt được 40%, em thêm test cho các giá trị biên và đạt 100%. Quan trọng nhất là em cho audit độc lập bằng Trufy: 8 phát hiện, ba cái đã sửa gồm lỗi token trừ phí, watcher bỏ sự kiện sau khi backend dừng lâu, và lỗi kẹt ETH; bốn cái còn lại cần môi trường mainnet thật mới kiểm chứng được. Riêng điểm yếu oracle, em có hẳn thí nghiệm định lượng: cửa sổ giá 60 giây bị sụt cọc tới 100% khi tấn công vốn lớn, nên hướng đi là nới cửa sổ và thêm nguồn giá độc lập."

**[CHUYỂN]** "Giờ đi vào vài trường hợp test tiêu biểu — mỗi cái lộ ra một quyết định thiết kế tinh tế."

---

## CÁC SLIDE TESTCASE — gom thành 3 slide (mỗi slide ~50 giây)

> Mỗi bài test kể thành một tình huống cụ thể, số liệu lấy từ code test, kèm tên hàm contract chặn nó.
> Format: **▸ tình huống (số liệu thật)** rồi **→ contract xử ở hàm nào, logic ra sao**.
> Không làm 1 slide cho mỗi bài (có 173 bài) — chỉ kể vài cái đại diện.

### SLIDE 13 — Filler cố gian lận

**[BỐ CỤC]** — mỗi ca: kịch bản → cơ chế code chặn
```
 Bối cảnh: order bán 4 WETH.

 ▸ Register cả 4 WETH, đặt stake, rồi bỏ đi không fill.
   Cơ chế: FillAuction.slash() — 3 điều kiện đồng thời:
     block.number > deadline + SLASH_WINDOW(50) · remainingInput > 0
     (order còn dở) · !cancelled && !nonceInvalidated.
     Permissionless + thưởng stake/10 cho người gọi → luôn có người phạt.

 ▸ Hai filler cùng register; B fill hết trước, A hết chỗ.
   Cơ chế: releaseRegistration() thấy remainingInput == 0 → hoàn 100%
     stake, KHÔNG đi qua refundTable. Hàm TÁCH "order xong bởi người khác"
     (reclaim đủ) khỏi "filler bỏ dở" (mới bị slash) → không phạt oan.

 ▸ Sửa startPrice để trả swapper ít hơn.
   Cơ chế: startPrice ∈ ORDER_TYPE_HASH (ký EIP-712). _validateOrder():
     ECDSA.recover(hash mới) ≠ cosigner → revert. Đường giá được KHOÁ bằng
     chữ ký, filler không tự bơm tham số được.

 ▸ Token output "bẫy" gọi đệ quy executePartialChunk giữa lúc payout.
   Cơ chế: modifier nonReentrant + thứ tự CEI (_remaining trừ TRƯỚC khi
     transfer) → lần gọi lồng revert, và state đã khoá trước interaction.
```

**[NÓI]** "Bối cảnh order 4 WETH. Ca một, ôm stake rồi bỏ: hàm slash chỉ cho phạt khi hội đủ ba điều kiện — đã quá hạn cộng cửa sổ 50 block, order vẫn còn dở, và chưa bị huỷ hay vô hiệu nonce; nó là permissionless và thưởng một phần mười stake cho người gọi nên luôn có người đi phạt. Ca hai, filler thua cuộc đua: hàm releaseRegistration thấy order đã xong thì hoàn đủ stake và không đi qua bảng phạt — điểm mấu chốt là code tách bạch 'order được người khác hoàn tất' với 'filler tự bỏ dở', nên người thua cuộc không bị phạt oan. Ca ba, sửa giá: startPrice nằm trong dữ liệu ký EIP-712, nên khi verify, hàm recover ra địa chỉ khác cosigner và revert — đường giá bị khoá bằng chữ ký. Ca bốn, token bẫy: vừa có modifier chống đệ quy, vừa theo thứ tự checks-effects-interactions nên remaining đã bị trừ trước khi chuyển token."

**[CHUYỂN]** "Nhóm tiếp theo: cơ chế hoàn stake sao cho không ai bị phạt oan."

### SLIDE 14 — Hoàn stake công bằng, không phạt oan

**[BỐ CỤC]** — mỗi ca: kịch bản → cơ chế code chặn
```
 ▸ A register cả order 1000 USDC; bot chen ngang fill 110 (11%), còn 890.
   Cơ chế: onFillSuccess() đặt mẫu số hoàn cọc = min(cam kết,
     remainingAtFill) = min(1000, 890) = 890 (fix Trufy 3.5). Reactor
     truyền remaining TRƯỚC fill. A fill trọn 890 → tỉ lệ 100% → hoàn đủ.
     (hasValidRegistration dùng reg.fillAmount >= fillAmount nên đăng ký
      100% vẫn fill được 89%.)

 ▸ Ba mức hoàn cọc theo % giao.
   Cơ chế: computeRefund() → getFillRatioBucket(actualFill / cam kết) tra
     refundTable. Bảng ĐÃ SNAPSHOT lúc register (chống admin đổi bảng giữa
     chừng — risk #3). validate ép bảng non-decreasing & kết ở 100%.

 ▸ Fill 1% đúng cam kết → hoàn đủ; order minFillBps=10% → fill 1% bị chặn.
   Cơ chế: tỉ lệ tính trên CAM KẾT của chính filler (D-2), fill trọn 1%
     = 100% cam kết → hoàn đủ. Chặn fill vụn: require(fillAmount ==
     remaining || fillAmount >= _minFill), _minFill = inputAmount·minFillBps/1e4.

 ▸ Admin nới lỏng luật cọc từng bước.
   Cơ chế 3 lớp: validate (sàn tuyệt đối worstCaseKappa ≥ 10%) → guardCheck
     (so output cũ/mới tại lưới điểm, ép MAX_DELTA 20% + sàn MIN_PENALTY 5%)
     → nới lỏng bị hoãn LOOSEN_DELAY 7 ngày, guardian rollback được 1 bước.
```

**[NÓI]** "Ca đầu, cũng là ca tinh tế nhất: A đăng ký cả order 1000 USDC, bot chen ngang fill mất 110, còn 890. A fill nốt 890 và vẫn hoàn đủ stake — cơ chế là hàm onFillSuccess đặt mẫu số hoàn cọc bằng phần nhỏ hơn giữa cam kết và lượng thực còn lại lúc fill, mà Reactor truyền vào là remaining trước fill; A ăn trọn 890 nên tỉ lệ là 100%. Đây là fix cho một phát hiện của Trufy. Ca hai, ba mức hoàn: hàm computeRefund tra bảng theo tỉ lệ fill trên cam kết, và bảng này được snapshot ngay lúc register nên admin có đổi bảng giữa chừng cũng không ảnh hưởng filler đã đăng ký. Ca ba: tỉ lệ tính theo cam kết của chính filler nên fill nhỏ mà đúng cam kết vẫn hoàn đủ; muốn chặn fill vụn thì swapper đặt minFillBps ngay trong order. Ca bốn, admin nới lỏng luật: có ba lớp chặn — một sàn kinh tế tuyệt đối, một guard so sánh output cũ mới giới hạn thay đổi 20% mỗi lần và giữ sàn phạt 5%, và mọi nới lỏng đều bị hoãn bảy ngày kèm quyền rollback của guardian."

**[CHUYỂN]** "Nhóm cuối là cross-chain — nơi rủi ro ăn hai đầu lớn nhất."

### SLIDE 15 — Cross-chain: không ai ăn hai đầu

**[BỐ CỤC]** — mỗi ca: kịch bản → cơ chế code chặn
```
 Bối cảnh: đổi 1 WETH (chain A) ↔ 2500 USDC (chain B), bond 0.1 ETH.

 ▸ Filler đặt t2 ≤ t1 (escrow nhận đóng trước escrow trả).
   Cơ chế: fillSlot() require(auth.t2 > auth.t1) — bất biến T2>T1 ép
     ON-CHAIN (bản thiết kế trước chỉ để trong comment).

 ▸ Fund 2500 USDC vào EscrowDst rồi bỏ cuộc, không lộ secret.
   Cơ chế (3 chốt): (1) sau T1, EscrowSrc.cancel() trả input + bond cho
     SWAPPER — bond KHÔNG cho msg.sender nên filler không tự cancel lấy
     bond; (2) EscrowDst.claim() trả cố định recipient = swapper (cần
     secret, không lộ); (3) EscrowDst.refund() require(msg.sender==filler).
     Vì T2>T1, swapper được hoàn ở T1 trước khi dst mở ở T2 → không double-dip.

 ▸ Tái dùng một hashlock đã dùng.
   Cơ chế: salt CREATE2 = keccak256(orderHash, hashlock). Clone lần 2
     cùng salt → địa chỉ đã có code → EVM revert. Một hashlock ↔ một escrow,
     không cần bitmap "đã dùng".

 ▸ (MỚI, §12.4) order 2 WETH, filler fill 1 WETH rồi bỏ, bị cancel.
   Cơ chế: cancel() gọi factory.restoreRemaining(); factory require
     msg.sender == predictDeterministicAddress(orderHash, hashlock) → CHỈ
     đúng clone gọi được; clamp restored ≤ orderAmount; one-shot nhờ cờ
     `cancelled` (cancel lần 2 revert "settled").
```

**[NÓI]** "Bối cảnh đổi 1 WETH lấy 2500 USDC, bond 0.1 ETH. Ca một, đặt hai timelock sai thứ tự: hàm fillSlot có require t2 lớn hơn t1, nên bất biến này được ép ngay on-chain chứ không chỉ là ghi chú như bản trước. Ca chính, filler bỏ cuộc: có ba chốt cùng lúc — sau T1, hàm cancel trả input và bond về cho swapper chứ không cho người gọi nên filler không thể tự cancel để lấy lại bond; hàm claim bên đích luôn trả cố định cho swapper và cần secret vốn chưa lộ; và hàm refund bên đích yêu cầu người gọi phải là filler. Cộng với T2 lớn hơn T1, swapper được hoàn ở T1 trước khi két đích mở ở T2, nên không có đường ăn hai đầu. Ca ba, tái dùng hashlock: salt CREATE2 tính từ orderHash và hashlock, deploy lại cùng salt thì đụng địa chỉ đã có code nên revert. Ca bốn là phần em mới bổ sung: khi một fill bị cancel, hàm cancel gọi ngược về factory để trả phần đó về remaining, nhưng factory kiểm tra người gọi đúng bằng địa chỉ CREATE2 dự đoán nên chỉ clone thật gọi được, có kẹp trần và chỉ chạy được một lần."

**[CHUYỂN]** "Cuối phần kết quả, em xin thống kê chi phí gas phía filler và so với UniswapX."

---

## SLIDE 15b — So sánh gas & mô hình phía filler: 4 hệ (~1 phút)

> Swapper GASLESS ở cả 4 hệ (ký off-chain) → chỉ so gas phía filler/solver.
> Chỉ NeutronX là số ĐO THẬT (`forge gas-report`, median, oracle tắt); 3 hệ kia là ước tính theo kiến trúc — đánh dấu (*).

**[BỐ CỤC]** — ma trận 4 cột
```
               │ UniswapX     │ 1inch Fusion │ CoW Swap     │ NeutronX(đo)
 ──────────────┼──────────────┼──────────────┼──────────────┼─────────────
 Fill single   │ all-or-      │ partial-fill │ batch (CoW)  │ partial-fill
               │ nothing      │              │              │
 Filler/solver │ permission-  │ KYC + stake  │ bonding +    │ permission-
               │ less         │ + whitelist  │ KYC          │ less (stake)
 Gas filler    │ ~120–200k*   │ ~150–250k*   │ RẺ NHẤT:     │ reg ~410k +
 single-chain  │ (1 tx AoN)   │ (settlement) │ amortized    │ fill ~235k
               │              │              │ theo batch*  │ /chunk
 ──────────────┼──────────────┼──────────────┼──────────────┼─────────────
 Cross-chain   │ ERC-7683 +   │ Fusion+ HTLC │ bridge ngoài │ HTLC filler-
 mô hình       │ Across       │ (escrow+     │ (Bungee/     │ holds-key
               │ (optimistic) │ deposit)     │ Across)      │ (atomic)
 CC niềm tin   │ Across       │ relayer điều │ bridge bên   │ KHÔNG bên
               │ relayer      │ phối (atomic)│ ngoài        │ thứ 3
 Gas filler CC │ ~200–350k*   │ ~400–700k*   │ bridge+swap* │ ~720k (đo)
 ──────────────┴──────────────┴──────────────┴──────────────┴─────────────
 * ước tính kiến trúc; chỉ NeutronX đo thật.

 → CoW rẻ gas nhất (nhờ batch) nhưng solver PERMISSIONED.
   1inch Fusion+ cross-chain cũng HTLC (cùng họ NeutronX) nhưng resolver KYC.
   NeutronX là hệ DUY NHẤT: permissionless + partial-fill + cross-chain
   atomic không cầu nối — đánh đổi bằng gas filler cao hơn.
```

**[NÓI]** "Người dùng gasless ở cả bốn hệ, nên em so gas phía filler; chỉ số của NeutronX là đo thật, ba hệ kia em ước tính theo kiến trúc và đánh dấu sao. Bên single-chain: UniswapX một giao dịch all-or-nothing tầm 120 đến 200 nghìn; 1inch tương tự nhưng partial-fill; CoW là rẻ nhất vì nó gộp nhiều order vào một giao dịch settlement nên gas trên mỗi order được chia nhỏ — đây là điểm mạnh riêng của mô hình batch. NeutronX tốn nhất, 410 nghìn để đăng ký kèm stake cộng 235 nghìn mỗi lần fill. Bên cross-chain: UniswapX dùng ERC-7683 với Across theo cơ chế optimistic nên phải tin relayer của Across; CoW thì không có primitive riêng, nó gọi cầu nối bên ngoài; còn 1inch Fusion+ thực ra cũng là HTLC giống hệ của em — nên gas cross-chain của em nằm cùng khoảng với 1inch, khác biệt là filler của em không cần KYC và tự giữ khóa. Tóm lại, CoW rẻ gas nhất nhưng solver bị permissioned; NeutronX là hệ duy nhất cùng lúc permissionless, partial-fill, và cross-chain atomic không cầu nối — và cái giá phải trả là gas phía filler cao hơn."

**[CHUYỂN]** "Từ toàn bộ kết quả này, em rút ra kết luận và hướng phát triển."

---

## SLIDE 16 — Kết luận: đối chiếu 5 mục tiêu (~1 phút)

> Theo Chương 5 báo cáo — bảng đối chiếu mục tiêu ↔ kết quả.

**[BỐ CỤC]** — bảng 5 mục tiêu
```
 MỤC TIÊU                                KẾT QUẢ
 ────────                                ───────
 Partial-fill theo đấu giá Hà Lan   ✓ PartialFillReactor, mỗi chunk
                                        định giá độc lập, đã test
 Ký off-chain EIP-712 + Permit2     ✓ ký bằng ví, gasless khi tạo order
 Stake động ràng buộc filler        ✓ FillAuction, phân biệt filler
                                        thua cuộc vs bỏ dở
 Fallback đảm bảo hoàn tất order    ✓ FallbackExecutor (Uniswap/KyberSwap)
 Cross-chain không cầu nối,         ✓ HTLC filler-holds-key, mỗi fill
   khớp từng phần                       một escrow riêng, partial-fill
                                        nhiều filler đã kiểm thử

 → Đóng góp chính: cơ chế STAKE ràng buộc filler + cross-chain
   CÓ partial-fill — hai điểm các hệ đã khảo sát ít làm.
```

**[NÓI]** "Đối chiếu với năm mục tiêu đặt ra ban đầu: cả năm đều đạt ở mức cài đặt và kiểm thử trên mạng giả lập. Partial-fill theo đấu giá Hà Lan nằm trong Reactor; ký off-chain gasless bằng EIP-712 và Permit2; stake động ràng buộc filler trong FillAuction, phân biệt được filler thua cuộc với filler bỏ dở; fallback đảm bảo order luôn hoàn tất; và cross-chain không cầu nối có hỗ trợ khớp từng phần. Đóng góp đáng kể nhất là cơ chế stake ràng buộc trách nhiệm filler và phần cross-chain có partial-fill — hai điểm mà các hệ đã khảo sát ít làm."

**[CHUYỂN]** "Bên cạnh những gì đạt được, hệ vẫn còn hạn chế và hướng phát triển rõ ràng."

---

## SLIDE 16b — Hạn chế & Hướng phát triển (~1 phút)

**[BỐ CỤC]** — hai cột
```
 HẠN CHẾ                          HƯỚNG PHÁT TRIỂN
 ───────                          ─────────────────
 • Mới test trên Anvil giả lập,    • Lên testnet + audit chuyên gia
   chưa testnet/mainnet              (người) trước khi ra mainnet
 • Filler vốn không giới hạn,      • Phi tập trung cosigner bằng TEE
   không mempool cạnh tranh thật     (bỏ điểm tập trung, không cần
   → mới chứng minh tính ĐÚNG,       thêm giao thức đồng thuận)
   chưa phản ánh kinh tế mainnet   • Nới cửa sổ TWAP + thêm oracle
 • Điểm tập trung: cosigner         độc lập (giảm thao túng, finding 3.5)
   (single-chain) + backend        • Thêm adapter 1inch/0x cho fallback
 • Phạm vi hẹp: cross-chain chỉ    • Nhiều chuỗi EVM hơn → tiến tới
   EVM; fallback 2 sàn               chuỗi non-EVM
```

**[NÓI]** "Về hạn chế: hệ mới chỉ test trên mạng giả lập, chưa lên testnet hay mainnet. Trong môi trường test, filler được cấp vốn không giới hạn và không có mempool cạnh tranh thật, nên kết quả mới xác nhận các cơ chế đúng, chưa phản ánh hành vi khi vốn hữu hạn và nhiều filler tranh nhau trên mainnet. Về kiến trúc, cosigner và backend vẫn là điểm tập trung, và phạm vi còn hẹp — cross-chain chỉ EVM, fallback mới hai sàn. Hướng phát triển: trước mắt đưa lên testnet kèm một đợt kiểm toán do chuyên gia người thực hiện; phi tập trung cosigner bằng cách chạy module ký trong môi trường thực thi tin cậy TEE; nới cửa sổ TWAP và thêm nguồn giá độc lập để giảm rủi ro thao túng; thêm adapter cho 1inch và 0x; và mở rộng thêm nhiều chuỗi, tiến tới cả chuỗi không tương thích EVM."

**[CHUYỂN]** "Em xin demo giao diện thực tế ở phần phụ lục."

---

## SLIDE 17 — Backend: vai trò & mức phụ thuộc (~1 phút) — TUỲ CHỌN / DỰ PHÒNG HỎI ĐÁP

> Slide này trả lời câu "backend tập trung ở đâu, có bỏ được không". Có thể để dành cho phần hỏi đáp thay vì trình bày thẳng.

**[BỐ CỤC]**
```
 Backend làm 3 việc — chỉ 1 việc là BẮT BUỘC:

 1  ORDERBOOK (nơi gặp gỡ order & filler)   ◀ BẮT BUỘC phải có một
    filler và swapper lạ mặt cần một chỗ        lớp chia sẻ (không thể
    chung để biết có order nào mà fill          nhét vào một frontend đơn lẻ)

 2  RELAYER (claim hộ + trả gas hộ)         ◀ tiện lợi; backend chết thì
    để swapper khỏi cần gas ở chain đích        swapper tự claim được, KHÔNG
                                               mất tiền (secret đã public)

 3  WATCHER (theo dõi trạng thái + verify)  ◀ chỉ cho tiện; frontend tự
    báo "EscrowDst đã tạo đúng chưa"            làm được hết (verify = so
                                               địa chỉ CREATE2 + field)
```

**[NÓI]** "Backend làm ba việc, nhưng chỉ một việc là thực sự bắt buộc. Việc bắt buộc là orderbook — filler và swapper vốn không quen nhau, phải có một chỗ chung để filler biết đang có order nào mà nhảy vào. Cái này không thể nhét vào một frontend đơn lẻ được, mọi hệ intent tương tự đều cần. Hai việc còn lại chỉ để cho tiện: relayer claim hộ và trả gas hộ ở chain đích, nhưng nếu backend chết thì swapper tự claim được và không mất tiền — vì secret đã public on-chain. Còn watcher theo dõi trạng thái và verify hộ thì bản thân frontend làm được hết, vì verify chỉ là so địa chỉ CREATE2 với field. Nói cách khác, phần lõi phi tập trung vẫn nằm ở smart contract — backend chủ yếu để UX mượt hơn."

**[CHUYỂN]** "Em xin demo giao diện thực tế ở phần phụ lục."

---

## PHỤ LỤC — Demo & Giao diện

**[BỐ CỤC / DÙNG GÌ]** 2–3 ảnh chụp: (1) swapper tạo & ký order, (2) dashboard của filler lúc đặt stake + fill, (3) trạng thái cross-chain swap trên hai chain. Nếu demo trực tiếp: chạy hai chain Anvil + backend, thực hiện một order được hai filler cùng partial-fill.

**[NÓI]** Ngắn gọn, chủ yếu để hội đồng đặt câu hỏi.

---

## GHI CHÚ CANH GIỜ & TRỌNG TÂM

- **Slide "ăn điểm":** 7 (stake), 10–11 (HTLC + thiết kế động cơ + finality), 13–15 (test). Tập nói kỹ ba chỗ này.
- **Slide nói nhanh, chỉ dẫn dắt:** 1, 2, 6, 9.
- **Slide 12b** (Slither/mutation/Trufy/TWAP) là nội dung Chương 4 báo cáo — nên giữ, tăng độ tin cậy; nói nhanh ~50s.
- **Slide 7b** (cách tính worst-case kappa + ví dụ) và **11b** (rủi ro swapper/filler) là slide deep-dive — có thể bỏ khi trình bày chính, chỉ bật khi hội đồng hỏi sâu.
- **Slide 17** để dành cho hỏi đáp — chỉ trình bày nếu còn giờ hoặc bị hỏi về "tập trung/phi tập trung".
- Nếu hội đồng thiên lý thuyết → nhấn slide 11 (finality + vì sao không ai ăn hai đầu).
- Nếu hội đồng thiên kỹ thuật → nhấn slide 13–15 (kịch bản tấn công ↔ cách contract chặn).
- **Slide 15b** (ma trận gas 4 hệ: UniswapX/1inch/CoW/NeutronX): chỉ NeutronX đo thật `forge gas-report`; 3 hệ kia là **ước tính kiến trúc**, đánh dấu (*) — nếu bị hỏi nói rõ "chưa có benchmark chính thức". Hai điểm dễ bị vặn, cần nắm: (1) **CoW rẻ gas nhất** là do batch (gộp nhiều order/1 tx) — đây là ưu điểm thật của batch, không giấu; nhưng solver CoW bị permissioned/KYC. (2) **1inch Fusion+ cross-chain cũng là HTLC** giống NeutronX (escrow + safety deposit) — nên gas cross-chain của ta cùng khoảng 1inch, khác biệt là permissionless + filler-holds-key, không phải "ta tệ hơn". Thông điệp: NeutronX là hệ DUY NHẤT gộp permissionless + partial-fill + cross-chain atomic không cầu nối, trả giá bằng gas filler cao hơn. Muốn số chắc hơn phải fork mainnet đo thật (chưa làm).
- Tổng ~19 slide chính + phụ lục ≈ 13–14 phút, dư ~1 phút.

> ⚠️ **BÁO CÁO (DoAn.pdf) ĐANG LỖI THỜI — SLIDE ĐÃ THEO CODE HIỆN TẠI (Model-2).** Slide này là nguồn đúng; PDF cần cập nhật RIÊNG (không ảnh hưởng lúc dựng slide, nhưng phải sửa trước khi nộp bản cuối). Các mục PDF lệch với code:
> - Cross-chain: PDF viết **Model-1** (ký quỹ mỗi slot + cây Merkle + cosigner); code là **Model-2** (filler-holds-key, per-fill hashlock, không Merkle, không cosigner cross-chain, bond động). Cần sửa: Tóm tắt, Kết luận (bảng mục tiêu), §2.6, §3.6.
> - Trufy §4.5: 3.1 (`MIN_SAFETY_DEPOSIT` cố định) và 3.6 (`reopenSlot`) mô tả Model-1 — Model-2 đã thay bằng bond động + bỏ slot; cần chú thích lại.
> - Số test: PDF ghi **154/154**, code hiện **173/173** (đã tăng sau redesign + §12.4). Nếu bị hỏi, dùng 173.
> Khi bảo vệ nếu hội đồng đã đọc PDF: chủ động nói "phần cross-chain trong báo cáo là bản thiết kế trước, em đã cải tiến lên mô hình filler-holds-key và slide phản ánh bản mới".

---

## PHỤ CHÚ KỸ THUẬT (cho người thuyết trình, KHÔNG lên slide)

Bảng ánh xạ "thuật ngữ trên slide → contract / tên chính xác trong code", phòng khi hội đồng hỏi sâu:

| Thuật ngữ trên slide | Contract / tên chính xác |
|---|---|
| Filler / Swapper | filler (người thực thi) / swapper (người ký intent) |
| Order / intent | Signed intent order (EIP-712) |
| Reactor | PartialFillReactor |
| FillAuction | FillAuction (giữ stake, slash, refund) |
| DynamicStakeLib | công thức stake theo bucket (size × time × fill-ratio) |
| FallbackExecutor | route phần dư qua aggregator gần deadline |
| HTLC | Hashed Time-Lock Contract |
| Hashlock (H) / secret (S) | H = keccak256(S) |
| EscrowSrc / EscrowDst | escrow clone CREATE2 trên chain nguồn / đích |
| Timelock T1 / T2 | T1 (Src) < T2 (Dst), ép on-chain |
| Ngưỡng kinh tế worst-case | worstCaseKappaBps floor |
| Backend | orderbook + relayer + watcher/indexer |
| Orderbook (bắt buộc) | rendezvous layer — filler khám phá order |
| Relayer | gọi EscrowDst.claim(S) — permissionless, non-custody |
| Mở lại fill bị huỷ | §12.4 restoreRemaining (đã fix 2026-07-15) |

**Điểm §12.4 (mới fix):** khi một lần khớp chéo bị huỷ (EscrowSrc.cancel sau T1), phần đã trừ khỏi "còn lại" nay được khôi phục qua callback `restoreRemaining` — chỉ đúng clone của (orderHash, hashlock) gọi được (xác thực bằng địa chỉ CREATE2), một-lần-duy-nhất (cờ cancelled), có chặn tràn. 3 test mới, 173/173 đạt.

**Điểm cần thành thật nếu bị hỏi:** phần định giá cọc (oracle TWAP 60 giây) vẫn có thể bị thao túng nếu kẻ tấn công đủ vốn dìm giá — có hẳn một bài test chứng minh điều này. Biện pháp thật khi lên mạng chính: cửa sổ giá dài hơn + pool sâu hơn. Chủ động nêu điểm này sẽ ghi điểm vì cho thấy hiểu sâu.

---

## PHỤ LỤC B — Bảng contract & hàm (chữ ký đầy đủ)

> Chỉ liệt kê hàm `external`/`public`. Bỏ helper `internal`/`private`. Cột "Quyền" ghi access-control / modifier.

### A. SETTLEMENT — SINGLE-CHAIN

#### PartialFillReactor (sổ lệnh + thực thi)
| Hàm | Tham số | Trả về | Quyền |
|---|---|---|---|
| `register` | `(SignedOrder order, uint256 fillAmount)` | — | `payable nonReentrant` |
| `executePartialChunk` | `(SignedOrder order, uint256 fillAmount)` | — | external |
| `executePartialChunkWithCallback` | `(SignedOrder order, uint256 fillAmount, bytes callbackData)` | — | external |
| `remainingInput` | `(bytes32 orderHash, uint256 orderAmount)` | `uint256` | view |
| `isCancelled` | `(bytes32 orderHash)` | `bool` | view |
| `fallbackInitiated` | `(bytes32 orderHash)` | `bool` | view |
| `isNonceInvalidatedForOrder` | `(bytes32 orderHash)` | `bool` | view |
| `nonceInvalidated` | `(address swapper, uint256 nonce)` | `bool` | view |
| `verifyOrderSignature` | `(SignedOrder order)` | — | view |
| `markFallbackInitiated` | `(bytes32 orderHash)` | — | chỉ fallbackExecutor |
| `recordFallbackOutput` | `(bytes32 orderHash, uint256 amountOut, uint256 minOutputAmount)` | — | chỉ fallbackExecutor |
| `setFallbackExecutor` | `(address _fallbackExecutor)` | — | chỉ owner, 1 lần |
| `invalidateNonce` | `(uint256 nonce)` | — | swapper tự gọi |
| `cancelOrder` | `(OrderInfo info)` | — | chỉ swapper |

*Struct* `OrderInfo{ address swapper; address inputToken; uint256 inputAmount; address outputToken; uint256 minOutputAmount; uint256 deadline; uint256 nonce; uint16 minFillBps; uint128 startPrice; uint32 decayPerBlock; uint24 feeTier }` · `SignedOrder{ OrderInfo info; bytes sig }`

#### FillAuction (sổ cọc)
| Hàm | Tham số | Trả về | Quyền |
|---|---|---|---|
| `register` | `(address filler, bytes32 orderHash, uint256 fillAmount, uint256 orderTotal, uint256 deadline, address inputToken, uint24 feeTier)` | — | `payable` chỉ reactor |
| `previewCollateral` | `(address inputToken, uint24 feeTier, uint256 fillAmount, uint256 deadline)` | `uint256` | view |
| `onFillSuccess` | `(bytes32 orderHash, address filler, uint256 actualFillAmount, uint256 remainingAtFill)` | — | chỉ reactor |
| `slash` | `(bytes32 orderHash, address filler)` | — | `nonReentrant` (ai cũng gọi) |
| `releaseRegistration` | `(bytes32 orderHash, address filler)` | — | `nonReentrant` (ai cũng gọi) |
| `withdraw` | `(address payable to)` | — | `nonReentrant` |
| `hasValidRegistration` | `(bytes32 orderHash, address filler, uint256 fillAmount)` | `bool` | view |
| `setReactor` | `(address _reactor)` | — | `DEFAULT_ADMIN_ROLE`, 1 lần |
| `setStakeConfig` | `(StakeConfig c)` | — | `PARAM_ADMIN_ROLE` |
| `commitPending` | `()` | — | external (ai cũng gọi) |
| `cancelPendingConfig` | `()` | — | `GUARDIAN_ROLE` |
| `rollback` | `()` | — | `GUARDIAN_ROLE` |
| `pendingConfig` | `()` | `StakeConfig` | view |
| `stakeConfig` | `()` | `StakeConfig` | view |

#### FallbackExecutor (lưới an toàn)
| Hàm | Tham số | Trả về | Quyền |
|---|---|---|---|
| `setRouterAllowed` | `(address router, address approveTarget, bool allowed)` | — | chỉ owner |
| `executeFallback` | `(SignedOrder order, address router, bytes routeCalldata, uint256 minAmountOut)` | — | `nonReentrant` |

#### DynamicStakeLib (thư viện cọc — hàm `public`)
| Hàm | Tham số | Trả về |
|---|---|---|
| `defaultStakeConfig` | `()` | `StakeConfig` |
| `requiredStake` | `(StakeConfig cfg, uint256 notionalEth, uint256 deadline)` | `uint256` |
| `requiredStakeByTimestamp` | `(StakeConfig cfg, uint256 notionalEth, uint256 deadline)` | `uint256` |
| `computeCollateral` | `(uint256 notionalEth, uint256 deadline, StakeConfig cfg)` | `uint256` |
| `computeRegistration` | `(StakeConfig cfg, uint256 notionalEth, uint256 deadline)` | `(uint256 required, uint32[] refundRow, uint256[] ratioSnapshot)` |
| `computeRefund` | `(uint256 stakeAmount, uint256 actualFillAmount, uint256 committedFill, uint32[] refundRow, uint256[] ratioThresholds)` | `uint256` |
| `worstCaseKappaBps` | `(StakeConfig cfg)` | `uint256` |
| `validate` | `(StakeConfig c, uint32 minRate, uint32 maxRate, uint32 maxRefundBps, uint256 maxBuckets, uint256 minKappaBps)` | — (revert nếu sai) |
| `guardCheck` | `(StakeConfig old, StakeConfig newCfg, uint256 maxDeltaBps, uint256 minPenaltyBps, uint256 maxRefundBps)` | `bool isLoosening` |
| `getOrderSizeBucketETH` / `getFillRatioBucket` / `getTimeBucket` | (bucket helpers) | `uint8` |

*Struct* `StakeConfig{ uint256[] sizeThresholds; uint32[] collateralRate; uint256[] timeThresholds; uint32[] timeMult; uint256[] ratioThresholds; uint32[] refundTable; uint256 minCollateral }`

#### UniswapV3NotionalOracle (định giá cọc, on-chain)
| Hàm | Tham số | Trả về | Ghi chú |
|---|---|---|---|
| `quoteEthNotional` | `(address token, uint256 amount, uint24 feeTier)` | `uint256` | TWAP `twapWindow` giây trên pool (token, wrappedNative) |

*Thư viện phụ:* `DecayCursorLib` (init/getCurrentPrice/reset — đường giá decay) · `RemainingLib` (remaining/pack/fullyFilled/isNewOrder — đóng gói lượng còn lại) · `ScaledOutputLib.scaleOutput(...)` — chia output theo tỉ lệ, đều là `internal`.

### B. SETTLEMENT — CROSS-CHAIN

#### EscrowSrcFactory (chain nguồn)
| Hàm | Tham số | Trả về | Quyền |
|---|---|---|---|
| `fillSlot` | `(OrderInfo info, bytes swapperSig, FillAuth auth, bytes perFillSig)` | `address escrow` | `payable nonReentrant` |
| `restoreRemaining` | `(bytes32 orderHash, bytes32 hashlock, uint256 amount)` | — | chỉ clone thật (§12.4) |
| `previewRequiredStake` | `(uint256 fillAmount, address inputToken, uint24 feeTier, uint256 t1)` | `uint256` | view |
| `remainingInput` | `(bytes32 orderHash, uint256 orderAmount)` | `uint256` | view |
| `computeAddress` | `(bytes32 orderHash, bytes32 hashlock)` | `address` | view |
| `isFilled` | `(bytes32 orderHash, bytes32 hashlock)` | `bool` | view |
| `hashOrder` | `(OrderInfo info)` | `bytes32` | pure |
| `hashFill` | `(FillAuth auth)` | `bytes32` | pure |
| `stakeConfig` | `()` | `StakeConfig` | view |

*Struct* `OrderInfo{ address swapper; address inputToken; uint256 inputAmount; address outputToken; uint256 minOutput; uint256 deadlineBase; uint256 nonce; uint24 feeTier }` · `FillAuth{ bytes32 orderHash; bytes32 hashlock; uint256 fillAmount; uint256 t1; uint256 t2 }`

#### EscrowSrc (clone giữ token swapper + bond)
| Hàm | Tham số | Trả về | Quyền |
|---|---|---|---|
| `initialize` | `(bytes32 _hashlock, address _filler, address _swapper, address _token, uint256 _amount, uint256 _expiry, bytes32 _orderHash, address _factory)` | — | `payable`, chỉ factory, 1 lần |
| `withdraw` | `(bytes32 secret)` | — | `nonReentrant` (trả filler) |
| `cancel` | `()` | — | `nonReentrant` (sau T1, trả swapper + bond) |
| `claimEth` | `(address to)` | — | `nonReentrant` (rút ETH pull-payment) |
| `status` | `()` | `string` | view |

#### EscrowDstFactory (chain đích)
| Hàm | Tham số | Trả về | Quyền |
|---|---|---|---|
| `deploy` | `(bytes32 hashlock, address recipient, address token, uint256 amount, uint256 expiry)` | `address escrow` | external |
| `computeAddress` | `(bytes32 hashlock, address filler)` | `address` | view |

#### EscrowDst (clone giữ token filler)
| Hàm | Tham số | Trả về | Quyền |
|---|---|---|---|
| `initialize` | `(bytes32 _hashlock, address _filler, address _recipient, address _token, uint256 _amount, uint256 _expiry)` | — | chỉ factory, 1 lần |
| `claim` | `(bytes32 secret)` | — | `nonReentrant` (trả recipient=swapper) |
| `refund` | `()` | — | `nonReentrant` (sau T2, chỉ filler) |
| `status` | `()` | `string` | view |

### C. FILLER ON-CHAIN (tuỳ chọn) — PartialFillFillerBase
| Hàm | Tham số | Trả về | Quyền |
|---|---|---|---|
| `doRegister` | `(SignedOrder order, uint256 fillAmount)` | — | `payable onlyOwner` |
| `doFill` | `(SignedOrder order, uint256 fillAmount, Step[] steps)` | — | `onlyOwner` |
| `setTargetAllowed` | `(address target, bool allowed)` | — | `onlyOwner` |
| `partialFillCallback` | `(bytes32 orderHash, uint256 fillAmount, address inputToken, address outputToken, uint256 outputAmount, bytes data)` | — | chỉ reactor |
| `withdrawToken` / `withdrawEth` | `(...)` | — | `onlyOwner` |

---

## PHỤ LỤC C — Testcase trên slide ↔ file test (để đọc qua)

> Đường dẫn gốc: `contract/test/`. Mở file rồi tìm đúng hàm `test_...`.

### Slide 13 — Filler cố gian lận
| Ca | File · hàm test |
|---|---|
| Ôm stake rồi bỏ → slash | `adversarial/MevFillerExploits.t.sol::test_registerThenAbandon_isSlashed_noProfit` · `FillAuction.t.sol::test_slash_success` · `FillAuctionTerminalState.t.sol` |
| Thua cuộc đua → releaseRegistration | `adversarial/MevFillerExploits.t.sol::test_frontRunRace_loserReclaimsFullStake` · `AuditFixes.t.sol::test_H1_loserReclaimsStake_andCannotBeSlashed` |
| Sửa startPrice | `adversarial/MevFillerExploits.t.sol::test_tamperStartPrice_rejected` · `AuditFixes.t.sol::test_C1_tamperedStartPrice_rejected` |
| Reentrancy token bẫy | `adversarial/MevFillerExploits.t.sol::test_reentrantOutputToken_reverts` (+ helper `adversarial/ReentrantOutputToken.sol`) |

### Slide 14 — Hoàn stake công bằng
| Ca | File · hàm test |
|---|---|
| Front-run 11% vẫn hoàn đủ | `FrontRunGriefing.t.sol::test_frontRun_11pct_concreteExample` + `testFuzz_frontRun_honestFillerKeepsFullStake` · `FillAuction.t.sol::test_onFillSuccess_shrunkRemainder_fullRefund` |
| Ba mức hoàn cọc | `FillAuction.t.sol::test_onFillSuccess_fullCommitment_refundsFullStake` / `_underDelivery_refundsHalfStake` / `_tinyDelivery_forfeitsMostStake` · `libs/DynamicStakeLibStake.t.sol` |
| Fill 1% + minFillBps | `adversarial/MevFillerExploits.t.sol::test_snipeSmallChunk_fullyRefunded` + `test_minFillBps_blocksDustFill` · `MinFillRemainder.t.sol` |
| Governance nới lỏng | `StakeConfigGuard.t.sol` (`test_setStakeConfig_revert_penaltyFloorBreached_afterGradualLoosening`, `test_rollback_*`, `test_*_cooldown_*`, `test_registrationSnapshot_survivesRatioBucketReshape`) · shape revert: `CoreGuards.t.sol` |
| Fuzz luôn settle | `Settleability.t.sol::testFuzz_alwaysSettleable` · `invariant/FillAuctionInvariant.t.sol::invariant_solvency` |

### Slide 15 — Cross-chain
| Ca | File · hàm test |
|---|---|
| t2 ≤ t1 bị chặn | `crosschain/EscrowSrcFactory.t.sol::test_fillSlot_t2NotGreaterThanT1_reverts` · `crosschain/CrossChainTimelock.t.sol::test_t2NotGreaterThanT1_rejectedAtFillTime` |
| Bỏ cuộc, no double-dip | `crosschain/CrossChainTimelock.t.sol::test_abandonedFill_swapperMadeWholeOnceNoDoubleDip` · `crosschain/EscrowSrcFactory.t.sol::test_cancel_afterExpiry_refundsSwapper_andPaysSwapperBond` |
| Tái dùng hashlock | `crosschain/EscrowSrcFactory.t.sol::test_fillSlot_reusedHashlock_reverts` |
| §12.4 restoreRemaining | `crosschain/EscrowSrcFactory.t.sol::test_refillAfterRestore` + `test_restoreRemaining_revert_notClone` + `test_restoreRemaining_doubleCancel_reverts` |

### Slide 7b — worst-case kappa & Slide 12b — oracle
| Chủ đề | File · hàm test |
|---|---|
| Sàn worstCaseKappa (ép trong `validate`) | `StakeConfigGuard.t.sol` · `CoreGuards.t.sol::test_setStakeConfig_*` · `libs/DynamicStakeLibStake.t.sol` (monotonic, no ceiling-shopping) |
| Thí nghiệm TWAP (12b) | `TwapManipulation.t.sol` · `TwapWindowComparison.t.sol` · `TwapCollateral.t.sol` (chạy fork mainnet, cần `ALCHEMY_RPC_URL`) |

### Test "rẻ" (gộp 1 dòng — không cần đọc kỹ)
`CoreGuards.t.sol` (27 guard/shape revert) · `RegistrationForgery.t.sol` · `libs/*.t.sol` (DecayCursor/Remaining/ScaledOutput/DynamicStakeLib — toán thư viện) · `PartialFillReactor.t.sol` / `FillAuction.t.sol` (happy-path) · `FallbackExecutor.t.sol` (11 test lưới an toàn) · `FeeOnTransfer.t.sol` · `CompletionFloor.t.sol` · `adversarial/MultiOrderScenario.t.sol`.

> Chạy nhanh 1 file: `forge test --match-path "test/adversarial/MevFillerExploits.t.sol" -vv` (từ thư mục `contract/`, qua WSL: `export PATH=$PATH:/home/nguot/.foundry/bin`).
