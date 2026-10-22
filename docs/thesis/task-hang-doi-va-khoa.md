# Task, hàng đợi và khoá của firmware

Ghi cho chương phần mềm nhúng của báo cáo. Liệt kê mọi task FreeRTOS chạy trên kiosk, mọi hàng
đợi, mọi khoá và tín hiệu, kèm phần RAM mỗi thứ chiếm. Đây là ảnh chụp theo code ngày 22/10, ở
profile `bench` — bản đang nạp cho kiosk.

Ba tài liệu gốc mà file này dựa vào, mỗi cái một vai:

| Tài liệu | Giữ cái gì |
|---|---|
| KẾ HOẠCH §5 | Thiết kế: bảng task, bảng hàng đợi và khoá, và lý do của từng lựa chọn |
| `docs/measurements/ram.md` | Số đo RAM trên board |
| `docs/FREERTOS.md` | Danh mục lỗi đồng thời, và repo đã tránh hay đã dính từng lỗi |

Số trong cột "còn trống" là số **đo trên board ngày 23/09** (`bench_mem`, profile `bench`, ESP-DL,
đệm bounce 20 dòng, Wi-Fi vào mạng thật nhưng chưa có phiên TLS). Code đã đổi sau ngày ấy, nên đó
là mốc độ lớn chứ không phải số của bản hôm nay 🔬. Cỡ của từng item trong hàng đợi tính từ định
nghĩa struct; số nào chưa đo đánh dấu 🔬.

1. Toàn cảnh: một khung hình đi qua những task nào
2. Task
3. Hàng đợi
4. Khoá, semaphore, event group, timer
5. Những đường không đi qua hàng đợi
6. RAM: ai giữ bao nhiêu
7. Hai điểm còn mở

---

## 1. Toàn cảnh: một khung hình đi qua những task nào

```
ngắt DMA camera ─▶ cam_task (esp32-camera, prio 23) ─▶ pool 4 khung ở PSRAM
                                                         │ con trỏ khung
cam (prio 7, lõi 0) ── vẽ preview + overlay lên LCD ─────┤
                                                         ▼
                                              q_frame_ai (1 ô, con trỏ)
                                                         │
ai (prio 5, lõi 1) ── detect → spoof → recog → tra bảng mặt
                                                         │
                                              q_result (4 ô × 156 B)
                                                         ▼
attend (prio 4) ── máy trạng thái, chống trùng, ghi log, mở cửa
      ├─▶ q_audio ──▶ audio ──▶ loa
      ├─▶ q_uplink ─▶ sync ──▶ mqtt_task ──▶ broker
      └─▶ svc_door ─▶ servo, esp_timer tự đóng

tof (prio 6) ─▶ q_presence ─▶ attend        touch ─▶ s_touch ─▶ ui ─▶ overlay ─▶ cam
broker ─▶ mqtt_task ─▶ q_cmd, q_roster ─▶ sync          q_ota ─▶ ota
```

Trong các task của dự án, lõi 1 chỉ có `ai`: một lượt chạy model giữ lõi cả trăm mili giây, task
nào chung lõi với nó sẽ đứng chờ (KẾ HOẠCH §5.1). Lõi 1 còn có `IDLE1` và `ipc1` của IDF; mọi task
khác nằm ở lõi 0.

## 2. Task

### 2.1 Task của dự án

Tạo trong `main/app_tasks.c` bằng `xTaskCreatePinnedToCore`, nên stack lấy ở RAM nội.

