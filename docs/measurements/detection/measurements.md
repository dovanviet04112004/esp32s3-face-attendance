# Nhánh detection — sổ đo

Mọi số đã đo được của nhánh detect, kèm điều kiện đo. Số chưa chạy trên board đánh dấu 🔬.

Bảng đối chứng KD (A0 vs A3) theo §3.7 có nhà riêng là `ablation_teacher.md`; ở đây chỉ
giữ dòng A0 để không phải mở hai file khi đọc.

---

## 1. Các run đã chạy

| Run | Công thức lấy mẫu | Chọn checkpoint | Epoch |
|---|---|---|---|
| `20260831-1216_36bb746_1220e5` — **v1** | `widerface_small` (bản thu 320 px), không crop, không lọc mặt nhỏ | **val loss** | 300 |
| `20260831-1616_cc931df_36fbea` — **v2** | ảnh gốc `WIDER_train`, `crop_scale [0.3, 1.0]`, `min_face_px 8` | **val AP** | 300 |

Giống nhau: kiến trúc YuNet (75.631 tham số), `input_hw [120, 160]`, seed 42, batch 64,
SGD lr 0,02 + nesterov, cosine + 3 epoch warmup, EMA 0,999, `split.lock` v1, 300 epoch.

> **Cảnh báo khi đọc mọi bảng dưới đây.** v1 và v2 lệch nhau **hai** biến: công thức lấy
> mẫu *và* tiêu chí chọn checkpoint. §3.7 xếp tiêu chí chọn checkpoint vào cột "phải
> giống hệt", nên đây **không phải** ablation một biến. Chênh lệch đo được là của cả cặp.
> Để tách được, phải chấm lại v1 bằng chính tiêu chí AP — chưa làm.

---

## 2. WIDER FACE val, giao thức chính thức

Chấm bằng `eval.py`, giao thức `evaluation.m` của tác giả (chuẩn hoá điểm toàn tập, tập
độ khó làm ignore-mask, bao lồi VOC AP).

| | easy | medium | hard |
|---|---|---|---|
| Mục tiêu KẾ HOẠCH | 0,884 | 0,866 | 0,750 |
| v1 (epoch 150, `best.pth`) | **0,6407** | **0,4342** | **0,1844** |
| v1 (epoch 300) | 0,6291 | 0,4259 | 0,1814 |
| v2 (epoch 300, `best.pth`) | **0,6439** | 0,3664 | 0,1524 |

`best.pth` của v2 đạt val AP **0,7845**. Đường cong bão hoà từ epoch ~165: 0,7735 ở
epoch 165 so với 0,7845 ở epoch 300 — 135 epoch cuối đổi lấy 0,011 AP.

Cùng trọng số v1 chấm ở 480×640 cho 0,584 / 0,607 / 0,474 — hard gấp **2,6 lần**. Kích
thước đầu vào mới là ràng buộc, không phải cách train.

---

## 3. Vì sao mục tiêu 0,750 không đạt được ở 160×120

Phân bố cạnh khuôn mặt sau khi letterbox ảnh WIDER val về 160×120:

| Tập | Trung vị (px) | Ghi chú |
|---|---|---|
| easy | 10,4 | |
| medium | 7,1 | quá nửa nằm dưới sàn 8 px |
| hard | 3,1 | **48,8% dưới 3 px** |

Với dải gán prior cũ, 85,5% khuôn mặt nhỏ hơn một ô lưới stride-8, và số prior dương
theo tầng là: tầng 0 — 5.860 (98,8%), tầng 1 — 917 (1,2%), **tầng 2 — 0 (0,0%)**. Một
phần ba pyramid chưa từng nhận gradient.

Nâng đầu vào là đường duy nhất, nhưng bị SRAM chặn 🔬:

| Đầu vào | 🔬 Arena ước tính | Ngân sách `arena_fast` |
|---|---|---|
| 160×120 | ~150 KB | ~175 KB, **dùng chung với anti-spoof** |
| 240×180 | ~337 KB | vượt |
| 320×240 | ~600 KB | vượt |

Detect chạy mỗi frame nên không đẩy sang PSRAM được. Kích thước đầu vào bị khoá bởi
SRAM, không bởi thời gian train.

---

## 4. So hai công thức trên cùng miền khuôn mặt

Giới hạn ground truth theo cạnh mặt **tại đầu vào 160×120**. Mặt dưới sàn không tính
đúng cũng không tính sai — đúng ngữ nghĩa ignore-mask của WIDER; tính là dương tính giả
thì hoá ra phạt model vì tìm thấy mặt thật.

| Sàn (px) | Số mặt | v1 | v2 |
|---|---|---|---|
| 0 (= WIDER gốc) | 39.708 | **0,1485** | 0,1227 |
| 4 | 13.201 | **0,4384** | 0,3691 |
| **8** (sàn huấn luyện của v2) | 5.266 | 0,7283 | **0,7763** |
| 16 | 1.608 | 0,8290 | **0,8447** |
| **32** (cỡ mặt ở kiosk) | 411 | 0,7610 | **0,8595** |

