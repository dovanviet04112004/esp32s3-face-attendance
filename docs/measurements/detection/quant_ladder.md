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