| Task | Lõi | Prio | Stack | Còn trống (đo 23/09) | Làm gì |
|---|---|---|---|---|---|
| `cam` | 0 | 7 | 4.096 | 2.592 | Lấy khung từ camera, vẽ preview cùng overlay lên LCD, đưa **con trỏ** khung sang `q_frame_ai` |
| `tof` | 0 | 6 | 3.072 | 1.560 | Đọc VL53L1X khi ngắt GPIO3 báo, đổi khoảng cách thành cạnh có người / hết người |
| `audio` | 0 | 6 | 4.096 | 2.364 | Nạp `ok.wav` vào PSRAM một lần lúc lên, phát khi `q_audio` có lệnh |
| `touch` | 0 | 5 | 3.072 | 1.484 | Ngắt GT911 báo thì đọc điểm chạm, ghi vào `s_touch` |
| **`ai`** | **1** | 5 | 8.192 | **1.060** | Mỗi khung một `svc_vision_step`; task duy nhất của dự án đăng ký watchdog |
| `ui` | 0 | 4 | 4.096 | 2.052 | Nhịp 20 ms: chạy các màn, dựng overlay cho `cam`; cuối phiên đăng ký thì ghi bảng mặt |
| `attend` | 0 | 4 | 4.096 | 2.304 | Máy trạng thái chấm công, chống trùng, ghi log, mở cửa, đẩy `q_audio` và `q_uplink` |
| `net` | 0 | 3 | 4.096 | — | Chờ Wi-Fi, nối broker hoặc xin vé, mở SNTP rồi **tự xoá**, trả lại stack |
| `ota` | 0 | 3 | 8.192 | 5.540 | Phiên HTTPS duy nhất của máy: OTA firmware và model, xin vé, đổi vé |
| `sync` | 0 | 2 | 5.120 | 1.752 | Đẩy log chấm công lên broker và chờ ack, gửi heartbeat, áp lệnh từ `q_cmd` và `q_roster`, phát sự kiện từ `q_event` |

`ai` là task mỏng nhất của dự án. Lượt đo 23/09 không chắc có người đứng trước camera, nên nhiều
khả năng nó mới chạy detect; spoof và recog có thể đi sâu hơn 🔬.

### 2.2 Task của IDF và thư viện

| Task | Ai tạo | Lõi | Prio | Stack | Còn trống (đo 23/09) | Làm gì |
|---|---|---|---|---|---|---|
| `cam_task` | esp32-camera | 0 | 23 | 4.096 | 3.352 | Nhận sự kiện DMA từ ngắt camera, ghép dữ liệu thành khung trong pool |
| `mqtt_task` | esp-mqtt | 0 | 3 | 6.144, **ở PSRAM** | 4.372 | pub/sub và TLS. Callback chỉ giải mã payload rồi bỏ vào `q_cmd`, `q_roster`, `q_ota`. Lượt đo 23/09 chưa có TLS, và lúc ấy task còn chạy prio 5 không ghim lõi |
| `wifi` | IDF | 0 | 23 | 6.656 | 4.364 | Driver Wi-Fi |
| `tcpip` | lwIP | tự do | 18 | 3.072 | 1.720 | Ngăn xếp TCP/IP; SNTP chạy trong task này |
| `esp_timer` | IDF | 0 | 22 | 3.584 | 3.124 | Chạy callback hẹn giờ: tự đóng cửa, thử nối lại Wi-Fi |
| `sys_evt` | IDF | — | 20 | 2.304 | 1.424 | Vòng sự kiện mặc định: sự kiện Wi-Fi và IP |
| `Tmr Svc` | FreeRTOS | — | 1 | 2.048 | 1.452 | Timer của FreeRTOS; dự án không dùng |
| `ipc0`, `ipc1` | IDF | 0, 1 | 24 | 1.280 mỗi cái | 444, 500 | Chạy một hàm trên lõi kia, vd. lúc ghi flash phải dừng lõi còn lại |
| `IDLE0`, `IDLE1` | FreeRTOS | 0, 1 | 0 | 1.536 mỗi cái | 796, 788 | Idle: dọn task đã xoá; watchdog canh cả hai |
| console REPL | `app_console` | tự do | 2 | 8.192 | — | Nạp NVS qua USB và lệnh `heap`; có ở `dev` và `bench`, kể cả bản `fleet` dựng từ `bench`; `prod` tắt |
| `main` | IDF | 0 | 1 | 3.584 | — | Chạy `app_boot`, khởi các task rồi return; IDF xoá nó và trả lại stack |

`ipc0` là task mỏng nhất cả hệ. Đây là cỡ IDF tự đặt (`CONFIG_ESP_IPC_TASK_STACK_SIZE`), không
phải của dự án.

## 3. Hàng đợi

Chỉ `q_frame_ai` chở **con trỏ**. Mọi hàng đợi khác **chép nguyên item** vào bộ nhớ của hàng
đợi, nên bên gửi xong là có thể dùng lại biến của mình ngay.

### 3.1 Hàng đợi của dự án

Dựng một lần trong `main/app_wiring.c`.

