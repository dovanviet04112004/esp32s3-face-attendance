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

| Arm | Cách train | AUC val | EER val | **ACER trên `test:10:`** |
|---|---|---|---|---|
| **A0** | task loss, không teacher | 0,9605 | 0,1064 | **0,0973** |
| **A3** | A0 + logit + depth map + contrastive depth | chưa chạy | chưa chạy | chưa |

Cổng nhánh: **ACER < 5%** sau INT8. A0 trượt khoảng hai lần.

### A0 — `20260901-0717_b326cd5_6706a4`, 60 epoch, best ở epoch 47

Chấm bằng `eval.py`, ngưỡng chốt trên `test:0:10` rồi áp nguyên sang `test:10:`:

| | n | AUC | APCER | BPCER | ACER |
|---|---|---|---|---|---|
| val `test:0:10` | 20.000 | 0,9605 | — | — | EER 0,1064 |
| **test `test:10:`** | 39.191 | **0,9698** | **0,0863** | **0,1082** | **0,0973** |

Hai lớp lỗi giờ **cân nhau** (0,086 so với 0,108), khác hẳn teacher cũ (0,403 so với 0,015). Đường
tắt vết nén đã bị chặn.

**BPCER 0,1082 đáng lo ngang APCER**: cứ 9 lần chấm công thật thì 1 lần bị từ chối. Với
kiosk, phiền hơn việc lọt vài đòn tấn công.

Đường cong val (EER, val mỗi 2 epoch): 0,1554 → 0,1352 → 0,1297 → 0,1290 → 0,1307 →
0,1173 → 0,1261 → 0,1122 → … → **0,1064 (epoch 47)** → 0,1279 (epoch 59). Đáy ở epoch 47,
đúng đoạn cosine kéo LR xuống mạnh; 12 epoch cuối đi ngược. Val loss leo đều 0,52 → 1,83
trong khi train loss rơi 0,042 → 0,0023 — nhớ tập train, nhưng `best.pth` giữ đúng đáy.

---

## 6. Chẩn đoán khác miền — model thua kiểu tấn công nào

Chấm A0 trên hai bộ ngoài, **ở ngưỡng mà tập nhà đã chọn** (0,997355). Fit lại ngưỡng trên
bộ ngoài sẽ đo "bộ đó dễ hay khó" thay vì đo khả năng chuyển miền.

Mặt do chính nhánh detect tìm (`xdomain_crop.py`), không lấy box ground-truth: crop mà
kiosk không tự tạo ra được thì không phải phép thử công bằng. **100% ảnh dò được mặt** ở
cả hai bộ, kể cả trên mặt nạ silicone và ảnh phát lại.

### NUAA — ảnh in, miền hoàn toàn khác

| n | AUC | EER | APCER | BPCER | HTER |
|---|---|---|---|---|---|
| 5.110 | **0,9992** | **0,0114** | **0,0006** | 0,1987 | 0,0996 |

Chuyển miền **rất tốt**: webcam 2010, camera khác, nén khác, mà EER tốt hơn trên chính
CelebA-Spoof **8 lần** và chặn 99,94% đòn tấn công. HTER 0,0996 gần như toàn bộ đến từ
BPCER — ngưỡng nhà (0,9974, rất chặt) không mang sang được phân bố ảnh live của NUAA.

**Đây là bằng chứng bác bỏ giả thuyết "9,7% là do lệch miền dữ liệu".**

### AxonData — APCER theo từng kiểu tấn công

| Kiểu | n | APCER |
|---|---|---|
| cut-out | 120 | **0,0000** |
| replay mobile | 80 | 0,0125 |
| 3D paper mask | 288 | 0,0312 |
| replay display | 45 | 0,0667 |
| wrapped 3D paper | 80 | 0,0875 |
| **textile 3D mask** | 184 | **0,2500** |
| **silicone mask** | 88 | **0,3523** |
| **latex mask** | 80 | **0,5875** |

Ranh giới sạch: **mọi tấn công phẳng đều bị chặn** (0–8,75%), **mặt nạ vật liệu 3D lọt ồ ạt**
(25–59%).

Nguyên nhân là **lỗ hổng phủ, không phải lỗi học**: CelebA-Spoof không chứa một mặt nạ 3D
nào. Và depth map **không cứu được** loại này — mặt nạ latex đeo trên mặt có gò nổi thật,
đúng đặc trưng mà teacher CDCN++ học, nên teacher cũng bị lừa. Depth map là thuốc cho tấn
công **phẳng**, mà tấn công phẳng thì A0 đã giải xong.

Không train được trên Axon: **đa dạng bằng 2** — latex có đúng 2 chiếc mặt nạ (Mask_6,
Mask_8), silicone 2, textile 2 người; phía live chỉ 24 ảnh selfie. Các bộ khác trên
HuggingFace (`silicone-mask-dataset` 58 video, `mask-face-anti-spoofing-dataset` 53 mẫu)
đều là mẫu quảng cáo, bản đầy đủ bán thương mại, và **cùng một nhà cung cấp AxonData** nên
train chéo giữa chúng vẫn quẩn trong một miền.

BPCER 0,4167 trên selfies tính trên **24 ảnh** (mỗi ảnh 4,2%) — nhiễu cộng lệch ngưỡng,
không kết luận được gì.

**Kết luận phạm vi**: mặt nạ 3D nằm ngoài mô hình mối đe doạ của kiosk điểm danh, được ghi
nhận thành giới hạn đã định lượng. Hướng khắc phục nếu cần sau này: NIR (da và latex phản
xạ hồng ngoại khác nhau) hoặc rPPG (latex không có mạch đập) — cả hai đều đụng §2, §5, §6
nên phải qua §1.2.

---

## 7. Còn nợ

- Chạy lại teacher (`20260901-1239`, đang chạy) → chạy A3 → điền §5 → ADR.
- **A0 chưa có bản đối chứng tắt augment nén.** Đã đo rằng nó không phá hỏng gì, nhưng
  chưa đo rằng nó giúp. Muốn chắc thì cần một run A0 với `recompress_probability: 0`.
- UniqueData live + replay: hai bộ khác miền còn lại chưa chấm, cả hai là video nên cần
  giải khung hình như Axon.
- `export_soft_target.py`, `postproc/preproc.py`, `postproc/emit_golden.py`, `quant.py`,
  `README.md` — §4.4 đã khai, chưa viết.
- Thang lượng tử hoá §3.8.
