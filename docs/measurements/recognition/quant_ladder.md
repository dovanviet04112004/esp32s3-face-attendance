# Thang lượng tử hoá — nhánh recog

Bảng đối chứng KẾ HOẠCH §3.7 cho hai run: MobileFaceNet w32 `20260908-1750_ea985b1_bfed2e` (bản
TFLM đang nằm trên `contracts/models.lock.json`) và MobileFaceNet-ECA `20260923-2106_59828c4_9a6954`
(trọng số nhập từ FRBench `mobilefacenet_arcface_ms1m`, bản deploy trên ESP-DL, KẾ HOẠCH §1.1).
Cột nào chưa đo được thì để 🔬 chứ không điền số suy ra.

## 1. Bảng chính — 23/09

Ba bộ benchmark 112×112, 10-fold (ngưỡng khớp trên chín fold, chấm trên fold thứ mười), không lật
ảnh. Mỗi ô là **accuracy / TAR@FAR=1e-3 / TAR@FAR=1e-4**. Q0 chấm bằng
`tasks/recognition/eval.py --run`, Q1 bằng `bench/host_bench.py --runtime {tflite,espdl}`. Q1 TFLite
là đúng file trên lock; Q1 ESP-DL là PTQ ESP-PPQ `esp32s3` có layerwise equalization, mô phỏng trên
host (latency.md §13.3 cho sai số giữa mô phỏng và chip).

| Run | Q | LFW | CFP-FP | AgeDB-30 |
|---|---|---|---|---|
| `1750` w32 | Q0 FP32 | 0,9905 / 0,968 / 0,857 | 0,9189 / 0,656 / 0,572 | 0,9123 / 0,497 / 0,263 |
| `1750` w32 | Q1 TFLite (lock) | 0,9787 / 0,868 / 0,817 | 0,8759 / 0,341 / 0,264 | 0,8805 / 0,281 / 0,198 |
| `1750` w32 | Q1 ESP-DL | 0,9892 / 0,968 / 0,835 | 0,9140 / 0,566 / 0,487 | 0,9098 / 0,424 / 0,190 |
| `2106` MBF-ECA | Q0 FP32 | 0,9963 / 0,995 / 0,993 | 0,9520 / 0,830 / 0,814 | 0,9682 / 0,895 / 0,779 |
| **`2106` MBF-ECA** | **Q1 ESP-DL (deploy)** | **0,9958 / 0,994 / 0,985** | **0,9440 / 0,756 / 0,669** | **0,9565 / 0,841 / 0,768** |

Chỉ số chọn checkpoint của nhánh là CFP-FP TAR@1e-3 (`measurements.md` §1), nên cột Δ tính trên nó:

| Run | Q | Δ CFP-FP TAR@1e-3 so với Q0 | Kích thước | Bộ nhớ trên board | Latency board |
|---|---|---|---|---|---|
| `1750` w32 | Q0 FP32 | — | 2.163 KB (ONNX) | — | — |
| `1750` w32 | Q1 TFLite (lock) | −0,315 (−48%) | 720 KB | `arena_big` 748.524 B chung spoof | 459,0 ms |
| `1750` w32 | Q1 ESP-DL | −0,090 (−14%) | 652 KB | 1.065.504 B PSRAM | 86,0 ms |
| `2106` MBF-ECA | Q0 FP32 | — | 4.712 KB (ONNX) | — | — |
| **`2106` MBF-ECA** | **Q1 ESP-DL (deploy)** | **−0,074 (−9%)** | **1.386 KB** | **2.191.836 B PSRAM** | **302,0 ms** |

Kích thước ONNX là graph đã gập `Linear` + `BatchNorm1d` mà ESP-PPQ đọc. Bộ nhớ ESP-DL là PSRAM model
lấy lúc dựng (trọng số chép + tensor), RAM nội 0 B, đọc từ log `espdl_model` của `bench_ai`.
Latency là median `ai_engine_embed` chạy riêng, lúc rảnh, profile `bench` (latency.md §13.1).

## 2. Đối chiếu với trial 23/09 (luật chấp nhận E9-T29)

| | repo | trial | lệch tối đa |
|---|---|---|---|
| `2106` Q1 ESP-DL | như bảng trên | 0,9958 / 0,994 / 0,985 · 0,9440 / 0,756 / 0,669 · 0,9565 / 0,841 / 0,768 | **0** |
| `2106` Q0 FP32 | như bảng trên | 0,9963 / 0,995 / 0,993 · 0,9521 / 0,830 / 0,814 · 0,9680 / 0,895 / 0,779 | **0,0002** |

Trial dùng bản FRBench còn `expand_as`; repo nhân broadcast (KẾ HOẠCH §3 lớp 2). Q1 trùng đến chữ
số thứ tư, tức bỏ `Expand` không đổi graph lượng tử hoá — đạt ngưỡng ≤ 0,002 (Q1) và ≤ 0,001 (Q0).

## 3. Đọc bảng

- **Không mốc Q1 nào của recog đạt ngưỡng sụt < 1% của §3.7 ở TAR@1e-3 CFP-FP.** Trên ESP-DL, LFW
  gần như không mất; phần mất dồn vào mặt nghiêng và cách tuổi, hai tập mà các cặp khác người sát
  nhau nhất.
- **Cùng một model w32, ESP-DL mất ít hơn TFLite 3,5 lần**: CFP-FP TAR@1e-3 rơi 0,090 so với 0,315,
  còn 0,566 so với 0,341. File TFLite đang nạp mất gần nửa chỉ số chọn của nhánh.
- **`2106` sau INT8 vẫn hơn mọi mốc của `1750`, kể cả FP32 của nó**: CFP-FP TAR@1e-3 0,756 so với
  0,656, AgeDB 0,841 so với 0,497. Cái giá là 3,5 lần thời gian trên board (302 so với 86 ms) và
  gấp đôi PSRAM.
- `2106` mất nhiều nhất ở TAR@1e-4 (CFP-FP 0,814 → 0,669). Nghi do 15 khối ECA — sigmoid rồi nhân —
  chịu kém scale per-tensor luỹ thừa 2 🔬; chưa thử giữ riêng các khối ấy ở w8a16.