| Hàng đợi | Ô × item | Bộ nhớ | Gửi → nhận | Để làm gì |
|---|---|---|---|---|
| `q_frame_ai` | 1 × `camera_fb_t *` 4 B | 4 B nội | cam → ai | Luôn xử lý khung mới nhất. Khung thật nằm trong pool 4 khung ở PSRAM; ai nhận khung thì phải trả nó về pool |
| `q_result` | 4 × 156 B `svc_vision_result_t` | 624 B nội | ai → attend | Tách phần tính toán khỏi phần nghiệp vụ |
| `q_presence` | 2 × 4 B | 8 B nội | tof → attend | Chở cạnh có người / hết người, không chở khoảng cách |
| `q_audio` | 4 × 4 B | 16 B nội | attend → audio | Phát tiếng không chặn nghiệp vụ |
| `q_uplink` | 16 × 48 B `storage_attend_record_t` | 768 B nội | attend → sync | Chỉ là lời nhắc: bản ghi đã nằm trên flash trước khi vào đây |
| `q_cmd` | 4 × 160 B `device_command_t` | 640 B nội | mqtt_task → sync | Lệnh từ server; callback của esp-mqtt không được chặn lâu |
| `q_event` | 8 × 88 B `app_event_t` | 704 B nội | ai, tof, attend → sync | Bên phát sự kiện không tự publish, vì chờ PUBACK là mất khung |
| `q_ota` | 1 × 1.856 B `ota_manifest_t` | 1.856 B nội | mqtt_task → ota | Mỗi lúc chỉ cài một ảnh |
| `q_roster` | 1.072 × 576 B `app_roster_t` | **617.472 B PSRAM** | mqtt_task → sync | Sâu bằng một lượt đồng bộ lại trọn vẹn: 1.000 mẫu, 64 dòng gán, 8 ô dư |

`q_roster` dựng bằng `xQueueCreateStatic` trên vùng chứa xin ở PSRAM. Tám hàng đợi còn lại dựng
bằng `xQueueCreate`, mà `pvPortMalloc` của IDF luôn lấy RAM nội. Mỗi hàng đợi còn một khối điều
khiển cỡ chục byte ở RAM nội 🔬.

### 3.2 Hàng đợi của driver và IDF

| Hàng đợi | Của ai | Ô | Để làm gì |
|---|---|---|---|
| `event_queue` | esp32-camera | số nửa-đệm DMA trừ 1, item 4 B | Ngắt camera báo cho `cam_task` của driver |
| `frame_buffer_queue` | esp32-camera | 3 × con trỏ khung | Khung đầy chờ `drv_camera_grab` lấy; chế độ `GRAB_LATEST` với 4 khung |
| hàng sự kiện | esp_event | 32 | Sự kiện Wi-Fi và IP tới `sys_evt` |
| mbox của lwIP | lwIP | 32 | Gói và lời gọi vào `tcpip` |
| hàng lệnh timer | FreeRTOS | 10 | Lệnh tới `Tmr Svc` |

## 4. Khoá, semaphore, event group, timer

