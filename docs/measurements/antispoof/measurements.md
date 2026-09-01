# Nhánh anti-spoof — sổ đo

Mọi số đã đo được của nhánh chống giả mạo, kèm điều kiện đo. Số chưa chạy trên board
đánh dấu 🔬.

---

## 1. Mirror của CelebA-Spoof chia sẵn ba split, và `valid` không đo được gì

Nguồn là `Ar4ikov/celebA_spoof` — bản đóng gói lại thành parquet, **không phải layout gốc**.
`metas/` rỗng nên không có nhãn identity, cũng không có nhãn kiểu tấn công; cột `Class`
chỉ còn `live`/`spoof`.

Đo trên chính ảnh nguồn, 600 ảnh trải đều bốn parquet mỗi split:

| Split | Độ phân giải | Trung vị KB | < 150 KB | > 300 KB | live |
|---|---|---|---|---|---|
| train | 450×600 | 72,2 | **98,0%** | 1,3% | 34,4% |
| valid | 450×600 | 75,9 | **97,2%** | 1,7% | 34,6% |
| **test** | 480×600 | **415,6** | 4,5% | **86,8%** | 27,8% |

`train` và `valid` trùng nhau trên cả ba chiều — cùng độ phân giải, cùng mức nén, cùng tỉ
lệ lớp. Chúng là **một mẻ**. `test` là mẻ khác: cùng số điểm ảnh nhưng nặng gấp 6 lần, tức
nén nhẹ hơn hẳn.

Hệ quả: **`valid` đo độ khớp trong phân bố, không đo khả năng tổng quát hoá.** Một model
tự do đọc vết nén JPEG sẽ đọc vết nén — ảnh chụp lại màn hình rồi nén mạnh có chữ ký rất
riêng, và mọi đòn tấn công trong mẻ train đều mang chữ ký đó.

Điều tra đầy đủ, chạy lại được: [`ml/notebooks/01_celeba_spoof_splits.py`](../../../ml/notebooks/01_celeba_spoof_splits.py).

### Split đang dùng

| | Spec | Shard | Bản ghi |
|---|---|---|---|
| train | `train` | 210 | 419.935 |
| val | `test:0:10` | 10 | 20.000 |
| test | `test:10:` | 20 | 39.191 |

`valid` của mirror **bỏ không dùng**. Cắt theo shard mua được tính lặp lại, **không** mua
được tách biệt danh tính: không có nhãn identity, và thứ tự của mirror đã trộn sẵn hai
lớp, nên một người vẫn có thể nằm cả hai bên.

---

## 2. Teacher CDCN++ — run đầu đã bỏ

Run `20260831-1844`, 30 epoch, EER 0,0134 trên `valid` cũ. **Con số đó không dùng được**,
và bản thân checkpoint cũng không:

- `best.pth` chọn ở epoch 25 theo EER trên mẻ `valid` — tiêu chí chọn mù với tổng quát hoá.
- Train **không có augment nén**, nên nó vẫn học vết nén làm dấu hiệu.

Chấm lại chính checkpoint đó trên mẻ test (giao thức: ngưỡng chốt trên val, áp nguyên sang
test):

| | AUC | EER | APCER | BPCER | ACER |
|---|---|---|---|---|---|
| `valid` cũ | 0,9984 | 0,0134 | — | — | — |
| **test** | **0,9384** | **0,1365** | **0,4028** | 0,0147 | **0,2087** |

Hình dạng lỗi là chẩn đoán: **BPCER 1,5% mà APCER 40%** — mặt thật vẫn nhận tốt, còn 40%
đòn tấn công lọt. Đó là chữ ký của một dấu hiệu bề mặt không chuyển miền được, không phải
của một model kém toàn diện.

Teacher phải chạy lại. Bản chạy lại tự thừa hưởng split mới, augment nén, EMA fused và
`compile`.

---

## 3. Augment nén — cách chữa

Mỗi crop được mã hoá lại JPEG ở chất lượng bốc ngẫu nhiên trong `[30, 95]`, xác suất 0,5,
**chỉ khi train**. Hai view cùng một chất lượng vì chúng là một cảnh. Augment vào split
dùng để chọn checkpoint sẽ làm dịch chuyển chính cái đích, nên val/test không bao giờ bị.

Giá phải trả, đo trên reader: **4.211 → 3.951 ảnh/s** (−6%), trong khi bước train chỉ tiêu
thụ ~1.735, nên nó không thành nút thắt.

---

## 4. Chi phí một bước, và ba lần sửa

Đo ở batch 96, 120 bước sau 30 bước làm nóng:

| Cấu hình | ảnh/s |
|---|---|
| loader riêng | 4.181 |
| step thuần | 1.659 |
| step + clip + EMA (gốc) | **1.299** |
| … EMA fused | 1.545 |
| … + `compile` | **1.873** |
| … + `reduce-overhead` | 2.145 |

Ba thứ tìm ra khi soi vì sao main process ghim 105% CPU còn GPU chỉ 57%:

1. **`ModelEma.update`** dựng lại cả hai `state_dict` mỗi bước rồi lặp Python từng tensor
   với `mul_` + `add_` — hàng trăm kernel tí hon mỗi bước. Ăn **22%** của bước; sau khi gộp
   bằng `_foreach_*` còn **5%**. Phép toán không đổi: test so bằng `torch.equal`.
2. **`compile` chưa từng được bật cho nhánh này** — nó nằm ở config recognition. Trớ trêu
   là nhánh model nhỏ nhất, nơi overhead Python nặng nhất, lại là nhánh thiếu nó.
3. **`reduce-overhead` (CUDA graphs)** hơn thêm 15% trên benchmark, **không bật**: tỉ lệ
   benchmark→thực tế đo được là 63%, nên thực tế chỉ còn ~9%, mà §3.7 buộc bật cho cả arm
   A3 dài ~13 giờ và graph capture đòi shape tĩnh.

Epoch thật: **7 phút 19 → 4 phút 35** (−37%).

> Con số "4 phút/epoch" trong config trước đây lấy từ micro-benchmark trên dữ liệu tổng
> hợp, chưa từng có epoch nào chạy như thế. Mọi số ở mục này ghi rõ là benchmark hay là
> epoch thật.

---

## 5. Bảng đối chứng A — có teacher hay không (§3.7)

| Arm | Cách train | AUC val | EER val | ACER trên `test:10:` |
|---|---|---|---|---|
| **A0** | task loss, không teacher | đang chạy | đang chạy | chưa |
| **A3** | A0 + logit + depth map + contrastive depth | chưa chạy | chưa chạy | chưa |

Cổng nhánh: **ACER < 5%** sau INT8.

Diễn biến A0 (`20260901-0717`, 60 epoch):

| epoch | AUC | EER |
|---|---|---|
| 1 | 0,9261 | 0,1554 |
| 3 | 0,9438 | 0,1352 |

---

## 6. Còn nợ

- Chạy hết A0 → chấm `eval.py` → điền §5.
- Chạy lại teacher → chạy A3 → điền §5 → ADR.
- **HTER khác miền** trên bốn bộ đã tải mà chưa dùng: NUAA (ảnh in), UniqueData live +
  replay, AxonData (mặt nạ latex/silicone, 9 kiểu tấn công). Đây là đường duy nhất biết
  model thua kiểu tấn công nào, vì mirror đã vứt nhãn kiểu.
- `export_soft_target.py`, `postproc/preproc.py`, `postproc/emit_golden.py`, `quant.py`,
  `README.md` — §4.4 đã khai, chưa viết.
- Thang lượng tử hoá §3.8.
