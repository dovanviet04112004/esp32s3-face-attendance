# Nhánh recognition — sổ đo

Mọi số đã đo được của nhánh nhận dạng, kèm điều kiện đo. Số chưa chạy trên board đánh
dấu 🔬.

Arm A0 đã chạy đủ 10 epoch (§4.1). Arm A3 chưa chạy, nên §4 chưa kết luận được gì.

---

## 1. Dữ liệu

| Hạng mục | Đo được |
|---|---|
| MS1M-RetinaFace, số bản ghi | **4.660.302** |
| Thời gian đếm lần đầu | **31 phút** |

Số đếm được ghi cạnh shard ở `record_counts.json`, nên chỉ trả giá 31 phút một lần.

Một batch không được là một danh tính: loader đọc **4 shard luân phiên** rồi mới gộp
batch. Đọc tuần tự từng shard sẽ cho ra batch gần như thuần một người, và ArcFace không
học được gì từ batch như thế.

Benchmark đánh giá: **LFW · CFP-FP · AgeDB**, chấm bằng giao thức verification chuẩn của
InsightFace — ngưỡng chốt trên 9 fold rồi chấm fold thứ 10, nên accuracy báo ra không phải
accuracy của ngưỡng vừa khớp vào đáp án.

### Split của nhánh này lành, đã kiểm

Sau khi phát hiện `valid` của anti-spoof đo trên cùng mẻ với train, split recognition được
kiểm lại:

- Chia **theo `person_id`**, identity-disjoint, 84.088 danh tính train / 9.343 val.
- Val **không** chấm trên split đó mà trên **ba benchmark độc lập, công bố sẵn**, nên
  không thể có chuyện val cùng phân bố với train.

Bảy file `.bin` có đủ trên đĩa: `lfw`, `cfp_fp`, `agedb_30`, `calfw`, `cplfw`, `cfp_ff`,
`talfw`.

### Tiêu chí chọn checkpoint: `cfp_fp_tar@far0.001`

**Bộ nào**: CFP-FP. LFW chạy tới 99,8% với model loại này và chỉ có 6.000 cặp, nên một phần
mười điểm ở đó bằng **6 cặp** — xếp hạng bằng nhiễu, đúng ở những epoch cuối quan trọng
nhất. CFP-FP khó nhất trong ba bộ (~93–95%), còn phân biệt được tới cuối.

**Đại lượng nào**: TAR@FAR, không phải accuracy. Accuracy của benchmark verification đo tại
ngưỡng làm chính accuracy lớn nhất — điểm cân bằng, vì cả ba bộ đều 50/50 cặp đúng/cặp sai.
**Cửa điểm danh không bao giờ chạy ở điểm đó.** Nhận nhầm người lạ là ghi sai chấm công và
mở cửa cho người lạ; không nhận ra nhân viên là đứng thử lại. Hai chi phí lệch hẳn nhau nên
điểm vận hành nằm ở FAR thấp, và §1.1 đã nói cửa quan tâm TAR@FAR. Chọn model tại một điểm
vận hành khác điểm sẽ dùng là chọn nhầm.

**FAR nào**: 1e-3. Trên 3.500 cặp âm của CFP-FP, ngân sách là `floor(1e-3 × 3500)` = **3**
lần chấp nhận sai — thô, nhưng không suy biến. Ở 1e-4 ngân sách là **0**, tức một cặp duy
nhất định đoạt cả thứ hạng.

**Không chọn trung bình TAR@1e-3 của ba bộ** dù ngân sách gộp là 9: LFW đã bão hoà ở 0,99
nên chỉ làm loãng, còn AgeDB dao động 0,05 giữa hai epoch liền nhau (0,5877 → 0,5333) nên
gộp vào là để bộ nhiễu nhất lái quyết định.

§3.7 xếp tiêu chí chọn checkpoint vào cột phải giống hệt giữa hai arm, nên nó chốt trước khi
A3 chạy. Đổi tiêu chí **không** làm bảng §4.1 phải đo lại — mọi cột đã ghi sẵn cho từng
epoch; nó chỉ đổi checkpoint được chọn, và cả hai checkpoint đã nằm trên đĩa.

