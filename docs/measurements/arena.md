# Arena TFLM — số đo trên board

Bảng của KẾ HOẠCH §3.10 và §6.4, đo trong `firmware/test_apps/bench_ai` với cả
ba model nạp từ partition `models_0`.

## 1. `tail` và `head` từng model — E8-T7

| Model | tail | head | riêng lẻ |
|---|---|---|---|
| detect | 26,6 KB | 158,4 KB | 185,0 KB |
| spoof | 109,3 KB | 229,1 KB | 338,4 KB |
| recog | 91,5 KB | 812,5 KB | 904,0 KB |

Cách lấy: `head` đọc từ lời từ chối của bộ cấp phát khi arena thiếu chỗ
(`Requested: N, available M`); tổng đọc từ `arena_used_bytes()` khi arena đủ
rộng; `tail` là hiệu. `tail_det` suy từ hệ: nạp riêng detect được 185,0 KB,
nạp thêm spoof lên 365,0 KB, mà `tail_spoof + head_spoof` đã biết.

## 1b. Sau khi sửa kiến trúc, và sau khi chia lại arena

`arena_fast` giữ **một mình detect** ở SRAM nội; `arena_big` cho **anti-spoof và
recognition dùng chung** một `MicroAllocator` ở PSRAM (§3.10).

| Arena | Dùng | Cấp | Ở đâu |
|---|---|---|---|
| `arena_fast` (detect) | **189.628 B** | 224 KB | SRAM nội |
| `arena_big` (spoof + recog) | **823.148 B** | 1536 KB | PSRAM |

Dùng chung có lãi đo được:

| | riêng | chung |
|---|---|---|
| spoof | 282 KB | |
| recog | 699 KB | |
| **Tổng** | **981 KB** | **803 KB** |

Tiết kiệm **178 KB (18%)**: head của spoof nằm gọn trong head của recog, chỉ
tail chồng lên nhau.

RAM nội còn trống sau khi nạp cả ba: **111 KB**. §6.4 còn nợ ~55 KB cho Wi-Fi +
lwIP và ~53 KB cho stack 10 task, tức 108 KB — vừa đủ, không dư.

## 2. Công thức §3.10 trả đúng cái nó hứa

`arena_fast` giữ detect và spoof trên **cùng một `MicroAllocator`**:

```
Σ tail + max(head) = 26,6 + 109,3 + max(158,4 ; 229,1) = 365,0 KB
```

| Cách cấp | Byte |
|---|---|
| Hai buffer rời (185,0 + 338,4) | 523,4 KB |
| Chung một allocator (đo thật) | **365,0 KB** |
| **Tiết kiệm** | **158,4 KB, tức 30%** |

Đúng bằng `head_det`, vì head của detect nằm gọn trong head của spoof. Đây là
lý do §3.10 bắt truyền `MicroAllocator*` chứ không truyền buffer.

Số cuối cùng đo được sau khi cả ba nạp xong:

| Arena | Cấp | Dùng | Ở đâu |
|---|---|---|---|
| `arena_fast` (detect + spoof) | 384 KB | **373.804 B** | PSRAM |
| `arena_big` (recog) | 1024 KB | **926.588 B** | PSRAM |

## 3. Không nhánh nào nằm được ở SRAM nội

| Xin arena ở đâu trong `app_main` | RAM nội trống | Khối liền lớn nhất |
|---|---|---|
| Sau `drv_camera_init()` | 192 KB | 143 KB |
| Ngay sau `sys_storage_init()` | 293 KB | ≥ 175 KB |

**Ràng buộc là tính liền mạch, không phải tổng.** `heap_caps_aligned_alloc` cần
một dải liền, mà bounce buffer LCD và mô tả DMA camera cắt heap thành mảnh. Vì
vậy `ai_engine_init()` chạy trước mọi driver (§3.10).

Nhưng ngay cả khi xin đầu tiên, `arena_fast` cần **365 KB** còn SRAM nội chỉ có
~293 KB, và đó là lúc chưa có Wi-Fi lẫn LVGL. **Với model hiện tại, không có
cấu hình nào đặt được detect ở SRAM nội.** Giá của việc đó nằm ở `latency.md`.

§6.4 dự trù 175 KB cho `arena_fast`. Thực tế cần 365 KB — hụt 2,1 lần, và đó là
trước khi tính `arena_big` 926 KB mà §6.4 không đặt ngân sách.

**Tách `head`/`tail` thì `head` vừa, nhưng không đủ tiền trả.** `head` của
`arena_fast` là 229,1 KB, mà khối liền nội lớn nhất lúc `ai_engine_init()` chạy
là 272 KB, nên đặt được. Đặt xong thì RAM nội trống còn **95 KB**, trong khi
§6.4 còn phải chi ~55 KB cho Wi-Fi + lwIP và ~53 KB cho stack 10 task. Mức thu
về chỉ 1,9% latency (`latency.md`), nên cơ chế tách đã bị gỡ khỏi `Arena`: nó
thua cả hai đầu — kém đặt cả arena vào SRAM về tốc độ, kém đặt cả arena vào
PSRAM về chỗ trống.

Con số 272 KB kia chỉ có sau khi buffer đầu vào của `bench_ai` chuyển sang
PSRAM. Để chúng ở `.bss` thì chúng chiếm 131 KB RAM nội và khối liền lớn nhất
tụt còn 144 KB — tức phép đo trước đó là của một con chip bị chính đồ đo làm
cho hẹp đi.

## 4. Ngân sách flash

| Nhánh | §1.1 ước tính | Đo thật | Chênh |
|---|---|---|---|
| detect (YuNet) | 76 KB | 158,9 KB | +109% |
| spoof (MiniFASNet ×2) | 525 KB | 877,7 KB | +67% |
| recog (MobileFaceNet) | 1.199 KB | 1.479,5 KB | +23% |
| **Tổng ảnh `models.bin`** | **1,80 MB** | **2.516,4 KB (2,46 MB)** | **+37%** |

Sau khi sửa kiến trúc: detect 158,9 KB, spoof 849,7 KB, recog 1.454,6 KB, ảnh
**2.463,6 KB**. Bỏ PReLU chỉ trả lại hệ số âm mỗi kênh nên flash gần như không
đổi — thứ nó trả lại là thời gian và arena.

`models_0` đã nâng từ 2 MB lên 3 MB (§6.1), còn dư 555 KB.

## 5. Bộ nhớ sau khi nạp xong

| | Còn trống |
|---|---|
| SRAM nội | 206 KB |
| PSRAM | 6.781 KB trong 8.192 KB |

Số đo ở `bench_ai`, tức **chưa có Wi-Fi, LVGL, camera hay LCD**. §6.4 tính
Wi-Fi + lwIP ~55 KB và stack 10 task ~53 KB đều ở SRAM nội, nên 206 KB kia sẽ
mỏng đi nhiều. Phải đo lại ở E8-T9 khi đã đủ thành phần.
