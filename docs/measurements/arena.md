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

## 1c. `arena_fast` xuống PSRAM — đo trên board 07/09 20:5x

`AI_ARENA_FAST_INTERNAL=n` đưa nốt detect xuống PSRAM. Cùng lúc `models.bin`
trên flash đã là bản recog hệ số width 32, nên `arena_big` co lại theo.

| | `arena_fast` ở SRAM nội | `arena_fast` ở PSRAM |
|---|---|---|
| `arena_fast` (detect) | 189.628 B | **189.628 B**, cấp 224 KB |
| `arena_big` (spoof + recog) | 823.148 B (recog w64) | **476.172 B** (recog w32), cấp 1536 KB |
| **RAM nội trống sau khi nạp cả ba** | 111 KB | **331 KB** |
| PSRAM trống | — | 6.295 KB |

Log của `ai_engine_init` nói thẳng arena không lấy một byte RAM nội nào:

```
ai_engine: arena_fast 224 KB in psram, arena_big 1536 KB, internal ram 331 to 331 KB
```

**Thu về 220 KB RAM nội.** §6.4 còn phải chi 267 KB cho Wi-Fi, stack, bounce
buffer LCD, buffer crop và heap dự phòng: 111 KB thiếu 156 KB, còn 331 KB thì
**dư 64 KB**. Đây là phép đo biến §6.4 từ không khả thi thành khả thi.

Kích thước model đọc từ partition: detect 158 KB, spoof 849 KB, recog **712 KB**.

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

---

## 6. Ảnh ba nhánh, đo lại toàn bộ — 09/09 18:0x

Lần đầu cả ba nhánh cùng nằm trên flash. `contracts/models.lock.json` chỉ mang
hai nhánh cho tới khi anti-spoof train xong, nên ảnh này pack bằng **lock thí
nghiệm** ở `ml/artifacts/bench3/` qua `--lock` và `--models-dir` (§6.2.2) —
`contracts/` và `firmware/models/` không bị đụng. Nhánh spoof lấy export 81×81
của run `20260909-1116` ở epoch 2: trọng số chưa train, mà latency và arena
không phụ thuộc trọng số.

```
detect  yunet_int8.tflite         160x120    158,9 KB
spoof   minifasnet_int8.tflite     81x81     849,7 KB
recog   mobilefacenet_int8.tflite 113x113    720,3 KB
models.bin  1.729,2 KB / 3.072 KB models_0, 3 of 3 branches
```

| Đại lượng | Đo lần này | Ghi ở §1c |
|---|---|---|
| `arena_fast` | 189.628 B | 189.628 B |
| `arena_big` | **476.188 B** | 476.172 B |
| RAM nội trống sau init | 331 KB | 331 KB |
| PSRAM trống | 6.295 KB | 6.295 KB |

Lệch 16 B ở `arena_big` là giữa hai export anti-spoof khác nhau, không phải sai
số phép đo — cả ba nhánh đều lặp lại dưới 0,05% qua 20 lần chạy.

Kích thước đầu vào đọc từ chính graph: detect 57.600 B = 160×120×3, spoof
19.683 B = 81×81×3, recog 38.307 B = 113×113×3.

**`arena_hint` vẫn bằng 0 và chưa điền được.** Header §6.2.2 cho mỗi model một
`arena_hint`, nhưng spoof và recog **chung một** `MicroAllocator`, mà 476.188 B
là `Σ tail + max(head)` của cặp — không tách thành hai số cộng lại đúng. Điền cả
hai là đếm đôi, chia hai là vô nghĩa. Cần chốt firmware lấy `max(arena_hint)`
trong nhóm chung arena, hay chỉ nhánh sizing mang số. Xem E9-T17.

---

## 7. `arena_hint` chạy thật, và `used` không phải kích thước đủ — 09/09 19:xx

`ai_engine` giờ cấp arena theo `arena_hint` trong ảnh `models_0`, Kconfig chỉ còn
là trần (§3.8). Đo trên board với ảnh ba nhánh:

```
I (439) ai_engine: arena_fast 190464 B in psram, arena_big 477184 B
           arena_fast 189628 B of 186 KB in psram
           arena_big  476188 B of 466 KB in psram
```

**`arena_used_bytes()` là chặn dưới, không phải kích thước đủ.** Quét trên board,
mỗi bước một lần ghi `models_0`:

| `arena_hint` của detect | Kết quả |
|---|---|
| **189.628** = đúng con `used` nó tự báo | **`AllocateTensors` TỪ CHỐI** |
| 189.632 = `used` + 4 B | chạy, `used` vẫn báo 189.628 |
| 189.712, 189.760, 189.824 | chạy |

Trong khi `arena_big` ở đúng `used` 476.188 B **lại chạy được**. Nên phần thiếu
vừa nhỏ vừa không đoán trước: TFLM cấp `tail` từ đỉnh xuống và `head` từ đáy lên,
đệm căn lề phụ thuộc chính địa chỉ và kích thước arena. Vì vậy `ai_engine` làm
tròn lên bội số **1 KB** sau khi lấy `max`, và `arena_hint` cứ ghi số `used` thô.

**Lãi 1.108 KB PSRAM.** Cấp theo số đo thay vì theo trần Kconfig:

| | Trần Kconfig | Theo `arena_hint` |
|---|---|---|
| `arena_fast` | 224 KB | **186 KB** |
| `arena_big` | 1536 KB | **466 KB** |
| Tổng cấp | 1.760 KB | **652 KB** |
| PSRAM trống sau init | 6.295 KB | **7.403 KB** |

`7.403 − 6.295 = 1.108 KB`, đúng bằng `1.760 − 652`. Latency không đổi: một lượt
1.159,7 ms so với 1.159,3 ms, lệch 0,03%; có tải preview 1.353,6 so với
1.353,1 ms. Arena nhỏ hơn không làm chậm gì — nó chỉ thôi giữ chỗ.

**Ba op của detect còn chạy kernel C tham chiếu**, thấy khi `update_lock` in bảng
op: `PAD` ×1 và `RESIZE_NEAREST_NEIGHBOR` ×2 (đường upsample của FPN). detect
chạy mỗi frame và đang tốn 232,4 ms, nên đây là đầu mối cho E9-T3 — 27 op còn
lại đều có kernel esp-nn.

---

## 8. Ảnh model mang số arena của chính nó — 12/09

`contracts/models.lock.json` khai `arena_bytes` **0 cho anti-spoof** và **476.188 B cho
recognition**, tức số của ảnh hai backbone, trong khi nhánh một backbone đã thay vào từ 12/09.
Cơ chế: `update_lock.py` để `--arena-bytes` mặc định 0, lần export cuối không truyền, nên phép
đo bị ghi đè bằng "chưa đo". Cờ này giờ **bắt buộc**, không có mặc định.

Cả hai ô mang **422.764 B** — tổng của nhóm, đúng luật §3.8 (`plan:2720`): hai nhánh chung một
`MicroAllocator` thì cả hai entry ghi cùng một con, `ai_engine` lấy `max` theo nhóm.

Đóng gói lại `models_0` rồi đọc trên board:

| | Trước | Sau |
|---|---|---|
| `arena_big` cấp | 477.184 B (466 KB) | **422.912 B (413 KB)** |
| spoof dùng | 210 KB | 210 KB |
| recog dùng | 412 KB | 412 KB |
| RAM nội trống sau init | 331 KB | 331 KB |

**Lãi 53 KB PSRAM**, và `recog: arena at 412 of 413 KB` cho thấy mức cấp mới sát đúng nhu cầu
chứ không dư. `arena_fast` không đổi: 189.628 B trong 186 KB.

Bài học: sửa lock mà không đóng gói lại ảnh thì board vẫn đọc header cũ — `meta.json` và
`models.lock.json` chỉ là nguồn, `models_0` mới là thứ thiết bị tin.

---

## 9. RAM đỉnh toàn hệ, kiosk chạy thật — E8-T9, 13/09

