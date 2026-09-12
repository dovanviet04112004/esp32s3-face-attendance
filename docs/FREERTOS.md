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

Chia task **không** làm nhanh lên — vẫn từng ấy việc trên một CPU. Cái đắt không phải chi phí
đổi task (4,19 µs, khoảng 0,17% khi 100 lần/giây *(bản đồ)*) mà là **stack** và **lỗi đồng
thời**.

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

---

## 7. Heap

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 7.1 | Rò: xin mà không trả. **Vi điều khiển không có ai thu hồi** — chỉ hết khi khởi động lại | Đo heap trước và sau **một chu kỳ đầy đủ** | ✅ `soak` so mẫu đầu với mẫu sau; heap phẳng trong 56 B suốt một phút |
| 7.2 | **Phân mảnh**: tổng trống còn nhiều mà **dải liền mạch** thì hết. *(bản đồ: trống 31.083 B, xin 20 KB vẫn trượt, mảnh lớn nhất 7.936 B)* | `heap_caps_get_largest_free_block`, **không** chỉ `get_free_size` | ✅ `bench_mem` in cả hai. Dự án đã dính đúng lỗi này một lần: `arena.md` §1c — trống 192 KB mà mảnh to nhất 143 KB nên arena lùi xuống PSRAM |
| 7.3 | Hỏng heap: ghi lố ra ngoài khối, đè sổ sách khối kế. **Không canary nào kêu**, nổ ở hàm khác lúc khác, ra `LoadProhibited` với `EXCVADDR` vô nghĩa | `CONFIG_HEAP_POISONING` từng profile | ⚠ **P4**, xem §13 |
| 7.4 | "Đang trống" nói lên rất ít — phải xem **thấp nhất từng chạm**. *(bản đồ: trống 389.071 B mà đáy 2.207 B, chênh 176×)* | `heap_caps_get_minimum_free_size` | ⏳ E8-T9, cần ngoại vi |
| 7.5 | Không kiểm `NULL` sau khi xin | Đọc mọi `malloc`/`heap_caps_malloc` | ✅ |
| 7.6 | Dùng sau khi trả, hoặc trả rồi không gán `NULL` | Đọc mắt | ✅ `free_case` trong `parity.cpp` gán `NULL` ngay sau `free` |
| 7.7 | `new`/`delete` sau boot (CLAUDE.md §4.1) | `grep "\bnew \|\bdelete "` | ✅ **0 chỗ** |
| 7.8 | Trả về địa chỉ biến cục bộ | Đọc mắt | ✅ |

**Khuôn mẫu của dự án**: xin lúc boot khi heap còn liền mạch, **không bao giờ trả**. Không thể
rò, không thể phân mảnh. Arena, bảng embedding và pool khung đều theo khuôn này.

---

## 8. PSRAM và vùng nhớ

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 8.1 | **`pvPortMalloc` luôn lấy DRAM nội, không bao giờ PSRAM** — stack, TCB, queue, semaphore đều đi đường này | Cộng RAM nội mà queue và task chiếm | ✅ `app_wiring` in ra lúc boot: 400 B kết quả, 768 B uplink |
| 8.2 | `malloc` có thể **rơi sang PSRAM** nếu cỡ vượt ngưỡng `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL` | Chỗ nào cần nội thì phải nói rõ | ✅ buffer DMA khai `MALLOC_CAP_DMA \| MALLOC_CAP_INTERNAL` |
| 8.3 | Buffer DMA nằm ở PSRAM | Đọc cấp phát của LCD và camera | ✅ bounce buffer ở RAM nội |
| 8.4 | **ISR không bao giờ đọc được PSRAM** | Kiểm biến mà ISR đụng tới | ✅ hai ISR chỉ đụng handle semaphore |
| 8.5 | PSRAM **ghi chậm 14,86×**, đọc tuần tự chỉ chậm 1,93× *(bản đồ)* | Đặt dữ liệu ghi-một-lần-đọc-tuần-tự ở PSRAM | ✅ arena và bảng embedding đúng khuôn này |

---

## 9. Hàng đợi

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 9.1 | Không có hàng đợi thì **không có nhịp**: ghi hai lần đọc một lần, mất một giá trị không ai biết | Đối chiếu §5.3 | ✅ mọi đường liên task đều qua queue |
| 9.2 | **Không kiểm giá trị trả về của `xQueueReceive`** — trả `pdFALSE` thì biến đích **không đổi**, in lại giá trị cũ y như thật | `grep xQueueReceive` không kèm điều kiện | ✅ **0 chỗ**, mọi lời gọi đều kiểm |
| 9.3 | Gửi với timeout 0 rồi bỏ qua kết quả — **mất bản ghi âm thầm** | `grep "xQueueSend(.*, 0)"` | ⚠ **P3**, xem §13 |
| 9.4 | `portMAX_DELAY` khi nhận — treo im lặng nếu bên kia chết | Kiểm task nào chặn vô hạn | ⚠ **P2**, xem §13 |
| 9.5 | Gửi con trỏ trỏ vào stack người gửi | Đọc kiểu phần tử | ✅ `q_frame` chở con trỏ khung do pool sở hữu |
| 9.6 | Gửi `&x` thay vì `x` hoặc ngược lại — **trình dịch không báo lỗi** | Đọc mắt từng lời gọi | ✅ |
| 9.7 | **Gửi con trỏ đi là mất quyền sở hữu** — người gửi không được đụng nữa | Đọc mã sau mỗi lần gửi | ✅ `cam_task` không đụng `frame` sau `offer_to_ai`; `blit` xảy ra **trước** |
| 9.8 | Depth 1 ghi đè mà **khung bị đẩy ra không ai trả về pool** | Đọc `offer_to_ai` | ✅ hút khung cũ ra trả pool, gửi hỏng cũng trả |
| 9.9 | `xQueueOverwrite` trên queue dài khác 1 | `FRAME_DEPTH` | ✅ depth 1, và code dùng hút-rồi-gửi |
| 9.10 | Queue chở struct lớn | `sizeof × depth` | ✅ 4 × ~100 B |
| 9.11 | `xQueueCreate` trả `NULL` khi hết heap | Kiểm giá trị trả về | ✅ `app_wiring` kiểm cả năm |
| 9.12 | Gửi số trần, không biết nó sinh lúc nào | Thêm trường đóng dấu giờ | ⏳ `q_uplink` có `ts` trong bản ghi; `q_result` chưa cần |