---

## 2. Thông lượng

| Cấu hình | Đo được |
|---|---|
| `channels_last` | **+17% → +29%** trên cả ba mạng |
| Student, thông lượng train | **859 ảnh/giây** |

`channels_last` phải áp cho **cả tensor đầu vào**, kể cả khi nó là uint8 — áp mỗi model
thì PyTorch chèn một lần chuyển layout mỗi bước và phần lợi mất sạch.

> Một số đo trước đó ghi 77 ảnh/giây. Số đó lấy trong lúc một job batch-256 khác đang
> thrash bộ nhớ máy; đo lại khi máy rảnh cho 859. Giữ lại đây để không ai đi tin con số cũ.

---

## 3. Kích thước model

| Model | Tham số |
|---|---|
| MobileFaceNet (student) | **1.199.488** |
| IResNet50 `w600k_r50` (teacher) | — |

Teacher chạy một lần để **cache embedding 512-D**, sau đó `CachedEmbedding` đứng thay
chỗ nó trong vòng train, nên chi phí teacher không lặp lại mỗi epoch. Embedding được
đánh địa chỉ bằng `__key__` của WebDataset, tức vị trí bản ghi trong RecordIO gốc.

---

## 4. Bảng đối chứng A — có teacher hay không (§3.7)

| Arm | Cách train | LFW / CFP-FP / AgeDB | Accuracy sau INT8 trên `test_device` |
|---|---|---|---|
| **A0** | ArcFace, không teacher | **0,9942 / 0,9583 / 0,9445** | chưa chạy |
| **A3** | A0 + embedding + RKD | chưa chạy | chưa chạy |

Ba số của A0 lấy ở ba epoch khác nhau (10 / 8 / 9) — mỗi bộ đạt đỉnh một chỗ. Checkpoint
chỉ có một, chọn theo `cfp_fp_tar@far0.001`, tức **epoch 10** (§4.2).

Cột phải bỏ trống ở **cả hai** arm cho tới khi có `test_device`. §4.2 của CLAUDE.md chốt
quyết định bằng accuracy sau INT8 trên tập đó, nên bảng FP32 này chưa quyết được gì —
nó chỉ xác nhận đường train chạy đúng.

### 4.1 Arm A0 — toàn bộ 10 epoch

Điều kiện: seed 42, `deterministic: true`, batch 128, SGD momentum 0,9, LR đỉnh 0,0125,
cosine tới 1,25e-5, warmup 1 epoch, AMP fp16, EMA 0,9999, `compile: true`,
`split.lock` `1bed7073…` / `190c3872…`. RTX 3050 Laptop, torch 2.13.0+cu130.
**16 giờ 26 phút** GPU, ~96–103 phút mỗi epoch.

| ep | loss | LFW | CFP-FP | AgeDB | LFW T@1e-3 | CFP T@1e-3 | AgeDB T@1e-3 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 21,57 | 0,9178 | 0,7126 | 0,7457 | 0,5857 | 0,0226 | 0,0383 |
| 2 | 13,83 | 0,9833 | 0,8984 | 0,8793 | 0,9250 | 0,4131 | 0,2720 |
| 3 | 12,63 | 0,9872 | 0,9130 | 0,9047 | 0,9530 | 0,5900 | 0,4270 |
| 4 | 12,24 | 0,9895 | 0,9327 | 0,9160 | 0,9650 | 0,6383 | 0,4390 |
| 5 | 11,16 | 0,9918 | 0,9437 | 0,9250 | 0,9797 | 0,6846 | 0,4390 |
| 6 | 10,19 | 0,9937 | 0,9457 | 0,9323 | 0,9807 | 0,7271 | 0,5460 |
| 7 | 9,40 | 0,9940 | 0,9521 | 0,9402 | 0,9867 | 0,7506 | 0,5480 |
| 8 | 9,06 | 0,9940 | **0,9583** | 0,9432 | 0,9910 | 0,7549 | **0,5877** |
| 9 | 10,38 | 0,9938 | 0,9574 | **0,9445** | 0,9890 | 0,7794 | 0,5333 |
| **10** | 14,29 | **0,9942** | 0,9559 | 0,9428 | 0,9897 | **0,7874** | 0,5613 |

