# Thang lượng tử hoá — nhánh detect

Bảng đối chứng của KẾ HOẠCH §3.7 cho YuNet `20260831-1616_cc931df_36fbea`. Mỗi dòng đủ 5 cột;
cột nào chưa đo được thì để 🔬 chứ không điền số suy ra.

## 1. Bảng chính — 23/09

Chấm bằng `bench/host_bench.py` trên WIDER FACE val (3.226 ảnh), đầu vào 160×120 letterbox như
firmware; `≥ 38 px` là tập mặt từ `SERVICE_FACE_PX` trở lên ở đầu vào detect, cổng vận hành của
kiosk (E9-T27). Q1 TFLite là file trên `contracts/models.lock.json`; Q1 ESP-DL là PTQ ESP-PPQ
`esp32s3` với layerwise equalization, mô phỏng trên host (latency.md §13.3 cho sai số với chip).

| Q | AP easy | AP medium | AP hard | **AP ≥ 38 px** | Δ ≥ 38 px so với Q0 | Kích thước | Bộ nhớ trên board | Latency board |
|---|---|---|---|---|---|---|---|---|
| Q0 FP32 | 0,6439 | 0,3664 | 0,1524 | **0,9414** | — | 331 KB (ONNX) | — | — |
| Q1 TFLite | 0,6403 | 0,3639 | 0,1513 | **0,9387** | −0,29% | 158 KB | `arena_fast` 189.628 B | 231,5 ms |
| Q1 ESP-DL | 0,6399 | 0,3639 | 0,1513 | **0,9497** | **+0,88%** | 224 KB | 357 KB PSRAM | **63,8 ms** |

Latency là median `ai_engine_detect` chạy riêng, lúc rảnh, profile `bench` (latency.md §13.1).

## 2. Đọc bảng

- Cả hai Q1 đều sụt dưới 1% so với Q0 ở mọi tập — đạt quy tắc chọn của §3.7.
- Easy/medium/hard thấp là vì đầu vào 160×120 ép ảnh WIDER 1024 px xuống hệ số 0,156 (KẾ HOẠCH §3
  lớp 2); đó là giới hạn của độ phân giải, không phải của lượng tử hoá, và ba cột ấy gần như trùng
  nhau giữa ba mốc.
- ESP-DL nhỉnh hơn cả FP32 ở tập ≥ 38 px. Không đọc đó là lượng tử hoá "tốt hơn": chênh 0,009 AP
  nằm trong cỡ nhiễu của một tập đánh giá, và điều duy nhất bảng chốt được là ESP-DL không mất gì.
- File `.espdl` nặng hơn `.tflite` vì mang một cặp vector kiểm thử và đệm kênh bội 16 (KẾ HOẠCH §1.1).

## 3. Thang bốn bậc ESP-DL trên đồ thị cuối — 14/10 (E9-T35, E9-T36, E9-T38)

`make quant-ptq`, `quant-int16`, `quant-qat ALLOW_TRAIN=1`, `quant-variants` rồi `quant-choose` trên run
`20260831-1616_cc931df_36fbea`, sau mọi bản vá tốc độ của `latency.md` §14.8–14.18. Thước là mô phỏng ESP-PPQ của
chính đồ thị xuất trên WIDER val (3.226 ảnh, 160×120 letterbox), cùng tập `≥ 38 px` như §1; bản dò giữ mô phỏng ấy
khớp chip từng bit. Bậc 1 (gập BN, layerwise equalization, bias correction) nằm trong cả bốn hàng bậc 2. Giờ trên
chip là `make ai-unit` của chính hàng, chỉ đo các hàng mà luật chọn cần.

| Bậc | Hàng | AP easy | AP medium | AP hard | **AP ≥ 38 px** | Δ ≥ 38 px so với Q0 | Cửa | Giờ trên chip |
|---|---|---:|---:|---:|---:|---:|---|---:|
| 0 | `float` | 0,6439 | 0,3664 | 0,1524 | 0,9414 | — | — | — |
| 2 | `minmax` | 0,6338 | 0,3595 | 0,1495 | 0,9382 | −0,34% | đạt | — |
| 2 | `percentile` | 0,6379 | 0,3622 | 0,1506 | 0,9471 | +0,60% | đạt | — |
| 2 | `mse` | 0,6352 | 0,3605 | 0,1499 | 0,9544 | +1,38% | đạt | 31,81 ms |
| 2 | `kl` | 0,6401 | 0,3638 | 0,1513 | 0,9534 | +1,27% | đạt | — |
| 3 | `int16_top1` | 0,6367 | 0,3613 | 0,1502 | 0,9541 | +1,34% | đạt | 34,17 ms |
| 3 | `int16_top2` | 0,6375 | 0,3615 | 0,1503 | 0,9502 | +0,94% | đạt | — |
| 3 | `int16_top4` | 0,6356 | 0,3607 | 0,1499 | 0,9446 | +0,33% | đạt | — |
| 4 | `qat` | 0,6328 | 0,3588 | 0,1492 | 0,9488 | +0,78% | đạt | — |
| 2 | **`mse+clip_as_relu`** | 0,6404 | 0,3643 | 0,1515 | **0,9544** | +1,38% | đạt | **31,58 ms** |

- Bậc 2: `mse` cao nhất, `kl` sát sau; `minmax` thấp nhất, vẫn trong cửa.
- Bậc 3 xếp lớp theo SNR trên đồ thị `mse`: thêm lớp int16 không lợi gì, `int16_top4` thấp hơn cả `percentile`.
  Lớp int16 đầu tiên là tích chập 1×1 của `stages.3/unit2`; cặp ấy thôi ghép thành `PointwiseDepthwise` (25 op ghép
  thay vì 26, thêm 2 `Conv` và 1 `Clip`), nên chậm hơn 2,4 ms.
- Bậc 4 học 2.000 bước, chưng cất từ mô hình float: loss 0,146 → ~0,07, nhưng AP ≥ 38 px xuống 0,9488. QAT kéo đồ
  thị về sát mô hình float (0,9414), nên ở thước này nó không thắng.
- Biến thể `+clip_as_relu` đổi cả 18 ReLU6 thành ReLU: đầu ra bão hoà ở đỉnh int8 của lưới (7,94 ở lưới 2^-4) thay
  vì cắt ở 6, nên op ghép bỏ bước kẹp. AP ≥ 38 px bằng `mse` tới chữ số thứ năm, nhanh hơn 0,23 ms.
- Mọi hàng int8 cao hơn Q0 ở tập ≥ 38 px; như §2, không đọc đó là lượng tử hoá "tốt hơn".

**Chọn `mse+clip_as_relu`** theo luật của KẾ HOẠCH §3.7: hàng đạt cửa có AP ≥ 38 px cao nhất (0,954442, hơn `mse`
0,954438), và cũng nhanh nhất trong ba hàng cách nó không quá một bước 0,1 điểm AP (`mse`, `int16_top1`). ADR-0006
ghi quyết định cho cả ba nhánh.
