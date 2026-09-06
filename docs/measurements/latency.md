# Latency trên board — E8-T8

Đo bằng `MicroProfiler` (`CONFIG_AI_PROFILING=y`) trong
`ai_engine/test_apps/antispoof`, profile `sdkconfig.profile` (`-O2`, assert im
lặng). Tick của profiler là micro giây: tổng 1.086.358 tick khớp với 1.086.321 µs
mà `esp_timer` đo độc lập ở cùng lần chạy, nên hai nguồn xác nhận lẫn nhau.

Cấu hình chip: **240 MHz, icache 32 KB, dcache 64 KB line 64 B, PSRAM octal 80
MHz**, lấy chung từ `firmware/sdkconfig.defaults.esp32s3`.

## 1. Anti-spoof `minifasnet_int8` (`1740`), hai crop 80×80

Arena nằm ở **PSRAM** — xem `arena.md`, 338 KB không vừa SRAM nội.

| Op | µs | % | Có kernel ESP-NN |
|---|---|---|---|
| **PRELU** | 406.363 | **37,4%** | ❌ |
| **MEAN** | 217.456 | **20,0%** | ❌ |
| CONV_2D | 204.131 | 18,8% | ✅ |
| MUL | 104.875 | 9,7% | ✅ |
| DEPTHWISE_CONV_2D | 90.441 | 8,3% | ✅ |
| **PAD** | 44.665 | 4,1% | ❌ |
| ADD | 15.727 | 1,4% | ✅ |
| FULLY_CONNECTED | 2.645 | 0,2% | ✅ |
| **CONCATENATION** | 55 | 0,005% | ❌ |
| **Tổng** | **1.086.358** | | |

Ngân sách §6.4 cho nhánh này là **60 ms**. Thực đo **1.086 ms — gấp 18 lần**.

## 2. Đọc bảng

**61,5% thời gian nằm ở bốn loại op không có kernel ESP-NN.** Cộng PRELU, MEAN,
PAD và CONCATENATION được 668.539 µs. Phần tích chập thật — thứ mà mạng sinh ra
để làm — chỉ chiếm 38,5%.

**PReLU một mình ăn 406 ms.** KẾ HOẠCH §3 đã bắt dùng ReLU6 đúng vì lý do này;
student lại train bằng PReLU để cân bằng chéo lớp (CLE) chạy được, vì CLE đòi
hàm kích hoạt thuần nhất dương mà ReLU6 không thoả (§3.8). `tflite_op_check.py`
đã cảnh báo 46 op PRELU từ trước khi E8 tồn tại; giờ có giá của nó bằng số.

**MEAN 217 ms cho 20 phép trung bình toàn cục** là các khối squeeze-excite. Cùng
một phép này viết dưới dạng `AVERAGE_POOL_2D` thì có kernel ESP-NN.

**Mức tối ưu trình biên dịch gần như không đổi gì**: `-Og` cho 1.087,1 ms, `-O2`
cho 1.086,3 ms, chênh 0,07%. Vòng nóng hoặc đã là assembly của esp-nn, hoặc bị
chặn bởi băng thông PSRAM — cả hai đều không nhờ `-O2` mà nhanh lên.

**Xung nhịp thì đổi đúng theo tỉ lệ**: 160 MHz cho 1.657 ms, 240 MHz cho 1.087
ms, tỉ số 1,52 so với 1,50 theo lý thuyết.

## 3. Việc cần làm, xếp theo mức thu được

| Việc | Ước tính thu về | Đánh đổi |
|---|---|---|
| PReLU → ReLU6, train lại nhánh | ~406 ms | Mất CLE, phải đo lại thang §3.8 |
| MEAN → AVERAGE_POOL_2D ở khối SE | ~217 ms | Sửa kiến trúc student, train lại |
| Thu nhỏ model để arena vừa SRAM nội | 🔬 chưa đo | Giảm input hoặc số kênh, train lại |

Hai dòng đầu đưa 1.086 ms xuống khoảng 460 ms mà không đụng tới số phép tính.
Vẫn chưa đạt 60 ms, nên dòng thứ ba là bắt buộc chứ không phải tuỳ chọn.

## 4. Chưa đo

| Nhánh | Trạng thái |
|---|---|
| detection | 🔬 chưa có model, E4 chưa train |
| recognition | 🔬 chưa có model, E6 chưa train |

Vì vậy **chưa có con số nào cho "một lần chạy cả ba model"**. Chỉ có nhánh
anti-spoof chạy được trên board.
