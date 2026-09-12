# Sổ kiểm lỗi đồng thời FreeRTOS

Danh mục những kiểu hỏng mà một hệ nhiều task hay dính, kèm **cách kiểm bằng máy** và **trạng
thái hiện tại của repo này**. Soát lại mỗi khi thêm một task, một khoá hay một hàng đợi — đó là
lúc các luật dưới đây bị phá, không phải lúc viết code mới.

Bảng task, hàng đợi và khoá là KẾ HOẠCH §5. File này không chép lại chúng, nó chỉ hỏi
"chúng có bị mấy lỗi kinh điển không".

Ký hiệu: ✅ đã kiểm và sạch · ⚠ có phát hiện, xem §9 · ⏳ chưa kiểm được vì phần liên quan
chưa tồn tại.

---

## 1. Ngăn xếp

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 1.1 | Tràn stack, triệu chứng là panic ở chỗ không liên quan | `uxTaskGetSystemState` lấy watermark mọi task | ✅ `test_apps/soak` và `bench_mem` in mỗi mẫu |
| 1.2 | `printf`/`vsnprintf` trên stack nhỏ — riêng nó ăn khoảng 1 KB | Đọc stack khai trong `app_tasks.c` so với chỗ có `printf` | ✅ task nhỏ nhất là `tof` 3 KB, không `printf` trong vòng lặp |
| 1.3 | Mảng lớn khai trong thân hàm | `grep -n "\[[0-9]\{3,\}\]"` trong thân hàm | ✅ buffer lớn đều `static` hoặc `heap_caps_malloc` |
| 1.4 | Đệ quy | Đọc mắt | ✅ không có |

Watermark đo được 11/09: `cam` 2644, `attend` 2968, `tof` 1568, `ai` 1532 B trống. **`ai` là
mỏng nhất** và số đó đo khi mới có detect chạy — phải đo lại khi spoof với recog chạy sâu
(E10-T8).

---

## 2. Ưu tiên và lịch chạy

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 2.1 | Đảo ngược ưu tiên | Mutex của FreeRTOS **có** kế thừa ưu tiên; binary semaphore thì **không**. Kiểm không có chỗ nào dùng binary semaphore thay mutex | ✅ hai semaphore (`s_ready`, `s_bounce_free`) đều là báo hiệu ISR→task, không phải khoá |
| 2.2 | Task ưu tiên cao quay vòng không chặn, bỏ đói task dưới | Tìm vòng `for(;;)` không có lời gọi chặn nào | ✅ `cam_task` khi hết khung trả `vTaskDelay(1)` thay vì quay vòng |
| 2.3 | Bỏ đói IDLE làm watchdog nổ | IDLE của mỗi core phải được chạy | ✅ `ai_task` nhường một tick mỗi khung (§5.1) |
| 2.4 | Ghim core sai | Đối chiếu `AI_TASK_CORE` với §5.1 | ✅ core 1 chỉ có `ai_task` |
| 2.5 | Một `Invoke()` giữ core 100–400 ms | Đo latency từng model | ✅ `latency.md`, đó là lý do core 1 được dọn trống |

---

## 3. Khoá

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 3.1 | `portMAX_DELAY` khi lấy mutex — treo vô hạn, không có cách nào biết | `grep "xSemaphoreTake.*portMAX_DELAY"` | ✅ **0 chỗ** trong toàn firmware |
| 3.2 | Khoá lồng nhau sai thứ tự → deadlock | Thứ tự chốt ở §5.3: `m_facedb` → `m_littlefs` → `m_i2c` → `m_spi_lcd` | ✅ chỗ duy nhất lồng hai khoá là `FaceDb::persist()`, đi đúng chiều |
| 3.3 | **Giữ khoá suốt một lời gọi chặn dài** | Tìm I/O flash, I2C, `xQueueReceive` bên trong vùng khoá | ⚠ **P1** — xem §9 |
| 3.4 | Lấy lại mutex không đệ quy từ chính nhánh đang giữ | Đọc mắt các hàm public gọi lẫn nhau | ✅ hàm public không gọi hàm public khác cùng lớp |
| 3.5 | Lấy mutex trong ISR — sai tuyệt đối | `grep "xSemaphoreTake" ISR` | ✅ không có |
| 3.6 | Khoá lá bị lấy thêm khoá khác bên trong | `m_door` khai là khoá lá (§5.3) | ✅ `servo_door` không lấy khoá nào khác |
| 3.7 | Chờ khoá trong callback `esp_timer` làm nghẽn mọi timer khác | Tìm `LockGuard` trong callback | ✅ `servo_door` chờ tối đa 50 ms, có chặn trên |

---

