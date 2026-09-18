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

## 6. Preview mất một nửa nhịp vì thiếu một khung đệm — đo 11/09

Nối `ai_task` vào đường khung (E10-T4) làm preview tụt từ **14,18 fps** xuống
**8,1 fps**. Bốn phép đo trên board, cùng phòng, cùng bản dựng, khác đúng một
điều kiện mỗi lần:

| Điều kiện | Preview | `exposure` | Chu kỳ khung cảm biến |
|---|---|---|---|
| `fb_count` 3, `ai_task` nằm im | **14,18 fps** | 826 dòng | 70.490 µs |
| `fb_count` 3, `ai_task` chạy | **8,1 fps** | 868 dòng | 70.490 µs |
| `fb_count` 4, `ai_task` chạy | **14,18 fps** | 868 dòng | 70.490 µs |
| Quét phơi sáng 744 → 876 dòng | — | mọi mức | **70.490 µs ở mọi mức** |

**Nguyên nhân là số khung đệm, không phải phơi sáng và không phải chia core.**
Phép quét ở dòng thứ tư đóng đường phơi sáng: chu kỳ khung của cảm biến là
70.490 µs ở mọi mức phơi tới đúng `VTS` = 876 dòng, nên phơi dài **không** làm
cảm biến kéo dài khung. Với 3 khung thì `ai_task` giữ một khung tới 2 giây,
`cam_task` giữ một khung suốt lúc `drv_lcd_blit_frame` chạy, còn lại một khung
cho driver — nên cảm biến phải **đợi khung được trả** mới lấp được khung kế
tiếp, và chu kỳ thành *lấp + xử lý* ≈ 125 ms thay vì `max(lấp, xử lý)` = 70 ms.
Thêm khung thứ tư (300 KB PSRAM trong 6,09 MB còn trống) trả nhịp về đúng nhịp
cảm biến.

**`drv_camera_grab` không hề trả về NULL trong cả ba lần đo** (0 lần pool cạn).
Đó là lý do phép đo "pool cạn" không phát hiện được chuyện này: `esp_camera_fb_get`
không báo thiếu khung, nó **đợi**, và cái đợi hiện ra thành fps chứ không thành
lỗi.

**Chốt lại một chỗ đã suy luận sai.** Chu kỳ khung 130.408 µs đo được trong lần
chạy có AI từng bị đọc là "trần của cảm biến trong phòng tối". Nó là **hậu quả**
của việc thiếu khung đệm, không phải nguyên nhân: cùng cảm biến, cùng phơi sáng,
thêm một khung đệm là chu kỳ về 70.490 µs.

Vấn đề phơi sáng kẹt cả hai trần của E7-T17 **vẫn còn nguyên** và không liên
quan: `level` chỉ đạt 12–14 trên mục tiêu 30 ở `exposure` 868 với `gain` 4×.

---

## 7. Ba nhánh với model thật đã train — đo 12/09

Lần đầu cả ba `.tflite` trên `models_0` là model **đã train và đã chốt**, không còn trọng số
ngẫu nhiên: detect `20260831-1616`, anti-spoof `20260912-0107` (một backbone), recognition
`20260908-1750`. Cùng cấu hình mục 1: 240 MHz, `-O2`, PSRAM octal 80 MHz, cả hai arena ở
PSRAM. `firmware/test_apps/bench_ai`, 20 lần chạy mỗi nhánh.

| Nhánh | Đo 12/09 | Bản hai backbone (mục 1) | Ngân sách §6.4 |
|---|---|---|---|
| detect | 232,5 ms | 209,1 ms | 120 ms |
| **anti-spoof** | **234,0 ms** | 469,7 ms | 60 ms |
| recognition | 458,0 ms | 1.079,7 ms | 180 ms |
| **Một mặt đi hết ba nhánh** | **924,5 ms** | 1.758,5 ms | **360 ms** |

**Anti-spoof đúng một nửa bản hai backbone** (234,0 so với 469,7 ms), khớp với việc bỏ một
trong hai backbone. Tổng còn 52,6% so với lần đo cũ.

**Vẫn trượt ngân sách 2,6 lần.** Ngân sách 360 ms của §6.4 không đạt ở bất kỳ nhánh nào, và
trượt nặng nhất ở anti-spoof (3,9 lần). Ba số này là số thật để §6.4 được viết lại, chứ không
phải để tự trấn an.