Điểm cắt nằm đúng ở sàn 8 px mà `min_face_px` đặt ra. Dưới sàn v1 thắng, từ sàn trở lên
v2 thắng và khoảng cách nới theo kích thước: +6,6% ở 8 px, +1,9% ở 16 px, **+12,9% ở
32 px**. Ba số WIDER ở §2 là cột sàn 0 nhìn từ một đầu; +12,9% là cùng dữ kiện nhìn từ
đầu kia.

---

## 5. Điểm vận hành ở điều kiện kiosk

Ảnh WIDER val có 1–3 mặt, mọi mặt ≥ 16 px tại đầu vào: 815 ảnh (652 · 131 · 32).
Checkpoint v2 epoch 300.

| conf | recall | bắt đủ khung | khung thừa/ảnh |
|---|---|---|---|
| 0,10 | 0,954 | 0,944 | 2,980 |
| 0,20 | 0,929 | 0,912 | 0,508 |
| **0,30** | **0,911** | **0,890** | **0,139** |
| 0,40 | 0,863 | 0,840 | 0,045 |
| 0,50 | 0,760 | 0,735 | 0,011 |
| 0,70 | 0,445 | 0,421 | 0,001 |
| 0,90 | 0,000 | 0,000 | 0,000 |

Model không bao giờ ra điểm trên 0,9 — phân bố điểm bị nén, đặc trưng focal loss. Lấy
ngưỡng 0,5 theo thói quen mất 15% recall không đổi lấy gì. Ngưỡng 0,30 là chỗ recall
còn 0,911 mà chỉ một khung rác mỗi 7 hình.

Theo số mặt trong khung, ở ngưỡng 0,30:

| Số mặt | Ảnh | Recall/mặt | Bắt đủ khung | Khung thừa/ảnh |
|---|---|---|---|---|
| 1 | 652 | 0,908 | 0,908 | 0,118 |
| 2 | 131 | 0,920 | 0,840 | 0,229 |
| 3 | 32 | 0,906 | 0,719 | 0,188 |

Recall trên **từng** khuôn mặt phẳng ở 0,91–0,92 bất kể khung có mấy người: thêm mặt
không gây nhiễu. Cột "bắt đủ khung" tụt chỉ vì nhân dồn — 0,91² = 0,826 so với 0,840 đo
được, 0,91³ = 0,753 so với 0,719 đo được.

Siết sàn về đúng cỡ mặt kiosk (≥ 32 px, 303 ảnh), ngưỡng 0,30:

| Số mặt | Ảnh | Recall/mặt | Bắt đủ khung | Khung thừa/ảnh |
|---|---|---|---|---|
| 1 | 279 | **0,946** | **0,946** | 0,065 |
| 2 | 19 | 0,921 | 0,842 | 0,263 |
| 3 | 5 | 0,867 | 0,600 | 0,400 |

Ca 2 và 3 mặt ở sàn 32 px chỉ có 19 và 5 ảnh — **không đủ để kết luận**, đọc bảng sàn
16 px ở trên thay thế. Ca kiosk thật là một người: 0,946.

---

## 6. Bảng đối chứng A — có teacher hay không (§3.7)

| Arm | Cách train | val AP | WIDER easy/medium/hard | INT8 trên `test_device` |
|---|---|---|---|---|
| **A0** | task loss, không teacher | 0,7845 | 0,6439 / 0,3664 / 0,1524 | chưa chạy |
| **A3** | A0 + logit + feature + localization + FGD | — | — | — |

A3 chưa chạy được: `detection_kd_logit` cần soft target là `HeadOutput` trên prior của
student, còn `Yolo26PoseTeacher` trả `TeacherDetections`; và FGD cần feature map của
teacher ở cùng độ phân giải với student, trong khi teacher chạy 640² còn student chạy
160×120. Hai việc này là **E4-T13**.

Quy tắc chọn của §3.7 là accuracy **sau INT8 trên `test_device`**, nên bảng này chưa
chốt được arm nào, và chưa được viết ADR.

---

## 7. Còn nợ

- Chấm lại v1 theo tiêu chí AP để tách hai biến ở §1.
- E4-T13 → chạy arm A3 → điền nốt §6.
- Thang lượng tử hoá §3.8, `quant_ladder.md`.
- Cổng nghiệm thu của nhánh đang là WIDER hard ≥ 0,750, tức cột sàn 0 ở §4 — không đạt
  được ở 160×120. Cần quyết định đổi sang thước đo trên miền khuôn mặt nhánh này phục vụ.

Ngưỡng tin cậy **0,30** đo ở §5 là giá trị đề nghị, không phải hằng số trong code: theo
§4.9 nó nằm ở NVS trên kiosk và đổi được bằng `SET_CONFIG`, khai ở
`contracts/schema/device_cmd.schema.json` dưới khoá `detectThreshold`.