`firmware/test_apps/bench_mem` dựng đúng chuỗi `app_boot` + `app_tasks` của kiosk nên số dưới
đây là của thiết bị thật, không phải của một app rút gọn. Lần này **ngoại vi cắm đủ** (PCF8574
0x20, VL53L1X 0x29, DS3231 0x68, GT911 0x5D) nên `bsp_board_init()` đi qua được — lượt đo
12/09 abort ở đúng chỗ đó.

Build bằng profile `bench` (`-O2`, poisoning tắt, `FREERTOS_USE_TRACE_FACILITY` còn) chứ không
phải `dev`: poisoning thêm canary vào **mọi** khối nên nó thổi phồng đúng con số app này sinh ra.

| Mốc | Đáy RAM nội | Đáy PSRAM |
|---|---|---|
| trước `app_boot` | 255.483 B (249 KB) | 8.189 KB |
| sau `app_boot`, ba model đã nạp | 97.811 B (95 KB) | 5.844 KB |
| **kiosk chạy, 6 mẫu cách nhau 10 s** | **73.323 B (71 KB)** | **5.844 KB** |

Đáy giữ **nguyên 73.323 B qua cả sáu mẫu** — heap phẳng, không có chỗ nào rò theo khung.
Mảnh liền mạch lớn nhất lúc kết thúc: **32 KB**.

### 9.1 Watermark từng task

| Task | Prio | Stack trống |
|---|---|---|
| `ipc0` | 1 | **444 B** |
| `ipc1` | 24 | 532 B |
| `IDLE1` | 0 | 784 B |
| `IDLE0` | 0 | 792 B |
| `ai` | 5 | 1.524 B |
| `tof` | 6 | 1.560 B |
| `sys_evt` | 20 | 1.568 B |
| `Tmr Svc` | 1 | 1.448 B |
| `tcpip` | 18 | 2.240 B |
| `cam` | 7 | 2.768 B |
| `attend` | 4 | 2.812 B |
| `esp_timer` | 22 | 3.124 B |
| `cam_task` (của `esp32-camera`) | 23 | 3.356 B |
| `wifi` | 23 | 4.540 B |
| `main` | 1 | 5.824 B |

Bốn task mỏng nhất đều **của IDF**, không phải của dự án; `ipc0` ra khỏi xưởng đã sát đáy.
Mỏng nhất trong bốn task của `app_tasks.c` là `ai` với 1.524/8.192 B — và đó là số lúc **chưa
có mặt người nào** trước camera, tức mới chỉ chạy detect. Spoof và recog đi sâu hơn nên phải
đo lại watermark này khi có mặt thật.

### 9.2 Đối chiếu §6.4

§6.4 ước 267 KB cho năm dòng chưa chi và ghi "còn dư 64 KB" khi cả hai arena xuống PSRAM.
Đo thật: hệ đi từ 331 KB trống (chỉ có model) xuống **71 KB** khi camera, LCD, ToF, servo,
`svc_facedb`, `svc_vision`, `svc_attendance` và ngăn xếp Wi-Fi cùng lên — tức **260 KB đã chi**,
sát con số ước 267 KB một cách bất ngờ.

Nhưng bảng ấy chưa trả hết: **LVGL chưa tồn tại**, và Wi-Fi lần này **chỉ quay số chứ không vào
được mạng** (`disconnected 8 time(s)`, AP không có mặt), nên chưa có phiên TCP nào và 30 KB bắt
tay TLS của dòng "heap dự phòng" chưa bị đụng tới.

**Ràng buộc cho E10-T1**: còn **71 KB RAM nội, mảnh liền lớn nhất 32 KB**. Đệm vẽ của LVGL vì
thế không thể xin quá 32 KB ở RAM nội, và heap LVGL phải nằm ở PSRAM — chỗ còn 5,8 MB.

### 9.3 Hai điều lộ ra ngoài đề

