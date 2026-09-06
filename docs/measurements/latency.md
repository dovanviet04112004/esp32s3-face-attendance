# Latency trên board — E8-T8

Đo bằng `MicroProfiler` (`CONFIG_AI_PROFILING=y`) trong `firmware/test_apps/bench_ai`,
20 lần chạy mỗi nhánh. Tick của profiler là micro giây: tổng tick khớp với
`esp_timer` đo độc lập ở cùng lần chạy, nên hai nguồn xác nhận lẫn nhau.

Cấu hình chip: **240 MHz, icache 32 KB, dcache 64 KB line 64 B, PSRAM octal 80
MHz**, lấy chung từ `firmware/sdkconfig.defaults.esp32s3`. Build `-O2`, assert
im lặng. **Cả hai arena đều nằm ở PSRAM** — xem `arena.md`.

## 1. Một khuôn mặt đi hết ba nhánh

| Nhánh | Model | Latency đo | Ngân sách §6.4 | Vượt |
|---|---|---|---|---|
| detect | YuNet | **231,4 ms** | 120 ms | 1,9× |
| spoof | MiniFASNetV2-SE ×2 | **1.086,9 ms** | 60 ms | 18,1× |
| recog | MobileFaceNet | **2.177,4 ms** | 180 ms | 12,1× |
| **Tổng** | | **3.495,6 ms** | **360 ms** | **9,7×** |

Sai lệch giữa 20 lần chạy dưới 0,05% ở cả ba nhánh, nên đây là số ổn định chứ
không phải một lần bắt được.

## 2. Từng op

### detect — YuNet, 230.900 µs

| Op | µs | % | ESP-NN |
|---|---|---|---|
| CONV_2D | 130.075 | 56,3% | ✅ |
| DEPTHWISE_CONV_2D | 84.759 | 36,7% | ✅ |
| PAD | 7.977 | 3,5% | ❌ |
| MAX_POOL_2D | 3.874 | 1,7% | ✅ |
| ADD | 3.722 | 1,6% | ✅ |
| RESIZE_NEAREST_NEIGHBOR | 493 | 0,2% | ❌ |

**96,3% thời gian nằm ở op có kernel ESP-NN.** Đây là nhánh khoẻ: thời gian đi
vào đúng phép tích chập mà mạng sinh ra để làm.

### spoof — MiniFASNetV2-SE, 1.086.358 µs

| Op | µs | % | ESP-NN |
|---|---|---|---|
| **PRELU** | 406.363 | **37,4%** | ❌ |
| **MEAN** | 217.456 | **20,0%** | ❌ |
| CONV_2D | 204.131 | 18,8% | ✅ |
| MUL | 104.875 | 9,7% | ✅ |
| DEPTHWISE_CONV_2D | 90.441 | 8,3% | ✅ |
| **PAD** | 44.665 | 4,1% | ❌ |
| ADD | 15.727 | 1,4% | ✅ |
| FULLY_CONNECTED | 2.645 | 0,2% | ✅ |
| CONCATENATION | 55 | 0,005% | ❌ |

**61,5% nằm ở op không có kernel ESP-NN.**

### recog — MobileFaceNet, 2.176.935 µs

| Op | µs | % | ESP-NN |
|---|---|---|---|
| **PRELU** | 1.072.359 | **49,3%** | ❌ |
| CONV_2D | 681.753 | 31,3% | ✅ |
| DEPTHWISE_CONV_2D | 261.785 | 12,0% | ✅ |
| **PAD** | 82.226 | 3,8% | ❌ |
| ADD | 62.256 | 2,9% | ✅ |
| FULLY_CONNECTED | 16.556 | 0,8% | ✅ |

**53,1% nằm ở op không có kernel ESP-NN**, riêng PReLU 49,3%.

## 3. Đọc bảng

**Nhánh nào theo §3 thì nhanh, nhánh nào bỏ §3 thì chậm.** §3 bắt student dùng
ReLU6. YuNet làm đúng và đạt 96,3% op được tăng tốc. MiniFASNet và
MobileFaceNet đều dùng PReLU, và đó là hai nhánh chậm. Đây không phải trùng
hợp: ESP-NN gộp ReLU6 vào ngay đầu ra của conv, còn PReLU phải chạy một vòng
tham chiếu C riêng trên toàn bộ activation.