Dưới tải preview (một luồng đọc ghi PSRAM 4.290 KB/s, 309 khung trong 21,6 s):

| Nhánh | Rảnh | Có tải | Tăng |
|---|---|---|---|
| detect | 232,5 ms | 270,6 ms | +16,4% |
| anti-spoof | 234,0 ms | 273,7 ms | +17,0% |
| recognition | 458,0 ms | 535,4 ms | +16,9% |
| **Tổng** | **924,5 ms** | **1.079,7 ms** | **+16,8%** |

Mức phạt 17% trùng khít lần đo cũ (16,6%), nên nó là đặc tính của băng thông PSRAM chứ không
phải của model.

### 7.1 Arena và kích thước, đo cùng lần

| | Giá trị |
|---|---|
| `arena_fast` (detect riêng) | 189.628 B trong 186 KB cấp phát |
| `arena_big` (spoof + recog chung) | **422.764 B** trong 466 KB, trước đây 823.148 B |
| Sau khi nạp spoof | 210 KB |
| Sau khi nạp recog | 412 KB |
| File trên `models_0` | detect 158 KB, spoof **424 KB**, recog 720 KB |
| RAM nội còn rảnh | 331–335 KB |
| PSRAM còn rảnh | 7.537 KB |

---

## 8. Nhánh chống giả hai backbone, model thật đã train — đo 13/09

§36 của `antispoof/measurements.md` chốt rằng bản một backbone không phân biệt được ảnh in trên
miền thiết bị (AUC 0,6510) còn bản hai backbone đọc 0,9449. Mục này trả lời câu còn lại: **nó
tốn thêm bao nhiêu.**

Export `20260910-1538_09a1263` (hai backbone, `views: both`) qua đúng đường của §4.4 —
ONNX (khớp torch tới 1,669e-06) → SavedModel → INT8 hiệu chuẩn 300 mẫu. Đóng vào `models_0`
cùng detect và recog đang dùng, chạy `firmware/test_apps/bench_ai`, 20 lần mỗi nhánh, cùng
cấu hình mục 1: 240 MHz, `-O2`, PSRAM octal 80 MHz.

| Nhánh | **Hai backbone, 13/09** | Một backbone, §7 | Chênh |
|---|---|---|---|
| detect | 232,5 ms | 232,5 ms | 0 |
| **anti-spoof** | **468,1 ms** | 234,0 ms | **+234,1 ms** |
| recognition | 457,4 ms | 458,0 ms | −0,6 ms |
| **Một mặt đi hết ba nhánh** | **1.157,9 ms** | 924,5 ms | **+25,2%** |

Dưới tải preview (4.292 KB/s PSRAM, 387 khung trong 27,0 s):

| Nhánh | Hai backbone | Một backbone, §7 | Chênh |
|---|---|---|---|
| detect | 270,6 ms | 270,6 ms | 0 |
| anti-spoof | 546,9 ms | 273,7 ms | +273,2 ms |
| recognition | 534,5 ms | 535,4 ms | −0,9 ms |
| **Tổng** | **1.352,0 ms** | 1.079,7 ms | **+25,2%** |

Sai lệch 20 lần chạy của nhánh spoof: 468.083–468.383 µs, tức **0,06%**.

**Con số này xác nhận cột "sau" của mục 1.** Mục 1 đo 469,7 ms cho `MiniFASNet ×2` trên **trọng
số ngẫu nhiên**; model thật đo 468,1 ms, lệch **0,3%**. Latency không phụ thuộc trọng số, đúng
như mục 1 đã nêu, và giờ có model thật để đối chứng.

### 8.1 Op và bộ nhớ

`tflite_op_check` trên chính file vừa export: **186 op, 185 chạy kernel ESP-NN**, còn đúng một
`CONCATENATION` dùng kernel tham chiếu — trùng khít cột "sau" của bảng op ở mục 1 (`1/186`).
Không còn `PRELU`, `MEAN` hay `PAD`: hai backbone là **cùng một backbone chạy hai lượt**, nên
nó không kéo theo op nào chip không có kernel.

| | Một backbone | Hai backbone | Chênh |
|---|---|---|---|
| File trên `models_0` | 425 KB | **854 KB** | +429 KB (partition 3.072 KB) |
| `arena_big` cần | 422.764 B | **476.204 B** | **+53.440 B** |
| `models_0` đã dùng | 1.304 KB | 1.733 KB | |

