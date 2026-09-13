# Sổ kiểm lỗi đồng thời FreeRTOS

Danh mục những kiểu hỏng mà một hệ nhiều task hay dính, kèm **cách kiểm bằng máy** và **trạng
thái hiện tại của repo này**. Soát lại mỗi khi thêm một task, một khoá hay một hàng đợi — đó là
lúc các luật dưới đây bị phá, không phải lúc viết code mới.

Bảng task, hàng đợi và khoá là KẾ HOẠCH §5. File này không chép lại chúng, nó chỉ hỏi
"chúng có dính mấy lỗi kinh điển không".

Ký hiệu: ✅ đã kiểm và sạch · ⚠ có phát hiện, xem §13 · ⏳ chưa kiểm được vì phần liên quan
chưa tồn tại.

Số kèm chú thích *(bản đồ)* là số đo của tài liệu tham khảo trên phần cứng khác, để làm mốc
độ lớn — **không phải** số đo của dự án này. Số đo của dự án nằm ở `docs/measurements/`.

---

## 0. Tóm tắt: bẫy nào tránh được, tránh bằng cách nào

Ba cột dưới đây là thứ đáng đọc nhất của cả file: **không phải "sạch" mà là "sạch nhờ đâu"**.
Một bẫy tránh được do may thì lần sau vẫn dính.

### 0.1 Đã dính, đã sửa — có bằng chứng trên board

Ba ca này chứng minh danh mục không phải lý thuyết. Cả ba đều **im lặng** cho tới lúc đo.

| Bẫy | Dính ở đâu | Triệu chứng | Cách ra |
|---|---|---|---|
| **Tràn stack** (6.1) | `sys_storage`, case `append` | Panic **2 trên 3 lần boot**, lần thứ ba in `11 Tests 0 Failures` **che mất hai panic** | Đo được đường `append` qua LittleFS ăn **~2,2 KB stack**, task chính chỉ còn 1.348/3.584 B sau 16 lần ghi. Nâng stack (E7-T10) |
| **Phân mảnh heap** (7.2) | `arena_fast` xin sau `drv_camera_init()` | RAM nội **trống 192 KB** mà `heap_caps_aligned_alloc` vẫn trượt | Mảnh liền mạch lớn nhất chỉ **143 KB** — bounce buffer LCD và mô tả DMA camera cắt heap thành mảnh. Chuyển arena xuống PSRAM (`arena.md` §1c, §3) |
| **Pool nhỏ hơn nhịp tiêu thụ** (9.14) | `fb_count` 3 với `q_frame` depth 1 | Preview tụt **14,18 → 8,1 fps** khi nối `ai_task` | `ai_task` giữ một khung tới 2 s và `cam_task` giữ một khung lúc vẽ, nên với 3 khung không còn ô nào để lấp và chu kỳ thành *lấp + xử lý* thay vì `max(lấp, xử lý)`. Lên 4 khung (`latency.md` §6) |

Điểm chung: **cả ba đều được tìm ra bằng phép đo, không cái nào lộ ra khi đọc code.** Bài học
của ca thứ nhất đắt nhất — một lần chạy xanh đã che hai lần panic, nên "chạy thấy ổn" không
phải bằng chứng.

### 0.2 Tránh được, và nhờ đâu

| Bẫy | Tránh nhờ | Bằng chứng |
|---|---|---|
| Mutex chờ vô hạn (10.1) | `LockGuard` **bắt buộc nhận timeout**, CLAUDE.md §4.1 cấm `portMAX_DELAY` cho mutex | `grep` ra **0 chỗ** |
| Rò khung ở queue ghi đè (9.8) | `offer_to_ai` hút khung cũ **trả về pool** trước khi gửi, gửi hỏng cũng trả | Đọc `app_tasks.c:97` |
| Rò và phân mảnh heap (7.1, 7.2) | Khuôn **xin lúc boot, không bao giờ trả** cho arena, bảng embedding và pool khung | Heap phẳng trong 56 B suốt một phút soak |
| IDLE đói → watchdog (2.3) | `cam_task` hết khung thì `vTaskDelay(1)`; `ai_task` nhường một tick mỗi khung | §5.1 của kế hoạch, và watchdog im trên board |
| Bẫy đơn vị watermark (6.2) | Code nhân `sizeof(StackType_t)` thay vì hằng số 4 | `portSTACK_TYPE` là `uint8_t` nên nhân 1 — đúng ở đây **và** trên port khác |
| `pdMS_TO_TICKS` về 0 tick (4.1) | `CONFIG_FREERTOS_HZ=1000`, sàn 1 ms | Ràng buộc này **phụ thuộc config** — hạ tick rate là dính lại |
| Đảo ngược ưu tiên (10.4) | Khoá dùng mutex thật, semaphore chỉ để báo hiệu ISR→task | Bốn mutex, hai semaphore, không cái nào lẫn vai |
| Deadlock (10.2) | Thứ tự khoá chốt ở §5.3; chỗ duy nhất lồng ba khoá đi đúng chiều | `FaceDb::persist` lấy `m_facedb_io` rồi `m_facedb` rồi mới `m_littlefs` |
| ISR chạm PSRAM (8.4) | Hai ISR chỉ đụng handle semaphore | Đọc `drv_tof.c`, `drv_lcd.c` |
| Cấp phát động sau boot (7.7) | CLAUDE.md §4.1 cấm `new`/`delete` sau boot | `grep` ra **0 chỗ** |
| Mất quyền sở hữu con trỏ (9.7) | `cam_task` không đụng `frame` sau khi gửi; `blit` xảy ra **trước** | Đọc `cam_task` |
| Không kiểm `xQueueReceive` (9.2) | Mọi lời gọi đều nằm trong điều kiện | `grep` ra **0 chỗ** trần |
| `malloc` mỗi vòng gửi (9.13) | Khung đi qua pool cấp sẵn của `esp32-camera` | `grep` ra **0 chỗ** |