**PReLU một mình ăn 1.478.722 µs — 42,3% của cả chuỗi 3.496 ms.** Cộng hết op
không tăng tốc được (PReLU, MEAN, PAD, CONCATENATION, RESIZE) là 1.831.594 µs,
tức **52,4% thời gian của cả pipeline dùng cho op mà chip không có kernel**.

**Vì sao lại chọn PReLU**: CLE (cân bằng chéo lớp, §3.8) đòi hàm kích hoạt
thuần nhất dương; ReLU6 có trần cố định nên không thoả. Chọn PReLU là chọn
CLE. `tflite_op_check.py` đã cảnh báo từ trước khi E8 tồn tại; giờ có giá của
nó bằng số.

**Đưa activation về SRAM nội chỉ thu được 1,9%.** Tách `head` xuống SRAM nội và
để `tail` ở PSRAM (§3.10) cho:

| Nhánh | Cả arena ở PSRAM | `head` ở SRAM nội | Thu về |
|---|---|---|---|
| detect | 232,4 ms | 209,5 ms | −23,0 ms (−9,9%) |
| spoof | 1.087,6 ms | 1.042,6 ms | −45,0 ms (−4,1%) |
| recog | 2.178,2 ms | 2.178,1 ms | 0 |
| **Tổng** | 3.498,3 ms | **3.430,2 ms** | **−68,1 ms (−1,9%)** |

`recog` không đổi là phép kiểm chứng: nó vẫn ở `arena_big` PSRAM nên đúng ra
không được đổi, và nó không đổi.

**Nên PSRAM không phải nút thắt.** Nếu băng thông bộ nhớ là chỗ nghẽn thì đưa
toàn bộ activation của hai nhánh về SRAM nội phải thu được nhiều hơn 4–10%.
Chỗ nghẽn là **phép tính trong kernel tham chiếu C**, đúng như bảng op chỉ ra.

**Và cái giá thì không trả nổi.** Tách như trên lấy 240 KB SRAM nội, RAM nội
trống tụt từ 335 KB xuống **95 KB**. §6.4 còn cần ~55 KB cho Wi-Fi + lwIP và
~53 KB cho stack 10 task, tức 108 KB — nhiều hơn số còn lại. Vì vậy
`AI_ARENA_FAST_HEAD_KB` để **mặc định 0**: cơ chế có sẵn, bật lên khi model đã
nhỏ đi, không phải bây giờ.

**Mức tối ưu trình biên dịch gần như không đổi gì**: `-Og` cho 1.087,1 ms và
`-O2` cho 1.086,3 ms trên nhánh spoof, chênh 0,07%. Vòng nóng hoặc đã là
assembly của esp-nn, hoặc bị chặn bởi băng thông PSRAM.

**Xung nhịp đổi đúng theo tỉ lệ**: 160 MHz cho 1.657 ms, 240 MHz cho 1.087 ms,
tỉ số 1,52 so với 1,50 theo lý thuyết.

## 4. Việc cần làm, xếp theo mức thu được

| Việc | Ước tính thu về | Đánh đổi |
|---|---|---|
| PReLU → ReLU6 ở spoof và recog, train lại | **~1.479 ms** | Mất CLE, phải đo lại thang §3.8 cả hai nhánh |
| MEAN → AVERAGE_POOL_2D ở khối SE của spoof | ~217 ms | Sửa kiến trúc student, train lại |
| Đưa arena về SRAM nội | 🔬 chưa đo | Phải thu nhỏ model trước, xem `arena.md` |
| Bỏ PAD bằng cách chọn padding tương đương ở conv | ~135 ms | Sửa kiến trúc, train lại |

Ba dòng đầu đưa 3.496 ms xuống khoảng 1.800 ms mà không giảm một phép tính
nào. Vẫn gấp 5 lần ngân sách 360 ms, nên **model bắt buộc phải nhỏ đi**, không
chỉ đổi hàm kích hoạt.

## 5. Chưa tính vào

Bảng trên chỉ đo `Invoke()`. Chưa có: letterbox ảnh vào detect, decode + NMS
sau detect, crop 1,0×/2,7× cho spoof, affine warp 112×112 cho recog, và
l2norm. Chúng là E8-T3/T4/T5 phần hậu xử lý, sẽ cộng thêm.