`arena_hint` phải nâng cùng lúc ở **cả hai** nhánh dùng chung `arena_big`: để nguyên 422.764 B
thì spoof nạp được (282 của 413 KB) nhưng **recog bị `AllocateTensors` từ chối**, vì hai nhánh
xếp chồng tail trên một `MicroAllocator` (§3.8).

### 8.2 Chỗ lấy lại thời gian

Bảng "việc cần làm" ở mục 4 còn dòng chưa thử: **ngừng preview lúc spoof + recog chạy, 🔬 ~190
ms**. Riêng nó gần như trả hết 234 ms của backbone thứ hai, và đổi lại là màn hình đứng trong
quãng mà giao diện đang hiện `Đang nhận diện...` (§4.5.5h.1) nên người dùng không đọc ra là treo.

---

## 9. Nhánh chống giả bằng trọng số nhập MiniFASNetV2 — đo 16/09

Ảnh `models_0`: detect `20260831-1616`, spoof **`20260916-0729`** (trọng số minivision, ReLU thay
PReLU, 80×80, ba lớp; `measurements/antispoof` §41), recog `20260908-1750`. Cùng cấu hình mục 1,
`bench_ai` với `CONFIG_AI_PROFILING=y`, 20 lần mỗi nhánh.

| Nhánh | Rảnh | Có tải preview | Bản 12/09 (mục 7) |
|---|---|---|---|
| detect | 231,7 ms | 269,8 ms | 232,5 ms |
| **anti-spoof** | **490,3 ms** | 571,2 ms (+16,5%) | 234,0 ms |
| recognition | 459,4 ms | 537,0 ms | 458,0 ms |
| **Một mặt đi hết ba nhánh** | **1.181,3 ms** | 1.378,1 ms | 924,5 ms |

### 9.1 Từng op của spoof — 491.202 µs

| Op | µs | % | ESP-NN |
|---|---|---|---|
| CONV_2D | 332.261 | 67,6% | ✅ |
| DEPTHWISE_CONV_2D | 93.292 | 19,0% | ✅ |
| PAD | 33.146 | 6,7% | ❌ |
| ADD | 29.708 | 6,0% | ✅ |
| FULLY_CONNECTED | 2.795 | 0,6% | ✅ |

**Vì sao gấp 2,1 lần bản 12/09.** Không phải vì PAD: bốn PAD của map chẵn tốn 33 ms, 6,7%. Là vì
phép tính: bản `minifasnet_v2_se` 81×81 có **24,6 MMAC**, bản nhập có **40,7 MMAC** (1,65×), gần
hết ở `CONV_2D` 1×1 mở kênh lên 103/231/308 trên map 40×40 và 20×20 (`conv_23`, `conv_34`,
`conv_45`). Phần còn lại là 12 `ADD` dư (30 ms) và PAD. 93,3% thời gian nằm trên kernel esp-nn,
nên đường giảm tiếp là kiến trúc, không phải op.

### 9.2 Bản PReLU gốc, đo một lần để có số, không nạp

Cùng trọng số, giữ 33 PReLU (run `20260916-0728`), đăng ký `PRELU` tạm trong `bench_ai` cho đúng
một lần đo, không commit, không nạp:

| Op | µs | % | ESP-NN |
|---|---|---|---|
| CONV_2D | 331.999 | 45,7% | ✅ |
| **PRELU** | **236.291** | **32,6%** | ❌ |
| DEPTHWISE_CONV_2D | 92.445 | 12,7% | ✅ |
| PAD | 33.012 | 4,5% | ❌ |
| ADD | 29.276 | 4,0% | ✅ |
| FULLY_CONNECTED | 2.881 | 0,4% | ✅ |

spoof **727,2 ms** rảnh, 847,2 ms có tải; `arena_big` dùng 746.380 B. 33 PReLU trên 607.000
phần tử tốn 236 ms, tức **389 ns một phần tử** qua kernel tham chiếu — gấp 1,48 lần cả nhánh
ReLU. Số này đóng câu hỏi "hay cứ giữ PReLU": không, và §9.3 cho thấy không cần.

### 9.3 Stem tách PReLU của `conv1` — bản lên `models.lock.json`