Ba dòng đầu là **luật trong CLAUDE.md hoặc kế hoạch**, không phải thói quen. Đó là lý do chúng
giữ được khi thêm người và thêm task — còn những dòng dựa vào "code hiện đang đúng" thì phải
soát lại mỗi lần sửa.

### 0.3 Đã dính, đã sửa — tìm ra bằng đọc code

Ba ca ở §0.1 chỉ lộ ra khi đo. Ba ca dưới đây thì ngược lại: **phép đo không thấy cái nào**,
vì cả ba chỉ nổ khi hai task chạm nhau đúng lúc — mà cái "đúng lúc" ấy chưa từng xảy ra trên
bàn. Danh mục này là thứ tìm ra chúng.

| # | Bẫy | Chỗ | Cách ra |
|---|---|---|---|
| **P1** | Giữ khoá suốt lời gọi chặn dài (10.3) | `FaceDb::persist` giữ `m_facedb` 1,8–2,3 s trong khi `lookup` chỉ chờ 200 ms, và `pipeline.cpp` đọc mọi lỗi tra cứu thành `UNKNOWN` → **người thật bị từ chối** vì ai đó vừa đăng ký | `m_facedb_io` xếp hàng người ghi với nhau, phép ghi chạy ngoài `m_facedb`; pipeline tách "bảng nói không" khỏi "bảng không trả lời" (E10-T11) |
| **P2** | Task có watchdog mà chặn vô hạn (12.2) | `ai_task` chặn `portMAX_DELAY` trên `q_frame` → camera chết thì watchdog **kêu nhầm tên** | Chờ 2 s, hết hạn thì nạp watchdog và log hàng đợi cạn (E10-T12) |
| **P3** | Gửi queue bỏ qua kết quả (9.3) | `xQueueSend(results, 0)` không kiểm giá trị trả về → một `MATCH` rơi là **một lần chấm công mất** | Chờ 100 ms rồi log kind phải bỏ (E10-T12) |

### 0.4 Đang dính, chưa sửa

| # | Bẫy | Chỗ | Row |
|---|---|---|---|
| **P4** | App chạy lâu nhất không bật bắt lỗi heap (7.3) | `soak` đã lấy `sdkconfig.dev` và `bench_mem` lấy `sdkconfig.bench`; **còn nợ lượt chạy 24 giờ** | E10-T8 |
| **P5** | `prod` tắt poisoning nên hỏng heap ngoài hiện trường là vô hình | profile build | — |

### 0.5 Chưa kiểm được

Sáu task của E10 và E13 chưa tồn tại, nên §14 liệt kê những gì phải chạy lại khi chúng lên.
**Danh mục này chỉ đúng tới ngày ghi** — thêm một task là phải soát lại từ §1.

---

## 1. Vòng đời task

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 1.1 | `vTaskDelete` không trả bộ nhớ ngay — **IDLE mới là kẻ đi dọn** | Task ưu tiên cao chiếm CPU mãi thì IDLE không chạy và stack không bao giờ về | ✅ `net_task` tự xoá ở core 0, nơi mọi task đều có chỗ chặn nên IDLE0 chạy |
| 1.2 | Task tự xoá mà chưa tự dọn tài nguyên của mình | Đọc thân task trước mỗi `vTaskDelete(NULL)` | ✅ `net_task` không xin heap, `host` nằm trên stack của chính nó |
| 1.3 | `vTaskSuspend` **xoá phần trễ còn lại** — xin ngủ 3000 ms có thể tỉnh sau 57 ms *(bản đồ)* | `grep vTaskSuspend` | ✅ không dùng |
| 1.4 | Xoá task đang giữ khoá | Kiểm task nào cầm mutex | ✅ task duy nhất tự xoá không cầm khoá nào |
| 1.5 | Stack và TCB cấp động nên `xTaskCreate` **có thể thất bại** | Kiểm giá trị trả về | ✅ `app_tasks_start` trả `ESP_ERR_NO_MEM` khi `pdPASS` không về |

