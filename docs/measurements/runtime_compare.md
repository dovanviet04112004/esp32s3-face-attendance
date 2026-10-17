# Bảng đối chứng ba runtime trên ba model đang deploy

> Sinh bằng `make runtime-report` (`ml/bench/runtime_report.py`) từ log `bench_ai`,
> ảnh chụp bản build đã nạp và kết quả chấm trong `ml/artifacts/device/runtime_compare/`,
> commit `ec8631f4`. Không sửa tay: sửa script hoặc đo lại rồi sinh lại.
> Phương pháp ở KẾ HOẠCH §3 lớp 5 (E9-T51).

## Tóm tắt

|  | ESP-DL | TFLM + esp-nn | TFLM, esp-nn bản C |
|---|---|---|---|
| **Một lượt ba model, rảnh (ms)** | **353,6** | **3.717,7** | **17.268,6** |
| Chậm hơn ESP-DL | 1,00× | 10,51× | 48,83× |
| Một lượt, có tải preview (ms) | 406,2 | 3.864,6 | 17.832,0 |
| Ảnh app `bench_ai` (KB) | 1.283,4 | 386,5 | 360,9 |
| RAM tĩnh, DIRAM (KB) | 84,3 | 68,9 | 68,9 |
| PSRAM lấy khi dựng ba model (KB) | 3.574 | 1.158 | 1.158 |
| RAM nội lấy khi dựng ba model (KB) | 0 | 0 | 0 |
| Đỉnh stack một lượt ba model (B) | 2.812 | 3.780 | 2.820 |

| Thước chọn của thang lượng tử | ESP-DL | TFLite / TFLM |
|---|---|---|
| `detect`: AP mặt ≥ 38 px | 0,9544 | 0,9389 |
| `spoof`: CelebA-Spoof AUC | 0,8242 | 0,8252 |
| `recog`: CFP-FP TAR@1e-3 | 0,799 | 0,799 |

## Môi trường đo

|  | Giá trị |
|---|---|
| Chip | ESP32-S3 v0.2, CPU 240 MHz |
| Lõi | model ở lõi 1 (main task), tải PSRAM ở lõi 0 |
| Flash | 16MB, QIO 80MHz, chip boya |
| PSRAM | 8MB octal 80MHz, AP, generation 3 |
| Cache | lệnh 32 KB, 8 đường, dòng 32 B; dữ liệu 64 KB, 8 đường, dòng 64 B |
| RAM nội cho heap lúc khởi động | ESP-DL: 327,2 KB; TFLM + esp-nn: 342,6 KB; TFLM, esp-nn bản C: 342,6 KB |
| ESP-IDF | v6.0.2 |
| Trình biên dịch | GCC 15.2.0 (`esp-15.2.0_20251204`) |
| Mức tối ưu | `-O2` (`COMPILER_OPTIMIZATION_PERF`) |
| FreeRTOS | tick 1000 Hz |
| Thư viện | esp-dl 3.3.11 · esp-tflite-micro 1.4.0 · esp-nn 1.3.2 |
| Bản build | ESP-DL: `firmware-v0.9.11-110-g9d552610`; TFLM + esp-nn: `firmware-v0.9.11-114-gb1f3c105`; TFLM, esp-nn bản C: `firmware-v0.9.11-112-g0e07a04a` |
| Lặp | 3 lượt khởi động rồi 50 lượt đo cho mỗi số |
| Đầu vào | ảnh tổng hợp tất định của `bench_ai`, cùng một ảnh cho cả ba cấu hình |
| Tải PSRAM | ESP-DL: chép 307.200 B mỗi 70 ms: 3.434 đến 3.444 KB/s mỗi chiều; TFLM + esp-nn: chép 307.200 B mỗi 70 ms: 3.638 đến 3.649 KB/s mỗi chiều; TFLM, esp-nn bản C: chép 307.200 B mỗi 70 ms: 3.608 đến 3.609 KB/s mỗi chiều |
| Kconfig khác nhau giữa các bản build | ESP-DL: `AI_RUNTIME_ESPDL`, `AI_WEIGHTS_PSRAM_DETECT`, `AI_WEIGHTS_PSRAM_RECOG`, `AI_WEIGHTS_PSRAM_SPOOF`, `NN_OPTIMIZATIONS=1`, `NN_OPTIMIZED`; TFLM + esp-nn: `AI_ARENA_BIG_KB=4096`, `AI_ARENA_FAST_KB=512`, `AI_RUNTIME_TFLM`, `NN_OPTIMIZATIONS=1`, `NN_OPTIMIZED`; TFLM, esp-nn bản C: `AI_ARENA_BIG_KB=4096`, `AI_ARENA_FAST_KB=512`, `AI_RUNTIME_TFLM`, `NN_ANSI_C`, `NN_OPTIMIZATIONS=0` |

