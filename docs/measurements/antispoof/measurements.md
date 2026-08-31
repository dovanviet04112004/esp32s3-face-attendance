# Nhánh anti-spoof — sổ đo

Mọi số đã đo được của nhánh chống giả mạo, kèm điều kiện đo. Số chưa chạy trên board
đánh dấu 🔬.

Nhánh này **chưa có run nào chạy hết**. Teacher mới qua epoch 0 thì dừng, student chưa
khởi động. Những gì dưới đây là số của dữ liệu, của chi phí một epoch, và của lần sửa
thước đo — không phải kết quả model.

---

## 1. Dữ liệu

| Split | Số bản ghi | Shard |
|---|---|---|
| `train` | 419.935 | — |
| `valid` | 46.738 | 24 |
| `test` | — | — |

Nguồn `data/interim/antispoof/celeba_spoof_crops`, mỗi bản ghi giữ **hai tỉ lệ crop**
(1,0× và 2,7×) trong cùng một record để một lần đọc lấy được cả hai.

Cân bằng lớp trên 768 mẫu đầu của `valid`: **255 live / 513 attack** — tỉ lệ ≈ 1:2, khớp
`live_weight: 1.97` mà `SpoofTaskLoss` đang dùng.

---

## 2. Chi phí

| Hạng mục | Đo được |
|---|---|
| Teacher CDCN++, 1 epoch | **12 phút 38 giây** (13:52:07 → 14:04:45) |
| Teacher, 30 epoch | ≈ **6,3 giờ** |
| Batch / worker | 96 / 8 |
| Depth loss cuối epoch 0 | 0,1583 |

Student MiniFASNetV2-SE: **525.362** tham số, 60 epoch — chưa đo thời gian.

---

## 3. Sửa thước đo ở val

Thước cũ tính ACER tại một ngưỡng cứng `LIVE_THRESHOLD = 0.5`, và `best_metric_key`
chọn checkpoint theo con số đó.

Đo trên teacher **chưa train**, 768 mẫu `valid`:

| Thước | Kết quả |
|---|---|
| ACER tại ngưỡng cứng 0,5 | **0,5000** |
| AUC | **0,6295** |
| EER (ACER tại điểm APCER = BPCER) | **0,3881** |

Điểm liveness của model chưa train nằm trong khoảng **0,000003 → 0,000034**, tức toàn bộ
phân bố nằm dưới ngưỡng 0,5. Mọi mẫu bị gọi là giả mạo, nên `apcer = 0` và `bpcer = 1`
và ACER đứng yên ở 0,5 **bất kể model tốt đến đâu**. Một model tách hai lớp hoàn hảo mà
điểm đều nhỏ vẫn nhận đúng 0,5 — thước không xếp hạng được gì.

AUC 0,6295 cho thấy ngay cả model chưa train đã có tín hiệu yếu trên mức ngẫu nhiên, và
thước cũ không nhìn thấy tín hiệu đó.

Đã đổi: ngưỡng lấy từ **điểm cắt của chính split val** thay vì hằng số, `best_metric_key`
đổi sang `eer`. Hằng số `LIVE_THRESHOLD` bị gỡ — nó là ngưỡng nghiệp vụ gõ thẳng vào
code, trái §6 và §4.9. Ngưỡng đem ship là một quyết định riêng, chốt một lần trên val
rồi giữ nguyên trên test.

Các hàm nằm ở `tasks/antispoof/eval.py` (§4.4 đã khai), phủ bởi 14 test trong
`tests/test_antispoof_eval.py`.

---

## 4. Bảng đối chứng A — có teacher hay không (§3.7)

| Arm | Cách train | EER val | ACER sau INT8 trên `test_device` |
|---|---|---|---|
| **A0** | task loss, không teacher | chưa chạy | chưa chạy |
| **A3** | A0 + logit + depth map + contrastive depth | chưa chạy | chưa chạy |

Cổng nghiệm thu của nhánh: **ACER < 5%** sau INT8.

---

## 5. Còn nợ

- Chạy teacher CDCN++ đủ 30 epoch → `artifacts/antispoof/teacher/cdcnpp_best.pth`.
- Chạy arm A0 rồi A3, điền §4.
- `export_soft_target.py`, `postproc/preproc.py`, `postproc/emit_golden.py`, `quant.py`,
  `README.md` — §4.4 đã khai, chưa viết.
- HTER cross-dataset trên AxonData (có mặt nạ latex 3D) — `eval.py` đã có sẵn hàm, chưa
  có script chạy.
- Thang lượng tử hoá §3.8, `quant_ladder.md`.