`xTaskCreateStatic` đưa stack và TCB vào `.bss`, heap mất 0 B thay vì cỡ stack cộng 108 B dôi
*(bản đồ)*. Bốn task sống suốt đời chương trình (`cam`, `tof`, `ai`, `attend`) là ứng viên,
**chưa làm** — đổi sang static thì thiếu RAM sẽ lộ lúc **link** thay vì lúc chạy.

---

## 2. Trạng thái và bộ lập lịch

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 2.1 | Nhầm `blocked` với `suspended` — một cái **tự nguyện**, một cái **bị áp đặt** | Đọc mã | ✅ hệ này chỉ dùng blocked |
| 2.2 | Tưởng task bị chen ngang thì vào Blocked; thật ra nó về **Ready** | — | — |
| 2.3 | **Bỏ đói**: task ưu tiên cao không bao giờ Blocked → luôn Ready → luôn được chọn → IDLE đói → `Task watchdog got triggered · IDLE0` | Tìm `for(;;)` không có lời gọi chặn | ✅ xem §3 |
| 2.4 | `vTaskDelay(0)` **không** đưa vào Blocked, chỉ nhường cho task **cùng** mức | `grep "vTaskDelay(0)"` | ✅ không dùng |
| 2.5 | Xếp ưu tiên theo "task nào quan trọng" thay vì theo **độ gấp của hạn chót** | Đối chiếu §5.2 | ✅ `cam` 7 vì mất khung là mất vĩnh viễn; `ai` 5 vì nó chiếm core riêng |
| 2.6 | Ghim core sai | `AI_TASK_CORE` | ✅ core 1 chỉ có `ai_task` |

| 2.7 | Tưởng bộ lập lịch là một task nền ngồi canh chừng — **nó là một HÀM**. Không có gì xảy ra thì không một dòng lệnh nào của nó chạy | — | nên chia nhiều task **không** tốn công quản lý thường trực |
| 2.8 | Thang ưu tiên 0…24, đặt ở **tham số thứ năm** của `xTaskCreate` | Đọc `kTasks[]` | ✅ `cam` 7 · `tof` 6 · `ai` 5 · `attend` 4 · `net` 3, không chạm trần 24 |
| 2.9 | `vTaskPrioritySet` có hiệu lực **ngay trong lời gọi**, không đợi tick | `grep vTaskPrioritySet` | ✅ không dùng — ưu tiên chốt lúc tạo |
| 2.10 | Chen ngang xảy ra **giữa chừng bất cứ việc gì**, kể cả giữa một lệnh | — | xem 2.11 |
| 2.11 | **Tài nguyên ra dùng chung bị cắt xen**: hai task cùng ghi console thì chữ của task này rơi vào giữa từ của task kia | Kiểm task nào ghi ra console | ✅ `ESP_LOGx` đi qua `s_log_mutex` của IDF (`log/src/os/log_lock.c`) nên **dòng không xé**. `printf` trần thì không có bảo đảm ấy — trong repo chỉ test app dùng, mà unity chạy tuần tự một task |
| 2.12 | **Khoá log của IDF lấy bằng `portMAX_DELAY`** — một lời `ESP_LOGx` có thể chặn vô hạn sau lưng mình | Đọc `log_lock.c` | ✅ là mutex nên có kế thừa ưu tiên, không đảo ngược. Nhưng đây là lý do **không log trong vùng khoá** và **không log trong ISR** |

Chia task **không** làm nhanh lên — vẫn từng ấy việc trên một CPU. Cái đắt không phải chi phí
đổi task (4,19 µs, khoảng 0,17% khi 100 lần/giây *(bản đồ)*) mà là **stack** và **lỗi đồng
thời**. `taskYIELD()` đo được 5,418 µs *(bản đồ)* và đó là **cận dưới**, đo lúc chỉ một task
Ready.

---

## 3. Chặn đúng cách

**Luật**: mỗi vòng lặp phải có ít nhất một chỗ đưa task vào Blocked.

| Chờ gì | Dùng gì | Chỗ dùng trong repo |
|---|---|---|
| Thời gian | `vTaskDelayUntil` | ⚠ `tof_task` dùng `vTaskDelay`, xem 5.2 |
| Dữ liệu do task khác sinh | `xQueueReceive` | `ai_task`, `attend_task` |
| ISR báo có việc | `xSemaphoreTake` | `drv_tof` |
| Thiết bị đọc/ghi xong | Hàm của trình điều khiển | `drv_camera_grab` |

Cấm dùng `vTaskDelay` để **hỏi vòng** dữ liệu: 10 ms thì trễ, 1 ms thì đốt CPU. Chặn lành rẻ
hơn hỏi vòng **1,96×** *(bản đồ)*, vì kernel gỡ task khỏi Ready nên nó không tốn chu kỳ nào.