**Profile build đổi fps 7%.** Cùng board, cùng phòng: bản `bench` (`-O2`) đo **14,17–14,19 fps**,
bản `dev` (`-Og` + `HEAP_POISONING_LIGHT`) đang nằm trên board đo **12,9–13,7 fps**. Mọi con số
fps của phiên LCD đều lấy trên bản `dev`, nên khi quay lại việc đó phải nói rõ đang đứng ở profile nào.

**`unity_run_menu()` bỏ đói `IDLE0`.** Sau khi hai case xong, watchdog bắn `IDLE0` mỗi 5 giây,
CPU 0 lúc thì `main` lúc thì `cam`. Đây là chuyện của app test chứ không phải của kiosk: menu
tương tác dò `stdin` không nhường, còn firmware chính không có menu và chạy cả tiếng không một
lần watchdog kêu. Không sửa, ghi lại để lần sau đọc log `bench_mem` đừng tưởng kiosk hỏng.

---

## 10. Ảnh spoof bằng trọng số nhập — `arena_big` lên 743.468 B, 16/09

Spoof `20260916-0729` (MiniFASNetV2 minivision, 80×80, ReLU) thay bản một backbone. Hint cũ
422.764 B làm `AllocateTensors` **từ chối** spoof ở 413 KB. Đo bằng `bench_ai` với hint tạm
1.048.576 B rồi ghi lại hint theo số `used`:

| | Bản 12/09 (§8) | Bản 16/09 |
|---|---|---|
| spoof một mình, `arena at` | 210 KB | **670 KB** |
| recog cộng thêm | 412 KB | 726 KB |
| `arena_big` `used` | 422.764 B | **743.468 B** |
| `arena_big` cấp theo hint | 422.912 B (413 KB) | **744.448 B (727 KB)** |
| file spoof trên `models_0` | 424 KB | **586 KB** |
| `models.bin` | — | 1.500.896 B |
| RAM nội trống sau init | 331 KB | 329 KB |
| PSRAM trống sau init | 7.537 KB | 6.865 KB |

Bản lên lock là stem tách `20260916-0854` (§41.7 của antispoof): spoof một mình **671 KB**, chung với
recog **744.428 B** `used` — thêm 960 B so với bản ReLU trơn cho hai tensor 40×40×32 của nhánh
âm. Hai entry dùng chung `arena_big` (antispoof, recognition) cùng mang **744.428 B** theo luật §3.8.
Kiểm lại sau khi đóng gói với hint mới: `recog: arena at 726 of 727 KB`, 20 lần chạy mỗi nhánh
đều qua — khít, không dư. Vì sao spoof cần 670 KB: lớp `conv_23` mở 32→103 kênh trên map 40×40
(164.800 B) rồi PAD ra 41×41×103 (173.103 B) trước depthwise stride 2, hai tensor ấy sống cùng
lúc trong `head`.

---

## 11. Student width 32 — `arena_big` về lại 422.764 B, 16/09

Spoof `20260916-1109` (ADR-0003) thay bản nhập `0854`:

| | bản nhập `0854` | student `1109` |
|---|---|---|
| spoof một mình, `arena at` | 671 KB | **210 KB** |
| `arena_big` `used` chung với recog | 744.428 B | **422.764 B** |
| file spoof trên `models_0` | 586 KB | **425 KB** |
| MMAC | 42,6 | 24,6 |

Lãi **321.664 B PSRAM** so với bản nhập, và trùng đúng con số của bản một backbone 12/09 (§8) vì cùng
kiến trúc width 32 — chỉ khác view đọc vào là crop ngữ cảnh 2,7× thay vì crop mặt 1,0×.

---

## 12. V1SE nhập thay student — `arena_big` lên 748.524 B, 18/09

Spoof `20260918-1050_aa7e463_e66877` (ADR-0004) thay student `1109`; số từ `bench_ai` trên graph
`0118` cùng kiến trúc và từ log boot của app chính:

| | student `1109` | bản nhập `0854` | **V1SE `1050`** |
|---|---|---|---|
| spoof một mình, `arena at` | 210 KB | 671 KB | **675 KB** |
| `arena_big` `used` chung với recog | 422.764 B | 744.428 B | **748.524 B** (board làm tròn 16: 748.544) |
| file spoof trên `models_0` | 425 KB | 586 KB | **600,6 KB** |
| MMAC | 24,6 | 42,6 | 42,7 |

