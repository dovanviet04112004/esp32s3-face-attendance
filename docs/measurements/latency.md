# Latency trên board — E8-T8

Đo bằng `MicroProfiler` (`CONFIG_AI_PROFILING=y`) trong `firmware/test_apps/bench_ai`,
20 lần chạy mỗi nhánh. Tick của profiler là micro giây: tổng tick khớp với
`esp_timer` đo độc lập ở cùng lần chạy, nên hai nguồn xác nhận lẫn nhau.

Cấu hình chip: **240 MHz, icache 32 KB, dcache 64 KB line 64 B, PSRAM octal 80
MHz**, lấy chung từ `firmware/sdkconfig.defaults.esp32s3`. Build `-O2`, assert
im lặng. **Cả hai arena đều nằm ở PSRAM** — xem `arena.md`.

## 1. Một khuôn mặt đi hết ba nhánh

Cột "gốc" là kiến trúc ban đầu; cột "sau" là sau khi bỏ PReLU, đổi cách gộp
kênh của SE và cho feature map lẻ. **Trọng số chưa train** ở cột sau — số op và
latency không phụ thuộc trọng số, nhưng accuracy thì có.

| Nhánh | Gốc | Sau | Giảm | Ngân sách §6.4 |
|---|---|---|---|---|
| detect (YuNet) | 231,4 ms | **209,1 ms** | −9,6% | 120 ms |
| spoof (MiniFASNet ×2) | 1.086,9 ms | **469,7 ms** | **−56,8%** | 60 ms |
| recog (MobileFaceNet) | 2.177,4 ms | **1.079,7 ms** | **−50,4%** | 180 ms |
| **Tổng** | **3.495,6 ms** | **1.758,5 ms** | **−49,7%** | **360 ms** |

detect giảm nhờ được ở riêng SRAM nội, không đổi kiến trúc. Còn vượt ngân sách
4,9 lần.

Sai lệch giữa 20 lần chạy dưới 0,05% ở cả ba nhánh, nên đây là số ổn định chứ
không phải một lần bắt được.

### Khi preview chạy song song

Đo bằng một task ở core 0 chuyển đúng lưu lượng PSRAM mà camera + LCD tạo ra:
một khung RGB565 480×320 mỗi 70 ms. Task đếm 4.285 KB/s **theo một chiều**,
tức bus gánh cả đọc lẫn ghi ≈ 8,4 MB/s, sát 8,72 MB/s mà preview thật sự tạo.

| Nhánh | AI một mình | Có tải preview | Chậm hơn |
|---|---|---|---|
| detect | 209,1 ms | **242,6 ms** | +16,0% |
| spoof | 469,5 ms | **547,9 ms** | +16,7% |
| recog | 1.079,6 ms | **1.260,0 ms** | +16,7% |
| **Tổng** | **1.758,3 ms** | **2.050,4 ms** | **+16,6%** |

**detect cũng chậm 16% dù arena của nó ở SRAM nội.** Trọng số vẫn đọc từ flash
qua mmap, mà flash và PSRAM trên ESP32-S3 dùng chung MSPI và chung cache dữ
liệu. Cơ chế đó là suy luận; con số 16% là đo. Hệ quả thực dụng: **đặt arena ở
SRAM không miễn nhiễm với tranh chấp bus**, nên mức lãi 1,9% của việc tách
head/tail càng không đáng so với 240 KB nó lấy.

Ba nhánh chậm đi gần như bằng nhau (16,0 / 16,7 / 16,7%), tức đây là thuế đều
trên mọi truy cập bộ nhớ ngoài chứ không phải một nhánh nào bị chặn riêng.

### Cấu hình đang chốt: cả hai arena ở PSRAM, recog hệ số width 32

Đo 07/09 20:5x, 20 lần chạy mỗi nhánh, `AI_ARENA_FAST_INTERNAL=n`.

| Nhánh | AI một mình | Có tải preview | Chậm hơn |
|---|---|---|---|
| detect | **232,5 ms** | 270,6 ms | +16,4% |
| spoof | **469,5 ms** | 547,9 ms | +16,7% |
| recog (w32) | **457,5 ms** | 534,7 ms | +16,9% |
| **Tổng** | **1.159,5 ms** | **1.353,2 ms** | **+16,7%** |

Giá của việc đưa `arena_fast` xuống PSRAM là **+23,4 ms trên detect** (232,5 so
với 209,1), đúng khoảng 22 ms đã ước từ §3. Hai nhánh kia không đổi vì arena của
chúng vốn đã ở PSRAM. Đổi lại là **220 KB RAM nội**, xem `arena.md` §1c.

Trên tổng một lượt chấm công, 23,4 ms là **2,0%**. Trên tần suất thì khác: detect
chạy mỗi frame, nên nó hạ preview từ 4,8 xuống 4,3 khung/giây khi AI rảnh, và từ
3,7 xuống 3,3 khi có tải.

Tỉ lệ chậm do preview giữ nguyên 16,7% dù arena đã đổi chỗ — thêm một xác nhận
rằng thuế đó đến từ tranh chấp MSPI chung, không từ nơi đặt arena.

### Op còn lại ngoài ESP-NN

| Nhánh | Gốc | Sau |
|---|---|---|
| detect | 3/62 (`PAD`, `RESIZE_NEAREST_NEIGHBOR`) | 3/62 — chưa sửa |
| spoof | 74/240 (`PRELU` 46, `MEAN` 20, `PAD` 8) | **1/186** (`CONCATENATION`, 55 µs) |
| recog | 37/99 (`PRELU` 33, `PAD` 4) | **0/62** |

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