## Model

Tham số và MAC đếm trên conv, depthwise và FC của file `.tflite`;
ESP-DL chạy cùng kiến trúc.

| Nhánh, run trên lock | Đầu vào | Tham số (M) | MAC (M) | ESP-DL (file deploy) | TFLite Q1 (TFLM) |
|---|---|---|---|---|---|
| `detect` `20260831-1616_cc931df_36fbea` | 120×160×3 | 0,07 | 25,2 | `mse+clip_as_relu/detection.espdl` 193,0 KB | `yunet_int8_q1_1616_36fbea.tflite` 158,9 KB |
| `spoof` `20260918-0118_c1d09c8_5d7b35` | 80×80×3 | 0,43 | 40,9 | `int16_top1/antispoof.espdl` 577,1 KB | `minifasnet_v2_int8_q1_0118_5d7b35.tflite` 617,5 KB |
| `recog` `20260923-2106_59828c4_9a6954` | 112×112×3 | 1,18 | 221,2 | `qat/recognition.espdl` 1.345,8 KB | `mobilefacenet_eca_int8_q1_2106_9a6954.tflite` 1.503,0 KB |

## Thời gian, lúc rảnh (ms, median / p95 của 50 lượt)

|  | ESP-DL | TFLM + esp-nn | TFLM, esp-nn bản C |
|---|---|---|---|
| `detect` | 32,9 / 32,9 | 232,5 / 232,5 | 1.750,5 / 1.750,5 |
| `spoof` | 73,3 / 73,3 | 780,3 / 780,3 | 2.663,6 / 2.663,6 |
| `recog` | 246,4 / 246,4 | 2.704,3 / 2.704,3 | 12.854,3 / 12.854,3 |
| một lượt, ba model nối nhau | **353,6** / 353,6 | **3.717,7** / 3.717,7 | **17.268,6** / 17.268,6 |

## Thời gian, có tải PSRAM của preview (ms, median / p95 của 50 lượt)

|  | ESP-DL | TFLM + esp-nn | TFLM, esp-nn bản C |
|---|---|---|---|
| `detect` | 35,2 / 41,7 | 244,2 / 247,1 | 1.772,0 / 1.773,1 |
| `spoof` | 86,0 / 87,0 | 809,3 / 817,2 | 2.735,9 / 2.739,2 |
| `recog` | 278,5 / 289,9 | 2.826,0 / 2.843,4 | 13.322,0 / 13.330,2 |
| một lượt, ba model nối nhau | **406,2** / 411,4 | **3.864,6** / 3.865,6 | **17.832,0** / 17.841,6 |

## Tốc độ quy đổi, lúc rảnh

|  | ESP-DL | TFLM + esp-nn | TFLM, esp-nn bản C |
|---|---|---|---|
| `detect`: khung mỗi giây | 30,41 | 4,30 | 0,57 |
| Một lượt ba model: mặt mỗi giây | 2,83 | 0,27 | 0,06 |
| `detect`: MAC mỗi chu kỳ CPU | 3,20 | 0,45 | 0,06 |
| `spoof`: MAC mỗi chu kỳ CPU | 2,32 | 0,22 | 0,06 |
| `recog`: MAC mỗi chu kỳ CPU | 3,74 | 0,34 | 0,07 |
| Một lượt ba model: MAC mỗi chu kỳ CPU | 3,38 | 0,32 | 0,07 |
| Có tải preview: một lượt chậm đi | +14,9% | +4,0% | +3,3% |

### Hệ số tăng tốc

|  | ESP-DL so với TFLM + esp-nn | esp-nn so với bản C | ESP-DL so với TFLM bản C |
|---|---|---|---|
| `detect` | 7,07× | 7,53× | 53,23× |
| `spoof` | 10,64× | 3,41× | 36,32× |
| `recog` | 10,98× | 4,75× | 52,17× |
| một lượt ba model | 10,51× | 4,64× | 48,83× |

## Tài nguyên

### Ảnh app: flash và RAM tĩnh

