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

## 4. Thang bốn bậc ESP-DL trên đồ thị cuối — 14/10 (E9-T35, E9-T36, E9-T38)

`make quant-ptq`, `quant-int16`, `quant-qat ALLOW_TRAIN=1`, `quant-variants` trên run `20260923-2106_59828c4_9a6954`
(MobileFaceNet-ECA nhập từ FRBench), sau mọi bản vá tốc độ của `latency.md` §14.8–14.18. Thước là mô phỏng ESP-PPQ
của chính đồ thị xuất; thước chính là TAR@FAR 1e-3 trên CFP-FP, cửa là sụt dưới 1% so với Q0, tức ≥ 0,822. Giờ trên
chip là `make ai-unit` của chính hàng.

| Bậc | Hàng | **CFP-FP TAR@1e-3** | CFP-FP TAR@1e-4 | AgeDB-30 TAR@1e-3 | LFW TAR@1e-3 | Cửa | Giờ trên chip |
|---|---|---:|---:|---:|---:|---|---:|
| 0 | `float` | **0,830** | 0,813 | 0,895 | 0,995 | — | — |
| 2 | `minmax` | **0,607** | 0,520 | 0,775 | 0,985 | trượt | — |
| 2 | `percentile` | **0,768** | 0,693 | 0,836 | 0,995 | trượt | — |
| 2 | `mse` | **0,757** | 0,746 | 0,802 | 0,991 | trượt | — |
| 2 | `kl` | **0,775** | 0,740 | 0,838 | 0,995 | trượt | — |
| 3 | `int16_top1` | **0,770** | 0,743 | 0,834 | 0,994 | trượt | — |
| 3 | `int16_top2` | **0,760** | 0,744 | 0,839 | 0,995 | trượt | — |
| 3 | `int16_top4` | **0,768** | 0,723 | 0,830 | 0,994 | trượt | — |
| 3 | `int16_top8` | **0,765** | 0,716 | 0,854 | 0,993 | trượt | — |
| 4 | `qat` | **0,799** | 0,767 | 0,849 | 0,994 | trượt | 245,09 ms |
| 4 | `qat+fused_prelu` | **0,783** | 0,690 | 0,864 | 0,994 | trượt | 218,87 ms |
| 4 | `qat+fused_prelu+prelu_on_input_grid` | **0,677** | 0,495 | 0,688 | 0,991 | trượt | — |

- Bậc 2: không cách hiệu chuẩn nào giữ được CFP-FP; `kl` tốt nhất ở 0,775, `minmax` mất tới 0,224.
- Bậc 3 xếp lớp theo SNR trên `kl`: một tới tám lớp int16 (depthwise và tích chập chiếu của các khối `conv_3`,
  `conv_34`, `conv_4`, `conv_5`) không kéo CFP-FP lên.
- Bậc 4 học 2.000 bước trên `kl`, chưng cất embedding từ mô hình float: loss 0,0021 → ~0,0008, CFP-FP 0,775 → 0,799,
  hàng tốt nhất của thang nhưng còn dưới cửa 0,023.
- Biến thể `+fused_prelu` trên `qat` mất 0,016 CFP-FP nhưng AgeDB lên 0,864, nhanh hơn 26 ms; thêm
  `prelu_on_input_grid` thì CFP-FP rơi xuống 0,677.

**Không hàng nào đạt cửa**, nên luật của KẾ HOẠCH §3.7 không chọn được hàng. Bộ đang deploy từ 24/09 cũng dưới cửa
(CFP-FP 0,756, E9-T35). Hàng recog cuối cùng do chủ repo quyết; ADR-0006 ghi quyết định ấy.