## 4. Hàng đợi

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 4.1 | Gửi con trỏ trỏ vào stack của người gửi | Đọc kiểu phần tử từng queue | ✅ `q_frame` chở con trỏ khung do pool sở hữu, ba queue kia chở bản sao |
| 4.2 | **Mất quyền sở hữu khi depth 1 ghi đè** — khung bị đẩy ra không ai trả về pool | Đọc `offer_to_ai` | ✅ hút khung cũ ra trả pool, gửi hỏng cũng trả |
| 4.3 | Gửi với timeout 0 rồi bỏ qua giá trị trả về — **mất bản ghi âm thầm** | Tìm `xQueueSend(..., 0)` không kiểm kết quả | ⚠ **P3** — xem §9 |
| 4.4 | `xQueueOverwrite` trên queue depth khác 1 | `FRAME_DEPTH` | ✅ depth 1, và code dùng hút-rồi-gửi chứ không `xQueueOverwrite` |
| 4.5 | Queue chở struct lớn, tốn RAM và thời gian chép | `sizeof(svc_vision_result_t)` × depth | ✅ 4 × ~100 B, `app_wiring` in ra lúc boot |

---

## 5. ISR

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 5.1 | Gọi API không phải `*FromISR` | Đọc từng ISR | ✅ hai ISR |
| 5.2 | Quên `portYIELD_FROM_ISR` | Đọc từng ISR | ✅ `drv_tof` gọi; `drv_lcd` là callback `esp_lcd` nên **trả cờ** cho driver nhường, đúng hợp đồng của nó |
| 5.3 | Log, `malloc`, I2C trong ISR | Đọc mắt | ✅ không có |
| 5.4 | Thiếu `IRAM_ATTR` khi cache tắt lúc ghi flash / OTA | Kiểm ISR nào chạy trong lúc ghi flash | ✅ `drv_tof` có `IRAM_ATTR`; ⏳ kiểm lại khi có `ota_task` |
| 5.5 | Chạm PSRAM từ ISR trong lúc cache tắt | Kiểm biến ISR đụng tới | ⏳ khi có OTA |

---

## 6. Timer

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 6.1 | Chặn trong callback timer — task timer dùng chung, nghẽn một cái là nghẽn tất | Đọc mọi callback | ✅ chỉ `servo_door`, chờ ≤ 50 ms |
| 6.2 | Trôi nhịp vì `vTaskDelay` thay vì `vTaskDelayUntil` | Tìm vòng định kỳ | ⚠ `tof_task` dùng `vTaskDelay(TOF_POLL_MS)` nên chu kỳ = 100 ms **cộng** thời gian xử lý. Chấp nhận được vì nó chỉ dò hiện diện, nhưng ghi lại để không nhân ra chỗ cần nhịp chuẩn |
| 6.3 | Độ phân giải tick 10 ms không đủ cho yêu cầu thời gian | Đối chiếu `CONFIG_FREERTOS_HZ` với nhịp cần | ✅ nhịp nhỏ nhất là preview 70 ms |

---

## 7. Watchdog

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 7.1 | Task đăng ký watchdog rồi chặn vô hạn | Tìm task có `esp_task_wdt_add` mà chặn không giới hạn | ⚠ **P2** — xem §9 |
| 7.2 | Nạp nhầm ô watchdog — `esp_task_wdt_reset()` chỉ nạp ô của chính task gọi | Đọc §5.1 | ✅ đã ghi trong kế hoạch, `ai_task` nhường tick cho IDLE1 |
| 7.3 | Vùng tới hạn dài làm nổ interrupt watchdog | Tìm `portENTER_CRITICAL` | ✅ không có vùng tới hạn tự viết |

---

## 8. Bộ nhớ

| # | Kiểu hỏng | Cách kiểm | Trạng thái |
|---|---|---|---|
| 8.1 | `new`/`delete` sau khi boot xong (CLAUDE.md §4.1) | `grep "\bnew \|\bdelete "` | ✅ 0 chỗ |
| 8.2 | Phân mảnh heap: tổng trống còn nhiều mà **dải liền mạch** thì hết | `heap_caps_get_largest_free_block` chứ không chỉ `get_free_size` | ✅ `bench_mem` in cả hai; `arena.md` §1c đã dính đúng lỗi này một lần |
| 8.3 | Buffer DMA nằm ở PSRAM | Kiểm cấp phát của LCD và camera | ✅ bounce buffer khai `MALLOC_CAP_DMA \| MALLOC_CAP_INTERNAL` |
| 8.4 | Đáy heap thật khác mức trống tức thời | `heap_caps_get_minimum_free_size` | ⏳ E8-T9, cần ngoại vi |

---

## 9. Phát hiện đang mở

### P1 — `m_facedb` bị giữ suốt một phép ghi flash 2 giây

`FaceDb::persist()` lấy `m_facedb` rồi gọi `store_.save()`, tức ghi 552 KB xuống LittleFS.
E10-T3 đo phép ghi hai pha ấy mất **1,8–2,3 s**. Nhưng `kLockMs = 200` ms.

Hệ quả: ai gọi `svc_facedb_lookup` trong cửa sổ đó nhận `ESP_ERR_TIMEOUT`, và
`pipeline.cpp:143` biến mọi lỗi tra cứu thành **`UNKNOWN`** — tức **người thật bị từ chối** chỉ
vì đúng lúc ấy có ai đó đăng ký xong và bảng đang được ghi xuống.