| # | Kiểu hỏng | Trạng thái |
|---|---|---|
| 3.1 | Vòng lặp không có chỗ chặn | ✅ `cam_task` hết khung thì `vTaskDelay(1)` thay vì quay vòng |
| 3.2 | Hỏi vòng thay cho chặn | ✅ không có |

---

## 4. Thời gian và tick

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 4.1 | **`pdMS_TO_TICKS` làm tròn XUỐNG** — ở 100 Hz thì `pdMS_TO_TICKS(5)` ra **0 tick** và trình dịch không hé một lời | `CONFIG_FREERTOS_HZ` so với giá trị nhỏ nhất truyền vào | ✅ **1000 Hz**, tick 1 ms, nên mọi giá trị ≥ 1 ms đều ra ≥ 1 tick. **Hạ `FREERTOS_HZ` là mọi chỗ chờ ngắn im lặng thành 0** |
| 4.2 | `vTaskDelay(N)` ngủ thật `(N−1) × tick + pha`, không phải `N × tick` | — | ✅ nhịp nhỏ nhất của hệ là 70 ms, sai một tick 1 ms không đáng |
| 4.3 | Sai số cộng dồn khi dùng `vTaskDelay` cho việc định kỳ | Tìm vòng định kỳ | ⚠ xem 5.2 |
| 4.4 | Độ phân giải tick không đủ cho yêu cầu | Đối chiếu nhịp cần | ✅ preview 70 ms, ToF 100 ms |

---

## 5. Nhịp định kỳ

| # | Kiểu hỏng | Trạng thái |
|---|---|---|
| 5.1 | Dùng `vTaskDelay` cho việc cần **mốc tuyệt đối** | ⚠ xem dưới |
| 5.2 | **`tof_task` dùng `vTaskDelay(TOF_POLL_MS)`** nên chu kỳ bằng 100 ms **cộng** thời gian xử lý, trôi dần | Chấp nhận được vì nó chỉ dò hiện diện, không phải đồng hồ. **Ghi lại để không nhân ra chỗ cần nhịp chuẩn** — chỗ đó phải là `vTaskDelayUntil` |

---

## 6. Ngăn xếp

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 6.1 | Tràn stack, triệu chứng là panic **ở chỗ hoàn toàn không liên quan** | `uxTaskGetSystemState` lấy watermark mọi task | ✅ `soak` và `bench_mem` in mỗi mẫu |
| 6.2 | **Bẫy đơn vị**: kernel gốc trả **word**, IDF trả **byte** | Đọc `prvTaskCheckFreeStackSpace`: nó chia cho `sizeof(StackType_t)`, mà trên Xtensa `portSTACK_TYPE` là **`uint8_t`** nên chia cho 1 → **byte** | ✅ code nhân với `sizeof(StackType_t)` = 1, đúng ở đây **và** đúng trên port có word 4 B |
| 6.3 | Canary chỉ kiểm **lúc đổi task** — tràn rồi hồi giữa chừng thì không ai báo | `CONFIG_FREERTOS_CHECK_STACKOVERFLOW` | ⏳ kiểm khi chốt sdkconfig prod |
| 6.4 | `printf`/`vsnprintf` riêng nó ăn khoảng 1 KB stack | Đối chiếu stack khai với chỗ có `printf` | ✅ task nhỏ nhất là `tof` 3 KB, không `printf` trong vòng lặp |
| 6.5 | `vTaskList` cần ~40 B mỗi task — để `static`, đừng để trên stack | Đọc `soak.c`, `bench_mem.c` | ✅ `s_tasks[32]` khai `static` |
| 6.6 | Mảng lớn trong thân hàm | `grep "\[[0-9]\{3,\}\]"` | ✅ buffer lớn đều `static` hoặc `heap_caps_malloc` |
| 6.7 | Đệ quy | Đọc mắt | ✅ không có |
| 6.8 | Cấp stack dư không làm task ăn thêm — nó vẫn dùng đúng phần nó cần *(bản đồ: 892 B ở mọi cỡ)* | — | dùng watermark để cắt, đừng đoán |

Watermark đo 11/09: `cam` 2644, `attend` 2968, `tof` 1568, **`ai` 1532 B trống** — mỏng nhất, và
đo khi mới có detect chạy. Phải đo lại khi spoof với recog chạy sâu (E10-T8).

**Ba chỗ tranh nhau đúng một khối RAM vật lý**, và mỗi chỗ hỏng ở một thời điểm khác nhau:

| Chỗ | Chia lúc nào | Hỏng lúc nào | Ai thấy trước |
|---|---|---|---|
| `.data` / `.bss` tĩnh | biên dịch | **link** | mình, trên máy mình |
| Stack | tạo task | **chạy** — tràn, đè hàng xóm | mình, nếu may |
| Heap | chạy | **chạy** — trả `NULL` | **khách hàng, trên bàn của họ** |