Run `20260916-0854`: PReLU của `conv1` viết lại bằng một `CONV_2D`, một `DEPTHWISE_CONV_2D` và
một `ADD` thêm vào (`measurements/antispoof` §41.7). Đo cùng cấu hình, 20 lần:

| | ReLU trơn `0729` | **Stem tách `0854`** | PReLU gốc `0728` |
|---|---|---|---|
| spoof rảnh | 490,3 ms | **535,3 ms** | 727,2 ms |
| spoof có tải preview | 571,2 ms | 624,1 ms | 847,2 ms |
| thật giữ / giả chặn, INT8, 87 khung | 59/62 · 25/25 | **62/62 · 25/25** | 62/62 · 25/25 |
| op ngoài esp-nn | PAD ×4 | PAD ×4 | PAD ×4 + PRELU ×33 |

Stem tách trả **+45 ms** (9,2%) cho ba mặt thật, so với +237 ms nếu giữ PReLU. Một mặt đi hết
ba nhánh với bản này: 🔬 chưa cộng lại từ log cuối, đọc ở `bench_0854` khi ghi lock.

---

## 10. Student width 32 thay bản nhập — đo 16/09

`models_0` mang spoof `20260916-1109` (ADR-0003, `measurements/antispoof` §42). Cùng cấu hình mục 1.

| Nhánh | Rảnh | Có tải preview | Bản nhập `0854` |
|---|---|---|---|
| detect | 232,5 ms | 270,7 ms | 232,5 ms |
| **anti-spoof** | **234,1 ms** | **273,8 ms** | 535,3 ms |
| recognition | 460,0 ms | 537,0 ms | 460,0 ms |
| **Một lượt ba nhánh** | **925,2 ms** | **1.080,1 ms** | 1.181,3 ms |

Nhánh spoof về đúng mức của bản một backbone 12/09 (234,0 ms) trong khi giữ 62/62 và 25/25 trên khung
của board, thứ bản 12/09 không làm được (nó mất 51/62, `measurements/antispoof` §41.9).

🔬 Một lượt **chấm công** cộng theo `kStableDetects = 2`: 1.159 ms so với 1.460 ms của bản nhập, tức
nhánh spoof hạ từ 37% xuống 20% tổng thời gian. Chưa đo đầu-cuối trên board.

Ngân sách §6.4 vẫn trượt: 360 ms cho ba nhánh, đang 925 ms. Chỗ tốn nhất giờ là recognition 460 ms
và detect 232 ms mỗi khung, không còn là spoof.

## 11. Hai ứng viên có khối SE trên board — đo 18/09, không nạp

Cùng `bench_ai`, cùng ba test, 20 lượt mỗi số, resolver nhánh chống giả **đăng ký tạm** `LOGISTIC` và
`MEAN` cho đúng lần đo này (build không commit, `MicroMutableOpResolver<10>`); facenox còn cần nới
`CONFIG_AI_ARENA_BIG_KB` 1536 → 3072 trong `sdkconfig` của app bench, cũng không commit.

| Model INT8 Q1, stem tách | MMAC | file | spoof rảnh | spoof có tải | ba nhánh rảnh | ba nhánh tải | arena_big |
|---|---|---|---|---|---|---|---|
| V2 `0854` (§9.3, đối chứng) | 42,6 | 586 KB | 535,3 ms | 624,1 ms | 1.181 ms | — | 744.428 B |
| **V1SE `0118`** | 42,7 | 602,5 KB | **581,0 ms** | **677,4 ms** | 1.272 ms | 1.483 ms | 748.524 B |
| facenox `0100`, 128 px | 108,9 | 644,1 KB | 1.452,4 ms | 1.691,1 ms | 2.143 ms | 2.497 ms | **1.684.700 B** |
| student `1109` (§10, đang nạp) | 24,6 | 425 KB | 234,1 ms | 273,8 ms | 925 ms | — | 422.764 B |

Đọc ra: V1SE tốn thêm **46 ms** so với V2 cùng cỡ MMAC — đúng phần ba khối SE chạy kernel tham chiếu
trên vector đã gộp, rẻ như dự đoán. facenox tốn gấp 2,7 lần V2 vì 108,9 MMAC ở 128 px, và **không
vừa cap arena 1,5 MB** của firmware (§6.4), nên không có đường nạp mà không đổi ngân sách bộ nhớ.
Không có bảng từng op vì build bench này không bật profiler.