Cột nào cũng đạt đỉnh ở một epoch khác nhau, nên **epoch nào là "tốt nhất" là do tiêu chí
quyết định, không do dữ liệu**. Theo `cfp_fp_tar@far0.001` (§1) thì đó là **epoch 10**.

**Arm bão hoà quanh epoch 8.** Từ đó trở đi mọi bước của accuracy đều nhỏ hơn ¼ độ lệch
chuẩn của chính phép đo (`accuracy_std` ~0,010–0,013). Riêng TAR@1e-3 của CFP-FP vẫn tăng
đơn điệu 0,7549 → 0,7794 → 0,7874 suốt ba epoch cuối; ba bước liên tiếp cùng chiều khó là
nhiễu hơn một bước đơn lẻ, nhưng biên độ vẫn nhỏ và không nên đọc thành "còn học được nhiều".

**Loss tăng 9,06 → 14,29 ở hai epoch cuối không phải model xấu đi.** LR lúc đó đã nằm ở
đáy lịch cosine (~6% đỉnh ở epoch 8,5), tức trọng số gần như đứng yên, trong khi val nhích
lên chứ không tụt. Đây là hiệu ứng thứ tự dữ liệu: loader đọc 4 shard luân phiên nên mỗi
epoch gặp một tổ hợp danh tính khác, và ArcFace scale 64 khuếch đại chênh lệch độ khó giữa
các tổ hợp đó. Loss ArcFace ở đây là loss **train**, không so được giữa hai epoch khác mẻ.

Loss lúc khởi tạo ≈ `30,7 + ln(84088)` ≈ 42; 9,06 là đã đi được phần lớn quãng đường.

**10 epoch không suy ra được 40 epoch.** Ở cùng mốc thời gian thực, một lịch 40 epoch vẫn
đang chạy ở **91%** LR đỉnh — cao gấp 14 lần. Đường cong ở đây là đường cong của một lịch
đã hạ nhiệt xong, không phải khúc đầu của một lịch dài hơn. Muốn biết 40 epoch cho gì thì
phải chạy 40 epoch.

Checkpoint nối qua ba thư mục run (`resumed_from.txt`), do máy sập vì
`cudaErrorUnknown` sau bản driver NVIDIA 591.74:

| Run | Epoch | Giữ gì |
|---|---|---|
| `20260903-2255_f7a6aab_ec1061` | 1–4 | — |
| `20260903-2258_f7a6aab_dad005` | 5–8 | `best.pth` (epoch 8) — tiêu chí cũ |
| `20260904-0932_f7a6aab_7122fb` | 9–10 | **`last.pth` (epoch 10)** — checkpoint dùng |

Tên file đánh lạc hướng ở arm này: `best.pth` là của tiêu chí cũ và nằm ở run **giữa**,
còn checkpoint được chọn là `last.pth` của run **cuối**. §4.2 nói rõ.

### 4.1b Ngưỡng cosine — phân bố điểm của A0

Checkpoint epoch 10, embed có lật ngang, 9.500 cặp cùng người và 9.500 cặp khác người gộp
từ cả ba benchmark:

| Bộ | Cùng người, trung vị | Cùng người, p5 | Khác người, p95 | Khác người, p99,9 |
|---|---|---|---|---|
| LFW | 0,741 | 0,518 | 0,221 | 0,397 |
| CFP-FP | 0,518 | 0,232 | 0,209 | 0,388 |
| AgeDB-30 | 0,510 | 0,241 | 0,262 | 0,472 |