Thứ tự khoá thì **đúng** (`m_facedb` → `m_littlefs`, §5.3), nên đây không phải deadlock. Nó là
lỗi về **độ dài vùng khoá**.

Ba đường sửa, chưa chọn: chép ảnh bảng dưới khoá rồi thả khoá mới ghi (tốn thêm 552 KB PSRAM
trong chốc lát); hoặc để `svc_attendance` chặn không cho enroll và xác thực chạy chồng; hoặc
phân biệt lỗi tra cứu với "không tìm thấy" để pipeline báo bận thay vì `UNKNOWN`. Đường thứ ba
rẻ nhất và trung thực nhất, nhưng cần một mã kết quả mới.

Chưa nổ trên thực tế vì luồng enroll (E10-T7) chưa có. **Phải chốt trước khi E10-T7 lên.**

### P2 — `ai_task` vừa đăng ký watchdog vừa chặn vô hạn

`ai_task` gọi `esp_task_wdt_add(NULL)` rồi vòng lặp chặn ở
`xQueueReceive(wiring->frames, &frame, portMAX_DELAY)`. Camera ngừng đẩy khung thì nó **không
bao giờ chạy tới `esp_task_wdt_reset()`** và watchdog nổ.

Hai cách đọc, và phải chọn chứ không mặc kệ:

- **Cố ý**: camera chết là hệ hỏng, để watchdog reset là đúng. Nhưng khi đó **báo cáo chỉ ra
  `ai_task`** trong khi lỗi nằm ở `cam_task` hoặc ở sensor — đi soi nhầm chỗ.
- **Sót**: `ai_task` nên chờ có giới hạn, hết giờ thì nạp watchdog và log "không có khung", để
  báo cáo chỉ đúng thủ phạm.

`portMAX_DELAY` ở đây **không vi phạm** CLAUDE.md §4.1 — luật đó cấm cho mutex, còn chặn trên
hàng đợi đầu vào là khuôn mẫu bình thường. Vấn đề nằm ở chỗ nó đi cùng watchdog.

### P3 — kết quả nhận dạng rơi âm thầm khi `attend_task` chậm

`xQueueSend(wiring->results, &result, 0)` gửi với timeout 0 và **không kiểm giá trị trả về**.
`RESULT_DEPTH` là 4. `attend_task` chậm hơn bốn kết quả thì kết quả thứ năm biến mất không
dấu vết — mà một `MATCH` rơi là **một lần chấm công mất**.

So sánh: `offer_to_ai` ở ngay trên đó xử lý đúng — khung bị đẩy ra được trả về pool. Chỗ này
chỉ thiếu một nhánh đếm và log.

---

## 10. Còn phải kiểm khi hệ đủ

Những mục dưới đây **không kiểm được bây giờ** vì task liên quan chưa tồn tại. Đây là danh sách
phải chạy lại trước khi chốt E10 và E13.

| Khi có | Phải kiểm |
|---|---|
| `ui_task` (E10-T1) | `m_spi_lcd` tranh chấp giữa vẽ màn hình và OTA; LVGL không thread-safe, mọi lời gọi `lv_*` phải từ một task; heap LVGL ở PSRAM có phân mảnh không |
| `touch_task` (E10-T1) | `q_touch` depth 8 có nuốt kịp thao tác vuốt nhanh; ISR GT911 trên GPIO14 |
| `audio_task` (E7-T8, E10) | Đọc WAV từ LittleFS giữ `m_littlefs` bao lâu — cùng loại lỗi với P1 |
| `mqtt_task`, `sync_task` (E10-T6) | `q_uplink` đầy thì ghi thẳng LittleFS chứ không rơi; con trỏ chỉ nhích sau ack |
| `ota_task` (E13-T1) | Ghi flash làm **tắt cache**: mọi ISR chạy trong lúc đó phải `IRAM_ATTR` và không chạm PSRAM; `m_spi_lcd` cho màn hình tiến trình |
| Đủ 10 task | Đo lại watermark toàn bộ (E10-T8), đáy heap (E8-T9), và dòng điện đỉnh (E10-T9) |
| Trước khi giao | Chạy soak 24 giờ và phép rút điện 20 lần (E10-T3, E10-T8) |

---

## 11. Lệnh soát nhanh

```bash
# mutex chờ vô hạn — phải ra rỗng
grep -rn "xSemaphoreTake.*portMAX_DELAY" firmware/components firmware/main

# gửi queue bỏ qua kết quả — mỗi dòng phải giải thích được
grep -rn "xQueueSend(.*, 0)" firmware/components firmware/main

# ISR: mỗi chỗ Give phải đi kèm yield hoặc trả cờ
grep -rn "FromISR" firmware/components firmware/main

# cấp phát động sau boot
grep -rn "\bnew \|\bdelete " firmware/components/*/src firmware/main

# tầng phụ thuộc
python3 tools/check_layers.py
```