---

## 10. Khoá

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 10.1 | `portMAX_DELAY` khi lấy mutex — treo vô hạn, không cách nào biết | `grep "xSemaphoreTake.*portMAX_DELAY"` | ✅ **0 chỗ** |
| 10.2 | Khoá lồng nhau sai thứ tự → deadlock | Thứ tự §5.3: `m_facedb` → `m_littlefs` → `m_i2c` → `m_spi_lcd` | ✅ chỗ duy nhất lồng hai khoá là `FaceDb::persist()`, đi đúng chiều |
| 10.3 | **Giữ khoá suốt một lời gọi chặn dài** | Tìm I/O flash, I2C, nhận queue bên trong vùng khoá | ⚠ **P1**, xem §13 |
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

### P1 — `m_facedb` bị giữ suốt một phép ghi flash 2 giây

`FaceDb::persist()` lấy `m_facedb` rồi gọi `store_.save()`, tức ghi 552 KB xuống LittleFS.
E10-T3 đo phép ghi hai pha ấy mất **1,8–2,3 s**. Nhưng `kLockMs = 200` ms.

Hệ quả: ai gọi `svc_facedb_lookup` trong cửa sổ đó nhận `ESP_ERR_TIMEOUT`, và
`pipeline.cpp:143` biến mọi lỗi tra cứu thành **`UNKNOWN`** — **người thật bị từ chối** chỉ vì
đúng lúc ấy có ai đó đăng ký xong và bảng đang được ghi xuống.

Thứ tự khoá **đúng** (§5.3), nên đây không phải deadlock mà là lỗi **độ dài vùng khoá**.

Ba đường, chưa chọn: chép ảnh bảng dưới khoá rồi thả khoá mới ghi (tốn thêm 552 KB PSRAM trong
chốc lát); để `svc_attendance` chặn enroll và xác thực chạy chồng; hoặc tách lỗi tra cứu khỏi
"không tìm thấy" để pipeline báo bận thay vì `UNKNOWN`. **Chốt trước E10-T7.** Row E10-T11.

### P2 — `ai_task` vừa đăng ký watchdog vừa chặn vô hạn

`ai_task` gọi `esp_task_wdt_add(NULL)` rồi chặn ở `xQueueReceive(frames, portMAX_DELAY)`.
Camera ngừng đẩy khung thì nó **không bao giờ tới `esp_task_wdt_reset()`** và watchdog nổ.

Hai cách đọc: **cố ý** — camera chết là hệ hỏng, để reset là đúng, nhưng báo cáo **chỉ vào
`ai_task`** trong khi lỗi ở `cam_task` hoặc sensor; hoặc **sót** — nên chờ có hạn, hết giờ thì
nạp watchdog và log "không có khung".

`portMAX_DELAY` ở đây **không vi phạm** CLAUDE.md §4.1 (luật đó cấm cho mutex). Vấn đề là nó đi
cùng watchdog. Row E10-T12.

### P3 — kết quả nhận dạng rơi âm thầm khi `attend_task` chậm

`xQueueSend(wiring->results, &result, 0)` gửi timeout 0 và **không kiểm giá trị trả về**.
`RESULT_DEPTH` là 4. Chậm quá bốn kết quả thì kết quả thứ năm biến mất không dấu vết — một
`MATCH` rơi là **một lần chấm công mất**. Ngay trên nó `offer_to_ai` xử lý đúng. Row E10-T12.

### P4 — app chạy lâu nhất lại là app chạy mù nhất

Ba profile của §4.5.9 đều vào git và đều hợp lý: `dev` bật assert, `HEAP_POISONING_LIGHT` và
panic `GDBSTUB`; `prod` và `bench` tắt poisoning, assert im, panic `PRINT_REBOOT`. Không có
vấn đề ở đây.

Vấn đề ở chỗ khác: **`soak` và `bench_mem` không chọn profile nào.** Chúng chỉ nạp
`sdkconfig.defaults.esp32s3` — file chỉ khai flash, PSRAM và cache — nên phần còn lại rơi về
mặc định IDF, mà mặc định của `HEAP_CORRUPTION_DETECTION` là **`DISABLED`**.

Nghĩa là bài kiểm **24 giờ**, thứ có nhiều thời gian nhất để một lỗi ghi lố heap lộ ra, đang
chạy với phép bắt lỗi đó **tắt**. `bench_ai` và `parity` còn tắt tường minh, nhưng chúng chạy
vài phút nên không sao.

Việc phải làm: cho `soak` chạy ít nhất một lượt 24 giờ với `sdkconfig.dev`. Ghi kết quả vào
`docs/measurements/`. Xem E10-T8.

### P5 — `prod` tắt poisoning, nên hỏng heap ngoài hiện trường là vô hình

Đây là đánh đổi tiêu chuẩn chứ không phải lỗi: poisoning tốn thời gian mỗi lần xin và trả.
Ghi lại để đừng quên rằng **lưới bắt lỗi heap của bản giao hàng là con số không**, và vì vậy
P1 với P3 phải được đóng trước khi giao — trên hiện trường sẽ không có gì kêu.

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
