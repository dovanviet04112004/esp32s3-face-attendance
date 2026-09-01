# Nhánh recognition — sổ đo

Mọi số đã đo được của nhánh nhận dạng, kèm điều kiện đo. Số chưa chạy trên board đánh
dấu 🔬.

Nhánh này **chưa có run nào chạy**. Dưới đây là số của dữ liệu, của đường nạp, và của
các phép đo thông lượng đã làm để chốt cấu hình loader.

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

### Tiêu chí chọn checkpoint: `cfp_fp_accuracy`

Trước đó là `lfw_accuracy`. LFW chạy tới 99,8% với model loại này và chỉ có 6.000 cặp, nên
một phần mười điểm ở đó bằng **6 cặp** — chọn `best.pth` bằng nhiễu, đúng ở những epoch
cuối quan trọng nhất. CFP-FP khó nhất trong ba bộ (~93–95%), còn phân biệt được tới cuối.

`tar@far` đúng để **báo cáo** (§1.1 nói cửa quan tâm TAR@FAR hơn accuracy) nhưng sai để
**chọn**: ở FAR 1e-4 trên 3.000 cặp âm, ngân sách là `floor(1e-4 × 3000)` = **0** lần chấp
nhận sai, nên nó nhảy theo bậc quá thô để xếp hạng hai epoch liền nhau.

Chốt trước khi arm nào chạy, vì §3.7 xếp tiêu chí chọn checkpoint vào cột phải giống hệt
giữa hai arm.

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
| **A0** | ArcFace, không teacher | chưa chạy | chưa chạy |
| **A3** | A0 + embedding + RKD | chưa chạy | chưa chạy |

---

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

- Cache embedding teacher → chạy arm A0 → arm A3, điền §4.
- `postproc/emit_golden.py`, `quant.py`, `README.md` — §4.4 đã khai, chưa viết.
- Thang lượng tử hoá §3.8, `quant_ladder.md`.
- TAR@FAR trên tập nhân viên tự thu — chưa có dữ liệu.