**Nhánh nào theo §3 thì nhanh, nhánh nào bỏ §3 thì chậm.** §3 cấm `PReLU` ở mọi
nhánh. YuNet làm đúng ngay từ đầu — nó dùng `ReLU6` — và đạt 96,3% op được tăng
tốc. MiniFASNet và MobileFaceNet dùng `PReLU`, và đó đúng là hai nhánh chậm.
Không phải trùng hợp: ESP-NN kẹp `ReLU`/`ReLU6` ngay trong vòng lặp assembly
của conv, còn `PReLU` phải chạy một vòng tham chiếu C riêng trên toàn bộ
activation.

**PReLU một mình ăn 1.478.722 µs — 42,3% của cả chuỗi 3.496 ms.** Cộng hết op
không tăng tốc được (PReLU, MEAN, PAD, CONCATENATION, RESIZE) là 1.831.594 µs,
tức **52,4% thời gian của cả pipeline dùng cho op mà chip không có kernel**.

**Vì sao trước đó lại là PReLU, và vì sao thay bằng `ReLU` chứ không phải
`ReLU6`**: CLE (cân bằng chéo lớp, §3.8) đòi hàm kích hoạt thuần nhất dương.
`ReLU6` có trần cố định nên không thoả — nó chỉ giữ được 15/48 cặp conv của
MobileFaceNet. `PReLU` thoả, nên chọn PReLU là chọn CLE, và giá phải trả hiện
ở bảng trên. `ReLU` cũng thuần nhất dương, giữ đủ **48/48** cặp, mà lại tốn 0 ms
vì esp-nn kẹp nó trong kernel conv. Vì vậy hai nhánh này đổi sang `ReLU`:
**giữ nguyên CLE, bỏ toàn bộ chi phí**. Detection giữ `ReLU6` vì nó không chạy
CLE và dải bị chặn có lợi cho INT8.

**Đổi mới là kiến trúc, chưa phải model đã chốt.** Số ở cột "sau" đo trên đồ thị
`ReLU` với **trọng số chưa train**. Tại thời điểm ghi bảng này,
`contracts/models.lock.json` vẫn trỏ về bản `PReLU`: anti-spoof
`20260905-1740_865b5d0` (đầu vào 80×80) và recognition `20260903-2258_f7a6aab`
(112×112) — 80 và 112 là kích thước của kiến trúc cũ, bản mới dùng 81 và 113.
Lock chỉ đổi sau khi mỗi nhánh có run train của chính kiến trúc mới và qua được
ngưỡng accuracy INT8 ở §4.2.

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
cơ chế tách đã bị gỡ khỏi `Arena`. Đường quay lại khi model nhỏ đi là
`AI_ARENA_FAST_INTERNAL=y`, đặt **cả** arena vào SRAM nội, ăn đứt phương án
giữa này.

**Mức tối ưu trình biên dịch gần như không đổi gì**: `-Og` cho 1.087,1 ms và
`-O2` cho 1.086,3 ms trên nhánh spoof, chênh 0,07%. Vòng nóng hoặc đã là
assembly của esp-nn, hoặc bị chặn bởi băng thông PSRAM.

**Xung nhịp đổi đúng theo tỉ lệ**: 160 MHz cho 1.657 ms, 240 MHz cho 1.087 ms,
tỉ số 1,52 so với 1,50 theo lý thuyết.

## 4. Việc cần làm, xếp theo mức thu được

| Việc | Thu về | Đánh đổi | Trạng thái |
|---|---|---|---|
| `PReLU` → `ReLU` ở spoof và recog | **1.479 ms** | Không mất CLE: `ReLU` cũng thuần nhất dương | kiến trúc ✅, train recog đang chạy, train spoof chưa |
| `MEAN` → `AVERAGE_POOL_2D` ở khối SE của spoof | 217 ms | Sửa kiến trúc student | kiến trúc ✅, chưa train |
| Bỏ `PAD` bằng feature map lẻ (81, 113) | 135 ms | Sửa kiến trúc student | kiến trúc ✅, chưa train |
| Hệ số width 32 cho recog | **621 ms** | Nửa số kênh, accuracy phải kiểm | đo ✅, chưa chốt |
| Hệ số width cho spoof | 🔬 chưa đo | `MiniFASNetBackbone` chưa có tham số | chưa làm |
| Ngừng preview lúc spoof + recog chạy | 🔬 ~190 ms | Màn hình đứng ~1,1 s mỗi lượt | chưa thử |
| Đưa arena về SRAM nội | 23 ms mỗi frame, chỉ detect | Không đủ RAM, xem `arena.md` | ❌ bỏ |

Ba dòng đầu đưa 3.496 ms xuống **1.758 ms** mà không giảm một phép tính nào —
đo thật, không còn là ước lượng. Vẫn gấp 4,9 lần ngân sách 360 ms, nên **model
bắt buộc phải nhỏ đi**: dòng thứ tư hạ tiếp xuống **1.138 ms**.

Mọi con số ở bảng này đo trên trọng số chưa train. Chúng đúng cho latency vì
latency không phụ thuộc trọng số, nhưng **accuracy thì có** — chưa nhánh nào
trong hai nhánh này được chốt cho tới khi có run train của đúng kiến trúc mới.

## 5. Chưa tính vào

Bảng trên chỉ đo `Invoke()`. Chưa có: letterbox ảnh vào detect, decode + NMS
sau detect, crop 1,0×/2,7× cho spoof, affine warp 112×112 cho recog, và
l2norm. Chúng là E8-T3/T4/T5 phần hậu xử lý, sẽ cộng thêm.