`max(head)` lại là spoof (675 KB) thay cho recog (412 KB), nên `arena_big` trả lại đúng khoản lãi của
§11 cộng **4.096 B** so với `0854`; phần chênh đúng cỡ các vector gộp 1×1 và vector cổng của ba khối
SE, chưa tách từng tensor để chốt. Vẫn trong PSRAM, dưới cap `CONFIG_AI_ARENA_BIG_KB` 1536 KB. Ứng viên facenox cùng đợt cần 1.684.700 B và bị loại ở đây
(`quant_ladder.md` §8).

---

## 13. Đo lại RAM đỉnh sau khi có UI, loa và Wi-Fi vào mạng — E8-T9, 18/09

Lượt 13/09 (§9) ghi rõ hai khoản của §6.4 **chưa trả đồng nào**: giao diện chưa tồn tại, và
Wi-Fi quay số mà không vào được mạng nên không có phiên TCP. Từ đó `ui_kiosk` lên với sáu màn
hình cộng lớp phủ, `audio_task` giữ clip trong PSRAM, và lượt này Wi-Fi **vào mạng thật**
(`ip 192.168.185.107`, SNTP chỉnh đồng hồ ở 40,3 s). Cùng dụng cụ, cùng profile `bench`.

| Mốc | Đáy RAM nội 13/09 | **Đáy RAM nội 18/09** | Đáy PSRAM 18/09 |
|---|---|---|---|
| trước `app_boot` | 255.483 B (249 KB) | **248.331 B (242 KB)** | 8.189 KB |
| sau `app_boot`, ba model đã nạp | 97.811 B (95 KB) | **85.699 B (83 KB)** | 5.198 KB |
| kiosk chạy, 6 mẫu cách nhau 10 s | 73.323 B (71 KB) | **41.531 B (40 KB)** | **5.070 KB** |

Đáy đứng **nguyên 41.531 B qua cả sáu mẫu**, heap vẫn phẳng, không có chỗ rò theo khung.
Mảnh liền mạch lớn nhất lúc kết thúc: **31 KB** (13/09: 32 KB).

RAM nội mất thêm **31.792 B** so với 13/09, chia ba chỗ: 7.152 B là `.bss` của `ui_kiosk` và
`drv_audio` (thấy ngay ở mốc trước `app_boot`), 4.960 B nữa hiện ra sau `app_boot`, phần còn
lại là ba task mới cộng phiên TCP thật. PSRAM mất 774 KB, phần lớn là 128 KB clip âm thanh và
các đệm lớp phủ của `ui_kiosk`.

### 13.1 Watermark từng task

| Task | Prio | Stack trống 13/09 | **18/09** |
|---|---|---|---|
| `ipc0` | 1 | 444 B | **444 B** |
| `ipc1` | 24 | 532 B | 564 B |
| `IDLE1` | 0 | 784 B | 784 B |
| `IDLE0` | 0 | 792 B | 792 B |
| **`ai`** | 5 | 1.524 B | **1.284 B** |
| `Tmr Svc` | 1 | 1.448 B | 1.448 B |
| `sys_evt` | 20 | 1.568 B | 1.472 B |
| `touch` | 5 | — | 1.484 B |
| `tof` | 6 | 1.560 B | 1.640 B |
| `tcpip` | 18 | 2.240 B | 1.736 B |
| `audio` | 6 | — | 2.364 B |
| `cam` | 7 | 2.768 B | 2.672 B |
| `attend` | 4 | 2.812 B | 2.836 B |
| `esp_timer` | 22 | 3.124 B | 3.124 B |
| `cam_task` (`esp32-camera`) | 23 | 3.356 B | 3.344 B |
| `wifi` | 23 | 4.540 B | 4.316 B |
| `ui` | 4 | — | 6.772 B |
| `main` | 1 | 5.824 B | 5.632 B |