Stack **tự dọn**: gọi hàm đẩy thêm một tầng, ra khỏi hàm bỏ đi một tầng. Đó là lý do nó không
rò được, và cũng là lý do nó không nới được. `.bss` tốn **0 byte flash**; `.data` tốn flash
đúng bằng cỡ mảng — khai mảng lớn có giá trị khởi tạo là trả tiền hai lần.

---

## 7. Heap

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 7.1 | Rò: xin mà không trả. **Vi điều khiển không có ai thu hồi** — chỉ hết khi khởi động lại | Đo heap trước và sau **một chu kỳ đầy đủ** | ✅ `soak` so mẫu đầu với mẫu sau; heap phẳng trong 56 B suốt một phút |
| 7.2 | **Phân mảnh**: tổng trống còn nhiều mà **dải liền mạch** thì hết. *(bản đồ: trống 31.083 B, xin 20 KB vẫn trượt, mảnh lớn nhất 7.936 B)* | `heap_caps_get_largest_free_block`, **không** chỉ `get_free_size` | ✅ `bench_mem` in cả hai. Dự án đã dính đúng lỗi này một lần: `arena.md` §1c — trống 192 KB mà mảnh to nhất 143 KB nên arena lùi xuống PSRAM |
| 7.3 | Hỏng heap: ghi lố ra ngoài khối, đè sổ sách khối kế. **Không canary nào kêu**, nổ ở hàm khác lúc khác, ra `LoadProhibited` với `EXCVADDR` vô nghĩa | `CONFIG_HEAP_POISONING` từng profile | ⚠ **P4**, xem §13 — `soak` đã lấy `sdkconfig.dev`, còn nợ chính lượt chạy 24 giờ |
| 7.4 | "Đang trống" nói lên rất ít — phải xem **thấp nhất từng chạm**. *(bản đồ: trống 389.071 B mà đáy 2.207 B, chênh 176×)* | `heap_caps_get_minimum_free_size` | ⏳ E8-T9, cần ngoại vi |
| 7.5 | Không kiểm `NULL` sau khi xin | Đọc mọi `malloc`/`heap_caps_malloc` | ✅ |
| 7.6 | Dùng sau khi trả, hoặc trả rồi không gán `NULL` | Đọc mắt | ✅ `free_case` trong `parity.cpp` gán `NULL` ngay sau `free` |
| 7.7 | `new`/`delete` sau boot (CLAUDE.md §4.1) | `grep "\bnew \|\bdelete "` | ✅ **0 chỗ** |
| 7.8 | Trả về địa chỉ biến cục bộ | Đọc mắt | ✅ |

### 7b. Số học đáng nhớ của heap *(bản đồ)*

| | |
|---|---|
| `malloc(1)` thật sự tốn | **16 B** — khối tối thiểu 16, cộng 4 B header |
| Một cặp `malloc` + `free` | **8912 ns**, hơn **2×** một lần đổi task |
| Task stack 4096 B lấy của heap | **4204 B** — dôi đúng **108 B** (TCB + header khối) |
| Rò 4 KB mỗi vòng | **90 vòng** là cạn heap |

Con số 108 B cố định là thứ đáng nhớ: nó cho phép tính trước heap mất bao nhiêu khi thêm một
task, không cần đo.

**Khuôn mẫu của dự án**: xin lúc boot khi heap còn liền mạch, **không bao giờ trả**. Không thể
rò, không thể phân mảnh, không thể hỏng vì không ai trả rồi xin lại. Arena, bảng embedding và
pool khung đều theo khuôn này.

Heap chỉ cho thêm đúng một thứ — **đổi cỡ lúc chạy** — thứ dự án này không cần, mà mang về đủ
bốn rủi ro: rò · phân mảnh · hỏng · lỗi lúc chạy.

Đổi sang tĩnh còn một lợi ích ít ai để ý: **`.bss` chật thì link trượt**, tức thiếu RAM lộ ra
trên máy mình lúc build chứ không phải trên thiết bị lúc 3 giờ sáng. Đó là **cảnh báo sớm**,
không phải phiền toái.

---