|  | ESP-DL | TFLM + esp-nn | TFLM, esp-nn bản C |
|---|---|---|---|
| Ảnh app `bench_ai.bin` (KB) | 1.283,4 | 386,5 | 360,9 |
| Flash Code (KB dùng / có) | 1.035,5 | 282,9 | 257,5 |
| Flash Data (KB dùng / có) | 176,8 | 44,1 | 44,0 |
| DIRAM (KB dùng / có) | 84,3 / 333,8 | 68,9 / 333,8 | 68,9 / 333,8 |
| · `.text` (KB) | 59,9 | 48,0 | 48,0 |
| · `.bss` (KB) | 13,3 | 9,5 | 9,5 |
| · `.data` (KB) | 10,1 | 10,4 | 10,4 |
| · `.vectors` (KB) | 1,0 | 1,0 | 1,0 |
| RTC SLOW (KB dùng / có) | 0,0 / 8,0 | 0,0 / 8,0 | 0,0 / 8,0 |
| RTC FAST (KB dùng / có) | 0,0 / 8,0 | 0,0 / 8,0 | 0,0 / 8,0 |

### Thư viện có cỡ khác nhau giữa ba bản build

Mọi archive chênh từ 1.024 B trở lên, gồm cả thứ runtime kéo theo.

| Archive (flash KB · RAM tĩnh KB) | ESP-DL | TFLM + esp-nn | TFLM, esp-nn bản C |
|---|---|---|---|
| `esp-dl` | 598,1 · 15,0 | — | — |
| `ai_engine` | 218,8 · 2,0 | 9,7 · 3,5 | 9,7 · 3,5 |
| `stdc++` | 123,6 · 0,1 | 1,5 · 0,0 | 1,5 · 0,0 |
| `esp-tflite-micro` | — | 108,9 · 0,1 | 108,9 · 0,1 |
| `tfpsacrypto` | 59,5 · 0,6 | 0,9 · 0,2 | 0,9 · 0,2 |
| `esp-nn` | — | 28,2 · 0,0 | 3,2 · 0,0 |
| `fbs_model` | 20,3 · 0,0 | — | — |
| `c` | 15,2 · 0,4 | 13,2 · 0,4 | 13,1 · 0,4 |
| `esp_driver_dma` | 2,5 · 0,0 | — | — |
| `efuse` | 1,5 · 0,2 | 0,2 · 0,0 | 0,2 · 0,0 |
| `esp_hal_dma` | 1,4 · 0,2 | — | — |
| **Cộng các dòng trên** | **1.040,9 · 18,4** | **162,6 · 4,2** | **137,5 · 4,2** |

### Bộ nhớ khi chạy

|  | ESP-DL | TFLM + esp-nn | TFLM, esp-nn bản C |
|---|---|---|---|
| Dựng ba model (ms) | 379 | 125 | 119 |
| RAM nội lấy khi dựng (KB) | 0 | 0 | 0 |
| PSRAM lấy khi dựng (KB) | 3.574 | 1.158 | 1.158 |
| `detect` khi dựng | PSRAM 353,9 KB, nội 176 B, dựng 61,8 ms | arena_fast tới 185 KB | arena_fast tới 176 KB |
| `spoof` khi dựng | PSRAM 1.111,0 KB, nội 0 B, dựng 123,4 ms | arena_big tới 677 KB | arena_big tới 396 KB |
| `recog` khi dựng | PSRAM 2.109,4 KB, nội 0 B, dựng 192,3 ms | arena_big tới 971 KB | arena_big tới 971 KB |
| Arena TFLM đã dùng / cấp | không có arena chung | fast 185,2 KB / 186 KB + big 971,9 KB / 972 KB | fast 176,5 KB / 186 KB + big 971,4 KB / 972 KB |
| Trọng số khi chạy nằm ở | PSRAM, chép khi dựng | flash, đọc qua mmap | flash, đọc qua mmap |
| RAM nội còn trống sau khi dựng (KB) | 309 | 325 | 325 |
| PSRAM còn trống / khối liền lớn nhất (KB) | 4.500 / 4.352 | 6.916 / 6.912 | 6.916 / 6.912 |
| Đỉnh stack một lượt ba model / stack của task thăm dò | 2.812 B / 32.768 B | 3.780 B / 32.768 B | 2.820 B / 32.768 B |
| Heap sau 50 lượt so với lượt đầu | 0 B nội, 0 B PSRAM | 0 B nội, 0 B PSRAM | 0 B nội, 0 B PSRAM |
| Chép cả ba payload từ flash sang PSRAM, việc ESP-DL làm khi dựng | 2.115 KB trong 111,3 ms, 18,6 MB/s | 2.279 KB trong 120,0 ms, 18,5 MB/s | 2.279 KB trong 120,0 ms, 18,5 MB/s |
| CRC32 trên bản chép ở PSRAM (ms) | 101,0 | 108,8 | 108,8 |