| Tên trong code (tên ở KẾ HOẠCH) | Kiểu | Ai lấy | Hạn chờ | Giữ cho cái gì |
|---|---|---|---|---|
| `s_i2c_mutex` (`m_i2c`) | mutex | touch, tof, `drv_ioexp`, RTC của `sys_time` | mỗi driver tự đặt | Một bus I2C chung cho GT911, VL53L1X, PCF8574, DS3231 |
| `s_lock` (`m_littlefs`) | mutex | mọi lời gọi đọc/ghi qua `sys_storage` | 5.000 ms | LittleFS và NVS không an toàn khi nhiều task gọi cùng lúc; chỉ `sys_storage` được gọi `lfs_*`, `nvs_*` |
| `mutex_` (`m_facedb`) | mutex | ai khi tra bảng; người ghi lấy nó ngắn lúc sửa và lúc nén bảng | 200 ms | Bảng embedding ở PSRAM không bị sửa giữa lúc đang so khớp |
| `io_mutex_` (`m_facedb_io`) | mutex | sync (roster, đánh dấu mẫu đã báo), ui (ghi xuống flash cuối phiên đăng ký), ai (giữ một mẫu đăng ký) | 4.000 ms | Xếp hàng các người ghi; lần ghi 576 KB xuống flash (1,8–2,3 s) chạy ngoài `m_facedb` |
| `mutex_` (`m_door`) | mutex | attend, task `esp_timer` | 50 ms | Trạng thái tay servo; khoá lá, không lấy khoá nào khác bên trong |
| `s_send_lock` | mutex | người publish | 5.000 ms | Mỗi lúc một lượt publish QoS 1 cộng chờ PUBACK |
| `s_acked` | semaphore nhị phân | handler MQTT cho, người publish lấy | theo publish | Báo PUBACK đã về |
| `s_bounce_free` | semaphore đếm, 2 suất | callback DMA của LCD cho, `cam` lấy | — | Hai đệm bounce 20 dòng của LCD |
| `s_ready` (`s_tof_int`) | semaphore nhị phân | ngắt GPIO3 cho, tof lấy | — | Một lần đo xong |
| `s_report` | semaphore nhị phân | ngắt GPIO14 cho, touch lấy | — | GT911 có điểm chạm |
| `s_published` | semaphore nhị phân | ui cho, `cam` lấy | tối đa một chu kỳ khung | Màn phủ kín: `cam` chờ overlay mới rồi mới vẽ |
| `eg_system` | event group | mọi task | — | 10 bit: `WIFI_OK` `MQTT_OK` `TIME_OK` `DB_LOADED` `AI_READY` `OTA_RUNNING` `PRESENT` `NEED_TICKET` `BROKER_REFUSED` `RENEW_TICKET` |
| `s_state` (`eg_wifi`) | event group | nội bộ `net_wifi` | — | Trạng thái link; `net` chuyển nó sang `WIFI_OK` |
| `wifi_retry` | esp_timer | `net_wifi` | — | Hẹn giờ nối lại Wi-Fi |
| hẹn giờ đóng cửa | esp_timer, một lần | `svc_door` | — | Hết `hold_ms` thì tự đóng cửa |
| watchdog task | WDT | ai, `IDLE0`, `IDLE1` | 5 s | Báo khi một task được canh không nạp nó trong 5 s, vd. model treo giữa một lượt chạy; riêng bản `fleet` thì khởi động lại máy |

**Thứ tự lấy khoá**: `m_facedb_io` → `m_facedb` → `m_littlefs` → `m_i2c`, không bao giờ lấy
ngược. Đường ghi bảng mặt cho thấy rõ nhất: `FaceDb::persist` giữ `m_facedb_io` suốt lượt, lấy
`m_facedb` để nén bảng rồi thả, sau đó mới qua `sys_storage` ghi flash dưới `m_littlefs`. Mọi lần
lấy mutex đều có hạn chờ; `portMAX_DELAY` bị cấm cho mutex (CLAUDE.md §4.1).

Năm semaphore đều chỉ để **báo hiệu**, không cái nào làm khoá: ba cái từ ngắt sang task (ToF,
touch, đệm bounce LCD), hai cái giữa hai task (ack MQTT, overlay của UI). Khoá thì dùng mutex,
vì mutex có kế thừa ưu tiên còn semaphore thì không (`FREERTOS.md` 10.4).

## 5. Những đường không đi qua hàng đợi

Hàng đợi chở **sự kiện**: thứ phải tới đủ, đúng thứ tự, không được rơi. Còn thứ chỉ cần **giá trị
mới nhất** thì đi qua một ô nhớ dùng chung, vì một hàng đợi ở đó sẽ phát lại những giá trị đã cũ.

| Đường | Cơ chế | Người ghi | Người đọc | Vì sao không dùng hàng đợi |
|---|---|---|---|---|
| Điểm chạm | `std::atomic<int32_t> s_touch` | touch | ui | UI chỉ cần biết ngón tay đang ở đâu mỗi nhịp 20 ms |
| Phán quyết lên màn | spinlock `s_offer_lock` và một `ui_kiosk_verdict_t` 44 B | attend | ui | Màn chỉ cần câu mới nhất; dài hơn một từ máy nên phải chép dưới spinlock |
| Thông tin máy, mạng, vé, danh sách chờ | bốn hộp thư `Mailbox`, mỗi cái một spinlock | attend (máy, mạng), ota (vé), sync (danh sách chờ) | ui | Mỗi lần sửa tăng số thứ tự; `ui` chỉ vẽ lại khi số đổi |
| Overlay trên kính | con trỏ atomic `s_shown`, `s_held`, `s_on_glass` | ui, cam | cam, ui | Hai ô overlay luân phiên; mỗi bên chỉ cần biết ô nào đang dùng |
| Cờ trạng thái | bit của `eg_system` | nhiều task | nhiều task | Trạng thái kéo dài, không phải sự kiện xảy ra một lần |