## 8. PSRAM và vùng nhớ

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 8.1 | **`pvPortMalloc` luôn lấy DRAM nội, không bao giờ PSRAM** — stack, TCB, queue, semaphore đều đi đường này | Cộng RAM nội mà queue và task chiếm | ✅ `app_wiring` in ra lúc boot: 400 B kết quả, 768 B uplink |
| 8.2 | `malloc` có thể **rơi sang PSRAM** nếu cỡ vượt ngưỡng `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL` | Chỗ nào cần nội thì phải nói rõ | ✅ buffer DMA khai `MALLOC_CAP_DMA \| MALLOC_CAP_INTERNAL` |
| 8.3 | Buffer DMA nằm ở PSRAM | Đọc cấp phát của LCD và camera | ✅ bounce buffer ở RAM nội |
| 8.4 | **ISR không bao giờ đọc được PSRAM** | Kiểm biến mà ISR đụng tới | ✅ hai ISR chỉ đụng handle semaphore |
| 8.5 | PSRAM **ghi chậm 14,86×**, đọc tuần tự chỉ chậm 1,93× *(bản đồ)* | Đặt dữ liệu ghi-một-lần-đọc-tuần-tự ở PSRAM | ✅ arena và bảng embedding đúng khuôn này |
| 8.6 | Tưởng IDF dùng `heap_1`…`heap_5` của FreeRTOS gốc — **không**, nó có bộ cấp phát riêng theo `caps` | — | ✅ mọi chỗ trong repo đi qua `heap_caps_*` |
| 8.7 | Không biết **mọi đối tượng FreeRTOS đều có bản `…Static`** | `xTaskCreateStatic`, `xQueueCreateStatic`, `xSemaphoreCreateMutexStatic` | ⏳ chưa dùng, xem §1 |

---

## 9. Hàng đợi

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 9.1 | Biến dùng chung không khoá: giẫm chân nhau, đọc ra thứ **dở dang** | Tìm biến ghi bởi task này đọc bởi task kia | ✅ mọi đường liên task đều qua queue hoặc event group |
| 9.1b | Có chỗ chứa nhưng **không có nhịp** — lỗi này ít người để ý hơn lỗi trên. Ghi hai lần đọc một lần thì **mất một giá trị mà không ai biết**; muốn chờ giá trị mới thì phải quay vòng hỏi, đốt CPU | Đối chiếu §5.3 | ✅ cái thiếu không phải chỗ chứa mà là nhịp, và queue cho cả hai |
| 9.2 | **Không kiểm giá trị trả về của `xQueueReceive`** — trả `pdFALSE` thì biến đích **không đổi**, in lại giá trị cũ y như thật | `grep xQueueReceive` không kèm điều kiện | ✅ **0 chỗ**, mọi lời gọi đều kiểm |
| 9.3 | Gửi với timeout 0 rồi bỏ qua kết quả — **mất bản ghi âm thầm** | `grep "xQueueSend(.*, 0)"` | ✅ `ai_task` chờ 100 ms rồi log kind phải bỏ; `offer_to_ai` gửi 0 nhưng trả khung về pool ở cả hai nhánh |
| 9.4 | `portMAX_DELAY` khi nhận — treo im lặng nếu bên kia chết | Kiểm task nào chặn vô hạn | ✅ `ai_task` chờ 2 s, hết hạn thì nạp watchdog và log hàng đợi cạn |
| 9.5 | Gửi con trỏ trỏ vào stack người gửi | Đọc kiểu phần tử | ✅ `q_frame` chở con trỏ khung do pool sở hữu |
| 9.6 | Gửi `&x` thay vì `x` hoặc ngược lại — **trình dịch không báo lỗi** | Đọc mắt từng lời gọi | ✅ |
| 9.7 | **Gửi con trỏ đi là mất quyền sở hữu** — người gửi không được đụng nữa | Đọc mã sau mỗi lần gửi | ✅ `cam_task` không đụng `frame` sau `offer_to_ai`; `blit` xảy ra **trước** |
| 9.8 | Depth 1 ghi đè mà **khung bị đẩy ra không ai trả về pool** | Đọc `offer_to_ai` | ✅ hút khung cũ ra trả pool, gửi hỏng cũng trả |
| 9.9 | `xQueueOverwrite` trên queue dài khác 1 | `FRAME_DEPTH` | ✅ depth 1, và code dùng hút-rồi-gửi |
| 9.10 | Queue chở struct lớn | `sizeof × depth` | ✅ 4 × ~100 B |
| 9.11 | `xQueueCreate` trả `NULL` khi hết heap | Kiểm giá trị trả về | ✅ `app_wiring` kiểm cả năm |
| 9.12 | Gửi số trần, không biết nó sinh lúc nào | Thêm trường đóng dấu giờ | ⏳ `q_uplink` có `ts` trong bản ghi; `q_result` chưa cần |
| 9.13 | **`malloc` mỗi lần gửi** thay vì dùng vòng đệm cấp sẵn | `grep malloc` trong thân task | ✅ **0 chỗ** — khung đi qua pool của `esp32-camera` |
| 9.14 | **Số ô đệm phải lớn hơn độ dài queue ít nhất 1**, nếu không người gửi không còn ô nào để lấp trong lúc queue đang đầy | `CAM_FB_COUNT` so với `FRAME_DEPTH` | ✅ **4 ô** cho queue dài **1**. Số 4 chốt bằng phép đo chứ không bằng luật này: 3 ô cho preview **8,1 fps**, 4 ô cho **14,18 fps** (`latency.md` §6) |
| 9.15 | Dùng một queue cho **hai chiều** | Queue là một chiều; hai chiều thì dựng hai queue | ✅ mỗi queue một chiều, một người ghi |
| 9.16 | Dùng `xQueueSendToFront` cho việc thường — nó là để **chen đầu hàng**, chỉ dành cho lệnh khẩn | `grep xQueueSendToFront` | ✅ không dùng |
| 9.17 | Nhầm `xQueuePeek` với `xQueueReceive` — `Peek` đọc món đầu mà **không gỡ nó ra** | `grep xQueuePeek` | ✅ không dùng |
| 9.18 | `queue set` trả về **chính cái queue** chứ không phải dữ liệu — quên nhận tiếp là treo | `grep xQueueCreateSet` | ✅ không dùng |