`ai` mỏng đi 240 B và vẫn là task mỏng nhất của dự án: **1.284 / 8.192 B**. Số này vẫn đo lúc
**chưa có mặt người nào** trước camera nên mới chỉ có detect chạy — ghi chú của §9.1 còn nguyên.
`ui` cấp 8 KB mà chỉ dùng hơn 1 KB, còn dư 6.772 B.

> Bảng chi tiết **ai ăn bao nhiêu RAM nội** — tĩnh theo component, ngăn xếp từng task, bản đồ
> vùng heap — nằm ở `ram.md`. Điểm phải nhớ: heap nội **không liền một khối**, heap chính 244 KB
> đã đầy với mảnh lớn nhất 4 KB, và cả 31 KB liền mạch nằm ở một vùng riêng chưa ai đụng tới.

### 13.2 Hệ quả cho `net_mqtt` + TLS (E10-T6)

Còn **40 KB RAM nội, mảnh liền lớn nhất 31 KB**, và khoản duy nhất của §6.4 chưa trả là bắt
tay TLS. Mặc định mbedTLS của IDF 6.0 là `MBEDTLS_ASYMMETRIC_CONTENT_LEN=y` với đệm vào
**16.384 B** và đệm ra **4.096 B**, tức **20 KB mỗi phiên TLS**, mà đệm vào phải xin **một dải
liền 16 KB** từ đúng mảnh 31 KB kia. Cộng ngăn xếp `mqtt_task` 6 KB và `sync_task` 5 KB của
§5.2 — ngăn xếp task lấy từ RAM nội — thì 40 KB tiêu gần hết trước khi phân tích chuỗi chứng
thư của broker.

Ba cần gạt, đều là Kconfig, **không sửa một dòng code nào**, chưa chốt cái nào:

| Cần gạt | Thu về | Cái giá |
|---|---|---|
| `MBEDTLS_EXTERNAL_MEM_ALLOC=y` | toàn bộ heap mbedTLS sang PSRAM (còn 5 MB) | mbedTLS chạy trên PSRAM, chậm hơn; đã đủ điều kiện vì `SPIRAM_USE_MALLOC=y` |
| `MBEDTLS_SSL_IN_CONTENT_LEN` hạ từ 16.384 | tới 14 KB RAM nội | 🔬 phải đo chuỗi chứng thư thật của broker: bản tin bắt tay lớn hơn đệm là hỏng tay bắt, không phải chậm |
| `MBEDTLS_DYNAMIC_BUFFER=y` | trả đệm lại giữa hai lần bắt tay | mỗi lần nối lại phải xin lại, gặp phân mảnh thì trượt |

### 13.3 Khoản "mất ~52 KB chưa quy được" của E8-T9 đã quy xong

Bản chẩn đoán sáng 18/09 đo trên profile **`dev`** cho đáy **9.983 B** và mảnh liền lớn nhất
**7.668 B**, đem so với đáy 73.323 B ngày 13/09 thì thành "mất 63 KB không biết vì đâu". Hai
phép đo ấy **khác profile**, nên phép trừ vô nghĩa. Đo lại cùng profile thì tách được sạch:

| Phép trừ | Cùng điều kiện gì | Chênh |
|---|---|---|
| `bench` 13/09 → `bench` 18/09 | cùng profile, khác lượng code | **31.792 B** — UI, loa, phiên TCP thật |
| `bench` 18/09 → `dev` 18/09 | cùng lượng code, khác profile | **31.548 B** — `HEAP_POISONING_LIGHT` và `-Og` |
| tổng | | 63.340 B = đúng 73.323 − 9.983 |

Nên **một nửa khoản hụt là cái giá của profile gỡ lỗi, không phải của tính năng mới**. Hệ quả
thực tế: bản `dev` còn mảnh liền lớn nhất **7.668 B** thì `net_mqtt` + TLS **không có cửa** —
đệm vào 16 KB không xin nổi. Muốn thử MQTT trên board phải nạp bản `bench` hoặc `prod`, và số
40 KB / 31 KB ở trên mới là số để cân E10-T6.