Có chín spinlock (`portMUX`): năm biến riêng và bốn hộp thư. Mỗi cái chỉ bọc vài chục byte cần
chép cùng nhau, không gọi hàm nào bên trong. Còn khoảng 25 biến atomic cho các mức và cờ, vd. độ
sáng, giờ máy thức dậy, số lần boot.

## 6. RAM: ai giữ bao nhiêu

### 6.1 RAM nội

Tính từ hằng số trong code, chưa phải số đo.

| Khoản | Bytes |
|---|---:|
| Stack 9 task dự án thường trú (`net` đã tự xoá) | 44.032 |
| Stack `cam_task` của esp32-camera | 4.096 |
| Stack task IDF: wifi, tcpip, esp_timer, sys_evt, Tmr Svc, IDLE ×2, ipc ×2 | 23.296 |
| Console REPL (không có ở `prod`) | 8.192 |
| Stack ngắt, 1.536 B mỗi lõi (`.bss`) | 3.072 |
| Item của 8 hàng đợi dự án ở RAM nội | 4.620 |
| **Cộng** | **87.308** |

Chưa tính TCB của từng task và khối điều khiển của từng hàng đợi 🔬. Lúc boot còn thêm stack
`main` 3.584 B và `net` 4.096 B, cả hai trả lại sau đó.

Đáy RAM nội đo trên board, cũng ở `ram.md`:

| Lượt đo | Đáy RAM nội | Nguồn |
|---|---:|---|
| 23/09, `bench_mem`, ESP-DL, đệm bounce 20 dòng, chưa có TLS | 38.067 B | `ram.md` §10.1 |
| 09/10, `bench_mem`, có phiên TLS thật | 29.755 B | `ram.md` §11 |
| 10/10, bản `fleet` trên kiosk thật, có console | 3.847 B | `ram.md` §12 |

Để so: hai bộ đệm DMA của LCD và camera giữ 56.320 B (đệm bounce 20 dòng 25.600 B, DMA camera
30.720 B, `ram.md` §3), còn phần tĩnh của ảnh trong DIRAM là 194.276 B (`ram.md` §10). Bản `fleet`
có console thì sát đáy: console REPL xin stack 8 KB sau mọi task, và có lần trượt vì khối liền
lớn nhất chỉ còn 4,3 KB (`ram.md` §12).

### 6.2 PSRAM

| Khoản | Bytes |
|---|---:|
| Pool 4 khung camera 480×320 RGB565, mà `q_frame_ai` trỏ vào | 1.228.800 |
| Vùng chứa của `q_roster` | 617.472 |
| Stack `mqtt_task` | 6.144 |

PSRAM không phải chỗ chật: đáy đo 09/10 còn 2.046 KB (`ram.md` §11).

## 7. Hai điểm còn mở

Cả hai ghi ở `FREERTOS.md` §0.4, và đều cần chủ repo quyết hướng sửa vì đụng tới thiết kế.

- **`ai` chờ `m_facedb_io` tới 4 s khi giữ một mẫu đăng ký.** Nếu lúc ấy `sync` đang ghi bảng
  1,8–2,3 s, `ai` đứng nguyên một bước. Watchdog 5 s vẫn còn biên, nhưng biên ấy mỏng.
- **Hai đường ghi thẳng vào trạng thái của `ui_kiosk`.** `sync` gọi `ui_kiosk_set_levels`, còn
  `ai` gọi `ui_kiosk_on_faces` và `ui_kiosk_on_stage`; cả hai ghi vào biến mà `ui` cũng ghi, không
  qua hộp thư như KẾ HOẠCH §4.5.5h quy định. Hậu quả đã biết chỉ là một lần vẽ lại bị bỏ, hoặc màn
  Capture ghép mẫu mới với khuôn mặt cũ trong một nhịp.