### 9b. Ba mức chờ, mỗi mức một nghĩa vụ

| Timeout | Nghĩa | Nghĩa vụ kèm theo |
|---|---|---|
| `0` | Hỏi rồi đi ngay | **Phải xử lý nhánh trượt.** Bỏ qua là thành mất dữ liệu (P3), hoặc thành quay vòng đốt CPU nếu đặt trong vòng lặp chặt |
| `n` tick | Chờ có hạn | **Phải viết nhánh hết hạn.** Không viết thì hết hạn im lặng thành "không có dữ liệu" |
| `portMAX_DELAY` | Chờ mãi | **Treo im lặng nếu bên kia chết.** Chỉ dùng cho task mà việc duy nhất là chờ queue đó, và **không** đăng ký watchdog (P2) |

Chặn lành rẻ hơn hỏi vòng **1,96×** *(bản đồ)*: kernel gỡ task khỏi Ready và cắm vào danh sách
chờ của chính queue ấy, nên nó **biến mất khỏi tầm nhìn bộ lập lịch** và không tốn chu kỳ nào.

---

## 10. Khoá

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 10.1 | `portMAX_DELAY` khi lấy mutex — treo vô hạn, không cách nào biết | `grep "xSemaphoreTake.*portMAX_DELAY"` | ✅ **0 chỗ** |
| 10.2 | Khoá lồng nhau sai thứ tự → deadlock | Thứ tự §5.3: `m_facedb` → `m_littlefs` → `m_i2c` → `m_spi_lcd` | ✅ chỗ duy nhất lồng hai khoá là `FaceDb::persist()`, đi đúng chiều |
| 10.3 | **Giữ khoá suốt một lời gọi chặn dài** | Tìm I/O flash, I2C, nhận queue bên trong vùng khoá | ✅ `m_facedb_io` xếp hàng người ghi, phép ghi 552 KB chạy ngoài `m_facedb` (§5.3 của kế hoạch) |
| 10.4 | Dùng binary semaphore thay mutex — **mất kế thừa ưu tiên** | Kiểm từng semaphore | ✅ hai semaphore đều là báo hiệu ISR→task |
| 10.5 | Lấy lại mutex không đệ quy từ nhánh đang giữ | Đọc hàm public gọi lẫn nhau | ✅ |
| 10.6 | Lấy mutex trong ISR — sai tuyệt đối | `grep` trong ISR | ✅ |
| 10.7 | Khoá lá bị lấy thêm khoá khác bên trong | `m_door` khai là lá (§5.3) | ✅ |
| 10.8 | Một tài nguyên ra chỉ **một** task được giữ | Cổng nối tiếp, bus I2C | ✅ `m_i2c` cho bốn thiết bị một bus |

---

## 11. ISR

| # | Kiểu hỏng | Trạng thái |
|---|---|---|
| 11.1 | Gọi API không phải `*FromISR` | ✅ |
| 11.2 | Quên `portYIELD_FROM_ISR` | ✅ `drv_tof` gọi; `drv_lcd` là callback `esp_lcd` nên **trả cờ** cho driver nhường, đúng hợp đồng |
| 11.3 | Log, `malloc`, I2C trong ISR | ✅ |
| 11.4 | Thiếu `IRAM_ATTR` khi cache tắt lúc ghi flash / OTA | ✅ `drv_tof` có; ⏳ kiểm lại khi có `ota_task` |
| 11.5 | Chạm PSRAM từ ISR lúc cache tắt | ⏳ khi có OTA |

---

## 12. Timer và watchdog

| # | Kiểu hỏng | Trạng thái |
|---|---|---|
| 12.1 | Chặn trong callback timer — task timer dùng chung, nghẽn một cái là nghẽn tất | ✅ chỉ `servo_door`, chờ ≤ 50 ms |
| 12.2 | Task đăng ký watchdog rồi chặn vô hạn | ⚠ **P2** |
| 12.3 | Nạp nhầm ô watchdog — `esp_task_wdt_reset()` chỉ nạp ô của task gọi nó | ✅ `ai_task` nhường tick cho IDLE1 (§5.1) |
| 12.4 | Vùng tới hạn dài làm nổ interrupt watchdog | ✅ không có vùng tới hạn tự viết |