| Ngưỡng | Nhận đúng người thật | Nhận nhầm người lạ |
|---|---|---|
| 0,30 | 93,38% | 1,6316% |
| 0,35 | 89,65% | 0,6526% |
| **0,45** | **76,69%** | **0,0842%** |
| 0,50 | 67,18% | 0,0316% |
| 0,55 | 56,78% | 0,0000% |

FAR 1e-3 rơi vào ngưỡng **0,4283**; đó là căn cứ của hằng số 0,45 trong `live_demo.py`.

**Cột giữa là số bi quan cho mục đích điểm danh.** Benchmark chấm một ảnh với một ảnh, và
CFP-FP là ảnh nghiêng 90° còn AgeDB-30 cách nhau 30 năm. Kiosk so **một khung với template
trung bình 20 khung**, cùng buổi cùng camera cùng người — dễ hơn hẳn. Ngược lại, cột phải là
số **lạc quan**: FAR đo trên một cặp, còn so 1:N thì mỗi người đã đăng ký là một lần rút
thăm, sai số cộng lên xấp xỉ `N × FAR`.

Hai chiều lệch ngược nhau nên **không suy ra được ngưỡng vận hành** từ bảng này. Nó chỉ nói
vùng nào hợp lý để bắt đầu dò.

### 4.2 Checkpoint được chọn

`cfp_fp_tar@far0.001` (§1) chọn **epoch 10**. Trên đĩa, đó là `last.pth` của run cuối
`20260904-0932_f7a6aab_7122fb`.

`best.pth` ở run giữa là **epoch 8**, do tiêu chí cũ ghi ra lúc chạy. Nó vẫn nằm đó và
không xoá được bằng cách đổi hằng số, nên ai lấy checkpoint của arm này phải lấy `last.pth`
của run cuối, không lấy file tên `best.pth`. Run A3 sinh ra sau khi đổi tiêu chí sẽ có
`best.pth` đúng nghĩa.

Chênh lệch giữa hai epoch nhỏ hơn nhiễu, nên đổi tiêu chí gần như không đổi kết quả của
arm này:

| Tiêu chí | Chọn | Hơn epoch nhì |
|---|---|---|
| `cfp_fp_accuracy` | ep 8 | +0,0009 — bằng **1/10** độ lệch chuẩn (0,0100) |
| `cfp_fp_tar@far0.001` | ep 10 | +0,0080 |
| Trung bình TAR@1e-3 ba bộ | ep 10 | +0,0016 |

Ba bộ cũng không đồng ý: LFW và AgeDB đạt đỉnh TAR ở epoch 8, CFP-FP ở epoch 10. Giá trị
của việc chốt tiêu chí nằm ở **bảng A0 vs A3**, nơi khoảng cách có thể vượt nhiễu — không
nằm ở việc xếp hạng hai epoch liền nhau của cùng một arm.

## 5. Ghi chú kỹ thuật đã chốt

- **ArcFace cộng góc**, không qua `acos`: `cos(θ+m) = cosθ·cos m − sinθ·sin m`, có điểm
  gãy tại `cos(π−m)`. Đi qua `acos` mất chữ số ở vùng `cosθ` gần ±1, đúng vùng mà mẫu
  dễ nằm vào cuối quá trình train.
- **RKD** dùng khoảng cách đã chuẩn hoá theo trung bình; đầu gối Huber phải đặt gần đúng
  thang sai số thật, lệch thang thì term này thành hằng số.
- **Cosine similarity bất biến với phép nhân dương từng vector**, nên scale int8 của
  template triệt tiêu và thiết bị so thẳng int8 với nhau, không cần dequant.

---

## 6. Còn nợ

- Chốt tiêu chí chọn checkpoint (§4.2) → cache embedding teacher → chạy arm A3, điền §4.
- `postproc/emit_golden.py`, `quant.py`, `README.md` — §4.4 đã khai, chưa viết.
- Thang lượng tử hoá §3.8, `quant_ladder.md`.
- TAR@FAR trên tập nhân viên tự thu — chưa có dữ liệu.