## Độ chính xác trên máy, cùng thước với thang lượng tử

Hai cấu hình TFLM chạy cùng một file `.tflite`, nên chung một cột; mục So khớp bên dưới
đo board lệch máy bao nhiêu.

### `detect`

|  | ESP-DL | TFLite / TFLM |
|---|---|---|
| AP easy (WIDER val) | 0,6404 | 0,6393 |
| AP medium | 0,3643 | 0,3635 |
| AP hard | 0,1515 | 0,1512 |
| **AP mặt ≥ 38 px** (thước chọn) | 0,9544 | 0,9389 |

### `spoof`

|  | ESP-DL | TFLite / TFLM |
|---|---|---|
| **CelebA-Spoof AUC** (thước chọn) | 0,8242 | 0,8252 |
| CelebA-Spoof EER | 0,2612 | 0,2581 |
| CelebA-Spoof APCER ở 500‰ | 0,3769 | 0,3822 |
| CelebA-Spoof BPCER ở 500‰ | 0,1690 | 0,1635 |
| 87 khung OV5640: AUC | 1,0000 | 1,0000 |
| 87 khung OV5640: EER | 0,0000 | 0,0000 |
| 87 khung: mặt thật thấp nhất | 0,196 | 0,163 |
| 87 khung: khung giả cao nhất | 0,010 | 0,014 |
| 87 khung: thật giữ · giả chặn ở 500‰ | 59/62 · 25/25 | 57/62 · 25/25 |
| axon AUC | 0,7654 | 0,7797 |
| axon EER | 0,2847 | 0,2914 |
| lcc_fasd AUC | 0,8762 | 0,8625 |
| lcc_fasd EER | 0,2003 | 0,2040 |
| nuaa AUC | 0,9999 | 1,0000 |
| nuaa EER | 0,0023 | 0,0012 |
| synthaspoof AUC | 0,9080 | 0,9083 |
| synthaspoof EER | 0,1714 | 0,1700 |

### `recog`

|  | ESP-DL | TFLite / TFLM |
|---|---|---|
| LFW accuracy | 0,9962 | 0,9962 |
| LFW TAR@1e-3 | 0,994 | 0,993 |
| LFW TAR@1e-4 | 0,991 | 0,990 |
| LFW EER | 0,0047 | 0,0043 |
| CFP-FP accuracy | 0,9459 | 0,9446 |
| **CFP-FP TAR@1e-3** (thước chọn) | 0,799 | 0,799 |
| CFP-FP TAR@1e-4 | 0,767 | 0,733 |
| CFP-FP EER | 0,0594 | 0,0589 |
| AgeDB-30 accuracy | 0,9623 | 0,9653 |
| AgeDB-30 TAR@1e-3 | 0,849 | 0,895 |
| AgeDB-30 TAR@1e-4 | 0,784 | 0,809 |
| AgeDB-30 EER | 0,0387 | 0,0403 |

## So khớp

|  | Giá trị | Kết quả |
|---|---|---|
| CRC `detect`: esp-nn với bản C | `5121034e` · `5121034e` | trùng |
| CRC `spoof`: esp-nn với bản C | `730ddbb7` · `730ddbb7` | trùng |
| CRC `recog`: esp-nn với bản C | `4dac51b0` · `4dac51b0` | trùng |
| Điểm live: board với TFLite trên máy | 0,951984 · 0,951984 | trùng |
| CRC embedding: board với TFLite trên máy | `4dac51b0` · `e189fe84` | **LỆCH** |
| Embedding: board với TFLite trên máy | 7/512 phần tử khác, lệch tối đa 3 bậc, cosine 0,999984 | — |
| Embedding trên máy: kernel tham chiếu với kernel mặc định của TFLite | 501/512 phần tử khác, lệch tối đa 46 bậc, cosine 0,930953 | — |
| ESP-DL `model->test()` | detect PASS, spoof PASS, recog PASS | — |
| Unity, ESP-DL | 10 ca, 0 hỏng | đạt |
| Unity, TFLM + esp-nn | 9 ca, 0 hỏng | đạt |
| Unity, TFLM, esp-nn bản C | 9 ca, 0 hỏng | đạt |