---

## 13. Phát hiện đang mở

### P4 — app chạy lâu nhất lại là app chạy mù nhất

Ba profile của §4.5.9 đều vào git và đều hợp lý: `dev` bật assert, `HEAP_POISONING_LIGHT` và
panic `GDBSTUB`; `prod` và `bench` tắt poisoning, assert im, panic `PRINT_REBOOT`. Không có
vấn đề ở đây.

Vấn đề ở chỗ khác: **`soak` và `bench_mem` không chọn profile nào.** Chúng chỉ nạp
`sdkconfig.defaults.esp32s3` — file chỉ khai flash, PSRAM và cache — nên phần còn lại rơi về
mặc định IDF, mà mặc định của `HEAP_CORRUPTION_DETECTION` là **`DISABLED`**.

Nghĩa là bài kiểm **24 giờ**, thứ có nhiều thời gian nhất để một lỗi ghi lố heap lộ ra, chạy
với phép bắt lỗi đó **tắt**. `bench_ai` và `parity` cũng tắt tường minh, nhưng chúng chạy vài
phút nên không sao.

Hai app đã có profile: `soak` lấy `sdkconfig.dev` (đọc lại `sdkconfig` sinh ra thấy
`CONFIG_HEAP_POISONING_LIGHT=y`), còn `bench_mem` lấy `sdkconfig.bench` chứ không phải `dev` —
nó đi báo số chứ không đi săn lỗi, mà poisoning thêm canary vào **mọi** khối nên sẽ thổi phồng
đúng con số RAM đỉnh nó sinh ra; `bench` vẫn giữ `FREERTOS_USE_TRACE_FACILITY` mà
`uxTaskGetSystemState` cần.

Còn nợ: **chính lượt chạy 24 giờ**, kết quả vào `docs/measurements/`. Xem E10-T8.

### P5 — `prod` tắt poisoning, nên hỏng heap ngoài hiện trường là vô hình

Đây là đánh đổi tiêu chuẩn chứ không phải lỗi: poisoning tốn thời gian mỗi lần xin và trả.
Ghi lại để đừng quên rằng **lưới bắt lỗi heap của bản giao hàng là con số không**: mọi lỗi
kiểu P1 hay P3 phải bị chặn từ `dev`, vì trên hiện trường sẽ không có gì kêu.

---

## 14. Còn phải kiểm khi hệ đủ

Không kiểm được bây giờ vì task liên quan chưa tồn tại. Chạy lại trước khi chốt E10 và E13.

| Khi có | Phải kiểm |
|---|---|
| `ui_task` (E10-T1) | `m_spi_lcd` tranh chấp giữa vẽ màn hình và OTA; **LVGL không thread-safe**, mọi lời gọi `lv_*` phải từ một task; heap LVGL ở PSRAM có phân mảnh không |
| `touch_task` (E10-T1) | `q_touch` depth 8 có nuốt kịp thao tác vuốt nhanh; ISR GT911 trên GPIO14 |
| `audio_task` (E7-T8) | Đọc WAV từ LittleFS giữ `m_littlefs` bao lâu — **cùng loại lỗi với P1** |
| `mqtt_task`, `sync_task` (E10-T6) | `q_uplink` đầy thì ghi thẳng LittleFS chứ không rơi; con trỏ chỉ nhích sau ack |
| `ota_task` (E13-T1) | Ghi flash **tắt cache**: mọi ISR chạy lúc đó phải `IRAM_ATTR` và không chạm PSRAM |
| Đủ 10 task | Watermark toàn bộ (E10-T8), đáy heap (E8-T9), dòng đỉnh (E10-T9) |
| Trước khi giao | Soak 24 giờ và rút điện 20 lần (E10-T3, E10-T8), **một lượt soak dựng bằng `sdkconfig.dev`** để có poisoning |

---

## 15. Lệnh soát nhanh

```bash
# mutex chờ vô hạn — phải ra rỗng
grep -rn "xSemaphoreTake.*portMAX_DELAY" firmware/components firmware/main

# nhận queue không kiểm kết quả — phải ra rỗng
grep -rn "xQueueReceive" firmware/components/*/src firmware/main | grep -vE "if |while |pdTRUE|pdPASS"

# gửi queue bỏ qua kết quả — mỗi dòng phải giải thích được
grep -rn "xQueueSend(.*, 0)" firmware/components firmware/main

# ISR: mỗi chỗ Give phải kèm yield hoặc trả cờ
grep -rn "FromISR" firmware/components/*/src firmware/main

# cấp phát động sau boot
grep -rn "\bnew \|\bdelete " firmware/components/*/src firmware/main

# tick rate: hạ số này là mọi chờ ngắn im lặng thành 0 tick
grep -n "CONFIG_FREERTOS_HZ" firmware/sdkconfig

# tầng phụ thuộc
python3 tools/check_layers.py
```
