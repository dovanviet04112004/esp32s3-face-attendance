# RAM — ai ăn bao nhiêu

Sổ đo bộ nhớ chạy: **RAM nội (SRAM) ở §1–§5**, **PSRAM ở §6**. Số chi tiết của riêng arena TFLM
nằm ở `arena.md`; ở đây là toàn cảnh, để trả lời đúng một câu hỏi — thứ nào đang giữ bao nhiêu.

Ba nguồn số, **không được trộn**: phần tĩnh lấy từ `idf.py size-components` của đúng bản dựng;
ngăn xếp task và các khối lớn lấy từ hằng số trong code; phần còn lại đo trên board bằng
`test_apps/bench_mem`. Mỗi bảng dưới đây ghi rõ nó thuộc profile nào — `dev` (`-Og` +
`HEAP_POISONING_LIGHT`) hay `bench` (`-O2`, poisoning tắt). Trừ số của hai profile cho nhau là
sai, và đã sai một lần rồi (§4).

---

## 1. 512 KB chia đi đâu trước khi có dòng code nào

| Khoản | Bytes | Ghi chú |
|---|---|---|
| Tổng SRAM trong chip | 524.288 | ESP32-S3 |
| Cache lệnh | −32.768 | `CONFIG_ESP32S3_INSTRUCTION_CACHE_32KB` |
| Cache dữ liệu | −65.536 | `CONFIG_ESP32S3_DATA_CACHE_64KB` |
| ROM giữ chỗ + vùng không cấp phát được | −84.224 | phần còn lại, IDF không trả về heap |
| **DIRAM còn dùng được** | **341.760** | con số `idf.py size` báo |

Hai dòng cache là đánh đổi tốc độ đã chốt ở §3 lớp 5 của kế hoạch, không phải chỗ để tiết kiệm.

---

## 2. Phần tĩnh — `.bss` + `.data` + code nằm trong IRAM

Bản **`dev`**, đo 18/09 bằng `idf.py size`:

| Phần | Bytes | % DIRAM |
|---|---|---|
| `.text` trong IRAM | 101.599 | 29,7 % |
| `.data` | 33.917 | 9,9 % |
| `.bss` | 33.808 | 9,9 % |
| `.vectors` | 1.028 | 0,3 % |
| **Tổng tĩnh** | **170.352** | **49,9 %** |
| **Còn lại làm heap lúc boot** | **171.408** | 50,1 % |

Bản **`bench`** cùng ngày: tĩnh **154.459 B**, heap lúc boot **187.301 B**. Chênh **15.893 B**
là giá của `-Og`: riêng code trong IRAM đã hơn 10.312 B.

### 2.1 Phần tĩnh theo thư viện, bản `dev`

Cột DIRAM = `.bss` + `.data` + code IRAM của chính thư viện đó.

| Nhóm | Thư viện | DIRAM |
|---|---|---|
| **Wi-Fi + mạng** | `pp` 18.574 · `net80211` 12.502 · `phy` 8.498 · `lwip` 3.790 · `wpa_supplicant` 1.371 · `esp_wifi` 863 · `esp_netif` 213 | **45.811** |
| **Flash + PSRAM + MSPI** | `spi_flash` 20.407 · `esp_hal_mspi` 5.400 · `esp_psram` 2.310 · `esp_mm` 1.786 | **29.903** |
| **Nhân hệ thống** | `heap` 7.569 · `freertos` 10.252 · `esp_system` 4.517 · `esp_libc` 4.017 · `xtensa` 3.552 · `hal` 3.299 · `libc` 520 · `esp_timer` 1.273 · `log` 792 | **35.791** |
| **Hỗ trợ phần cứng** | `esp_hw_support` 14.149 | **14.149** |
| **Camera** | `esp32-camera` 12.053 · `drv_camera` 25 | **12.078** |
| **Màn hình + cảm ứng** | `esp_driver_spi` 5.137 · `esp_hal_gpspi` 3.410 · `drv_lcd` 672 · `esp_lcd` 166 · `esp_lcd_st7796` 45 · `drv_touch` 8 | **9.438** |
| **Code của dự án** | xem bảng 2.2 | **12.427** |
| Gỡ lỗi, chỉ có ở `dev` | `esp_gdbstub` 1.445 | 1.445 |
| Còn lại (i2c, i2s, gpio, ledc, dma, nvs, vfs, littlefs, tflm, esp-nn…) | | ~9.300 |

**Wi-Fi một mình ăn 45,8 KB tĩnh, bằng gần bốn lần toàn bộ code của dự án.**

### 2.2 Code của dự án, từng component

| Component | DIRAM | `.bss` | `.data` |
|---|---|---|---|
| `ui_kiosk` | **5.426** | 5.265 | 161 |
| `ai_engine` | 3.389 | 2.729 | 660 |
| `svc_vision` | 1.137 | 1.121 | 16 |
| `drv_lcd` | 672 | 672 | 0 |
| `svc_facedb` | 556 | 552 | 4 |
| `drv_audio` | 517 | 516 | 1 |
| `main` | 377 | 373 | 4 |
| `svc_attendance` | 92 | 91 | 1 |
| `sys_storage` | 86 | 86 | 0 |
| `svc_door` | 45 | 1 | 44 |
| `drv_tof` | 44 | 9 | 0 |
| `drv_camera` | 25 | 21 | 4 |
| `sys_time` | 18 | 18 | 0 |
| `net_wifi` | 16 | 12 | 4 |
| `bsp_board` | 9 | 9 | 0 |
| `drv_touch` | 8 | 8 | 0 |
| `drv_servo` | 5 | 5 | 0 |
| `drv_ioexp` | 5 | 4 | 1 |
| **Tổng** | **12.427** | | |

`ui_kiosk` chiếm 44 % phần tĩnh của dự án vì các bộ đệm màn hình và bảng chữ nằm trong `.bss`.

---

## 3. Phần xin lúc chạy — khối lớn, lấy từ hằng số trong code

| Khoản | Bytes | Nguồn | Có đẩy sang PSRAM được không |
|---|---|---|---|
| **Đệm bounce của LCD** | **40.960** | `drv_lcd.c`: `BOUNCE_ROWS` 32 × `APP_LCD_H_RES` 320 × 2 B × 2 đệm | **Không** — `MALLOC_CAP_DMA \| MALLOC_CAP_INTERNAL`, SPI DMA không đọc thẳng PSRAM |
| **Đệm DMA của camera** | **30.720** | driver esp32-camera: `dma_half_buffer` 15.360 B × 2 | **Không** — cùng lý do; khung ảnh thì đã ở PSRAM (`CAMERA_FB_IN_PSRAM`, 4 khung) |
| Ngăn xếp 8 task của dự án | 38.912 | `app_tasks.c` | Không — ngăn xếp FreeRTOS lấy từ RAM nội |
| Ngăn xếp task của IDF | ~30.976 | Kconfig, xem 3.1 | Không |

Hai dòng đầu cộng lại **92.160 B — hơn một nửa heap lúc boot**, và **không có đường nào đẩy đi**.
Đây là câu trả lời cho "sao RAM nội hết": không phải model, không phải code dự án, mà là **hai
bộ đệm DMA của màn hình và camera**.

### 3.1 Ngăn xếp từng task

| Task | Cấp | Còn trống (đo `bench` 18/09) | Nguồn |
|---|---|---|---|
| `ai` | 8.192 | **1.284** | `AI_TASK_STACK_BYTES` |
| `ui` | **4.096** | 6.772 trên 8.192 lúc đo | `UI_TASK_STACK_BYTES`, cắt 19/09 |
| `wifi` | 6.656 | 4.316 | driver Wi-Fi |
| `cam` | 4.096 | 2.640 | `CAM_TASK_STACK_BYTES` |
| `attend` | 4.096 | 2.836 | `ATTEND_TASK_STACK_BYTES` |
| `audio` | 4.096 | 2.348 | `AUDIO_TASK_STACK_BYTES` |
| `net` | 4.096 | — | `NET_TASK_STACK_BYTES`, task **tự xoá** sau khi SNTP chạy nên trả lại |
| `cam_task` (esp32-camera) | 4.096 | 3.344 | `CONFIG_CAMERA_TASK_STACK_SIZE` |
| `main` | 3.584 | 5.760 ⚠️ | `CONFIG_ESP_MAIN_TASK_STACK_SIZE` |
| `esp_timer` | 3.584 | 3.124 | `CONFIG_ESP_TIMER_TASK_STACK_SIZE` |
| `tcpip` | 3.072 | 1.784 | `CONFIG_LWIP_TCPIP_TASK_STACK_SIZE` |
| `tof` | 3.072 | 1.640 | `TOF_TASK_STACK_BYTES` |
| `touch` | 3.072 | 1.484 | `TOUCH_TASK_STACK_BYTES` |
| `sys_evt` | 2.304 | 1.472 | `CONFIG_ESP_SYSTEM_EVENT_TASK_STACK_SIZE` |
| `Tmr Svc` | 2.048 | 1.448 | `CONFIG_FREERTOS_TIMER_TASK_STACK_DEPTH` |
| `IDLE0` / `IDLE1` | 1.536 mỗi | 792 / 784 | `CONFIG_FREERTOS_IDLE_TASK_STACKSIZE` |
| `ipc0` / `ipc1` | 1.280 mỗi | 444 / 564 | `CONFIG_ESP_IPC_TASK_STACK_SIZE` |

⚠️ `main` báo trống nhiều hơn mức cấp vì `bench_mem` chạy trong chính task ấy sau khi IDF đã
nới nó; đây là số của app đo, không phải của kiosk.

**Hai chỗ thừa thấy ngay**: `ui` cấp 8.192 mà chỉ chạm hơn 1,4 KB — **đã cắt còn 4.096 ngày
19/09**, thu về 4 KB, còn biên 2.676 B. `ai` thì ngược lại, chỉ còn **1.284 B** và đó là lúc **chưa có mặt người nào** trước
camera, tức mới chạy detect; spoof và recog đi sâu hơn nên **không được cắt** và phải đo lại
với mặt thật (E8-T9 còn nợ).

---

## 4. Đo trên board — `bench_mem`, profile `bench`, 18/09

| Mốc | Đáy RAM nội | Đáy PSRAM |
|---|---|---|
| trước `app_boot` | 248.331 B (242 KB) | 8.189 KB |
| sau `app_boot`, ba model đã nạp | 85.699 B (83 KB) | 5.198 KB |
| **kiosk chạy, 6 mẫu cách nhau 10 s** | **41.531 B (40 KB)** | **5.070 KB** |

Đáy đứng nguyên qua cả sáu mẫu: heap phẳng, không rò.

### 4.1 Heap nội **không phải một khối** — đây mới là điều quan trọng

`heap_caps_print_heap_info(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)` lúc kết thúc:

| Vùng | Dài | Trống | Mảnh lớn nhất | Số khối đã cấp | Đáy |
|---|---|---|---|---|---|
| `0x3fcadbc0` | 244.560 | 8.228 | **4.096** | 206 | **1.708** |
| `0x3fce9710` | 22.308 | **4** | 0 | 149 | 4 |
| `0x3fcb3c5c` | 32.767 | 32.031 | **31.744** | **0** | 32.031 |
| `0x600fe000` (RTC fast) | 8.168 | 7.788 | 7.680 | 0 | 7.788 |
| **Tổng** | | **48.051** | **31.744** | | **41.531** |

Đọc bảng này cho đúng:

- **Heap chính đã đầy.** 244 KB chỉ còn 8 KB trống, mảnh lớn nhất **4 KB**, và đáy của nó là
  **1.708 B**. Mọi lần `malloc` bình thường đều rơi vào đây.
- **Vùng 32 KB ở `0x3fcb3c5c` chưa ai từng xin một byte** (0 khối), và log boot nói thẳng nó là
  gì: `esp_psram: Reserving pool of 32K of internal memory for DMA/internal allocations`. Đó là
  `CONFIG_SPIRAM_MALLOC_RESERVE_INTERNAL` = 32.768. Vì `CONFIG_SPIRAM_USE_MALLOC=y` cho `malloc()`
  thường trả về PSRAM, IDF **tách riêng** chừng này RAM nội ra khỏi vùng `malloc` thường, để
  những chỗ *bắt buộc* phải nội hoặc phải DMA luôn còn chỗ. Nên nó **dùng được** (qua cả
  `MALLOC_CAP_8BIT` lẫn `MALLOC_CAP_DMA`) nhưng nó là **lưới an toàn của DMA**, không phải chỗ
  trống để tiêu.
- Nên câu "còn 40 KB" **không** có nghĩa là xin được một khối 40 KB. Xin **≤ 4 KB** thì lấy ở
  heap chính; xin **4–31 KB** thì rơi vào vùng riêng kia và **chỉ xin được một lần**.
- Đây **không phải phân mảnh**. Phân mảnh là nhiều mảnh nhỏ rời rạc do cấp phát rồi giải phóng
  lẫn lộn; ở đây đáy phẳng suốt sáu mẫu và heap chính có đúng 6 khối trống. Nó **đầy**, không
  **vụn**. Phép sửa của §3.8 (xin arena sớm nhất, trước khi driver lên) vẫn còn nguyên tác dụng
  và không liên quan tới chuyện này.

### 4.2 Bản `dev` khác hẳn, đừng lấy bảng trên thay

Bản `dev` đang nạp trên board đo sáng 18/09: trống **19–21 KB**, đáy **9.983 B**, mảnh lớn nhất
**7.668 B**. Khoản chênh so với `bench` tách được sạch:

| Phép trừ | Khác nhau ở | Chênh |
|---|---|---|
| `bench` 13/09 → `bench` 18/09 | lượng code (UI, loa, phiên TCP thật) | 31.792 B |
| `bench` 18/09 → `dev` 18/09 | profile (`HEAP_POISONING_LIGHT`, `-Og`) | 31.548 B |
| cộng | | 63.340 B = đúng 73.323 − 9.983 |

Một nửa khoản hụt là **giá của profile gỡ lỗi**, không phải của tính năng mới.

---

## 5. Hệ quả cho `net_mqtt` + TLS (E10-T6)

Một phiên TLS mặc định của IDF cần **đệm vào 16.384 B liền một dải** cộng đệm ra 4.096 B
(`MBEDTLS_ASYMMETRIC_CONTENT_LEN` bật sẵn), cộng ngăn xếp `mqtt_task` 6 KB và `sync_task` 5 KB
của §5.2 — ngăn xếp cũng lấy từ RAM nội.

**Vì sao nó không tự rơi xuống PSRAM như những khối to khác.** `CONFIG_SPIRAM_USE_MALLOC=y` cho
`malloc()` thường trả về PSRAM, phân theo cỡ: `heap_caps_malloc_default` xin **≤**
`CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL` (16.384 B) thì thử RAM nội trước, lớn hơn mới thử PSRAM
trước. Nhưng **mbedTLS không đi qua `malloc()`**: IDF cấp cho nó một bộ cấp phát riêng ở
`components/mbedtls/port/esp_mem.c`, và một nút radio trong Kconfig quyết định thẳng nó xin
loại RAM nào.

```c
#ifdef CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC
    return heap_caps_calloc(n, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
#elif CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC
    return heap_caps_calloc(n, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
```

Đang bật nhánh trên. Nên đây **không phải chuyện thiếu chỗ mà là một mặc định ép sai chỗ**: luật
theo cỡ ở trên không bao giờ được hỏi tới, mọi cấp phát của TLS đều đòi RAM nội bất kể lớn nhỏ,
và vì `MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT` không kèm `MALLOC_CAP_DEFAULT` nên nó **lấy được
cả lưới an toàn 32 KB của DMA** ở §4.1.

| Profile | Mảnh lớn nhất | Đệm vào 16 KB có vừa không |
|---|---|---|
| `bench` / `prod` | 31.744 B | vừa — **nhưng nó ăn đúng cái lưới an toàn 32 KB của DMA ở §4.1**, còn lại ~15 KB |
| `dev` | 7.668 B | **không** |

Ba cần gạt, **đều là Kconfig, không sửa một dòng code**. **Đã chốt cái đầu, 18/09:**

| Cần gạt | Thu về | Cái giá |
|---|---|---|
| `MBEDTLS_EXTERNAL_MEM_ALLOC=y` | toàn bộ heap mbedTLS sang PSRAM (còn 5 MB) | bắt tay chạy trên PSRAM nên chậm hơn; đủ điều kiện vì `SPIRAM_USE_MALLOC=y` |
| hạ `MBEDTLS_SSL_IN_CONTENT_LEN` từ 16.384 | tới 14 KB RAM nội | 🔬 phải biết chuỗi chứng thư thật của broker — đặt thấp quá là **hỏng bắt tay**, không phải chậm |
| `MBEDTLS_DYNAMIC_BUFFER=y` | trả đệm lại giữa hai lần bắt tay | mỗi lần nối lại phải xin lại, gặp heap đầy thì trượt |

**Chốt `MBEDTLS_EXTERNAL_MEM_ALLOC=y`**, khai ở `sdkconfig.defaults.esp32s3` — quyết định của
board, không của một profile. Hai cách kia **vẫn để TLS trong RAM nội**, chỉ bớt phần ăn; cách này
đưa hẳn sang nơi còn 5 MB và trả lại nguyên vẹn lưới 32 KB của DMA. Hạ `IN_CONTENT_LEN` còn rủi ro
không đáng: chuỗi chứng thư do broker quyết, đặt hụt là hỏng bắt tay chứ không phải chậm.
Nghiệm sau khi gạt: dựng sạch, Wi-Fi nối được, SNTP chỉnh được giờ. 🔬 chưa đo bắt tay chậm bao nhiêu.

**Cần gạt thứ tư, chốt 19/09: `MQTT_TASK_STACK_ON_EXTERNAL_MEMORY=y`.** Ba cần gạt trên lo phần
heap của mbedTLS; còn lại **ngăn xếp 6.144 B mà esp-mqtt tự xin cho task của nó**, và nó xin
liền một khối từ RAM nội. Bản `dev` chỉ có 4.596 B liền nên `esp_mqtt_client_start()` trả
`Error create mqtt task`. Lựa chọn này đẩy ngăn xếp ấy sang PSRAM, khối điều khiển task vẫn ở
RAM nội, cùng chính sách với `MBEDTLS_EXTERNAL_MEM_ALLOC` và hai arena TFLM.

Điều kiện an toàn của IDF là ngăn xếp ở PSRAM không được chạm khi cache flash tắt, và nó thoả về
mặt cấu trúc: `spi_flash_disable_interrupts_caches_and_other_cpu()` đỗ lõi kia và tắt ngắt suốt
lượt ghi, nên không task nào chạy. 🔬 Giá tốc độ không tách được khỏi nhiễu mạng: năm lượt nối
của cùng một binary cho 565, 1.292, 654, 2.532 và 1.253 ms.

Số sau khi gạt nằm ở §8.

---

## 6. PSRAM — 8 MB, và nó giữ gần hết những thứ to

Đo cùng lượt `bench_mem` 18/09:

| Mốc | PSRAM trống |
|---|---|
| trước `app_boot` | 8.189 KB |
| sau `app_boot` | 5.198 KB |
| kiosk chạy, đáy 6 mẫu | **5.070 KB** |

Tức hệ đang giữ **3.119 KB**. Khác với RAM nội, sổ này **khép được**:

| Khoản | Bytes | Nguồn |
|---|---|---|
| **Khung ảnh camera** | **1.228.800** | `CAM_FB_COUNT` 4 × 480×320 RGB565, `CAMERA_FB_IN_PSRAM` |
| **`arena_big`** (spoof + recog dùng chung) | **748.544** | log boot; `arena.md` §12 |
| **Bảng khuôn mặt** | **580.064** | `svc_facedb`: 1.000 bản ghi × 576 B + header + `norm_sq` 4 KB |
| **Hai lớp phủ của giao diện** | **307.200** | `ui_kiosk`: `kSlots` 2 × 320×480 × 1 B/điểm |
| **`arena_fast`** (detect) | **190.464** | log boot |
| **Clip âm thanh** | **131.072** | `AUDIO_CLIP_CAP_BYTES`, nạp một lần lúc `audio_task` lên |
| **Cộng** | **3.186.144** (3.111 KB) | |
| Đo thật | 3.193.856 (3.119 KB) | |
| **Chưa quy được** | **7.712 B (0,24 %)** | vặt vãnh của littlefs, vfs, driver |

Ba điều đọc ra từ bảng này:

- **Khung ảnh camera là khoản to nhất của cả hệ**, 1,2 MB, và nó **đã** ở PSRAM đúng chỗ. Bốn
  khung là để `cam_task` không bao giờ đói trong lúc `ai_task` còn giữ một khung; hạ xuống 3 thu
  về 300 KB PSRAM mà PSRAM thì đang thừa 5 MB, nên **không có lý do hạ**.
- **Hai arena cộng lại 939 KB** — chính là 224 KB RAM nội mà §6.4 đã đổi lấy +23,4 ms mỗi khung
  cho detect. Đổi đúng: PSRAM còn 5 MB, RAM nội còn 40 KB.
- **Bảng khuôn mặt cấp cứng cho 1.000 người** (`CONFIG_FACEDB_CAPACITY`) dù mới có vài người.
  Đây là 567 KB cấp một lần lúc boot, không lớn dần. Không đụng, nhưng phải biết là nó ở đó khi
  đọc con số PSRAM.

**PSRAM không phải chỗ chật.** Còn 5.070 KB, và phần lớn thứ có thể chuyển sang đó thì đã chuyển
rồi. Đó là lý do cần gạt đúng cho TLS ở §5 là **đẩy mbedTLS sang đây**, chứ không phải đi cắt xén
RAM nội.

---

## 7. Còn nợ

- 🔬 **Chưa khép sổ được từng byte.** Bảng §3 chỉ liệt kê những khối lớn có tên trong code;
  phần IDF tự xin (đệm Wi-Fi động, pbuf của lwIP, hàng đợi, littlefs, NVS) chưa tách ra được.
  Muốn khép thì bật `CONFIG_HEAP_TRACING_STANDALONE` rồi đổ danh sách theo hàm gọi — một lượt
  dựng và nạp riêng, chưa làm.
- 🔬 Watermark của `ai` phải đo lại **khi có mặt thật trước camera**, vì số 1.284 B hiện tại
  mới chỉ có detect chạy.
- 🔬 Watermark của `ui` sau khi cắt xuống 4.096 chưa đo lại; §8 chỉ đo heap toàn cục.
- 🔬 `ota_task` 8 KB chưa tồn tại, nên §8 mới là phép trừ chứ chưa phải phép đo.
- PSRAM thì **đã khép sổ**, chỉ còn 7.712 B chưa quy được — không cần truy thêm.

---

## 8. Sau khi MQTT lên — đo 19/09 trên kiosk thật, profile `dev`

Đọc bằng lệnh `heap` của `app_console`, lúc broker đã nối và preview đang chạy. Sáu mẫu cách
nhau 5 s cho cùng một con số, nên không rò.

### 8.1 Ba thay đổi và cái mỗi thay đổi trả về

| Bước | Mảnh liền lớn nhất | Tổng trống |
|---|---|---|
| Trước, `mqtt_task` không tạo nổi | 4.596 | 8.495 |
| Cắt `ui` 8.192 → 4.096 | 5.620 | 12.663 |
| `MQTT_TASK_STACK_ON_EXTERNAL_MEMORY=y` | 5.364 | 29.083 |
| `BOUNCE_ROWS` 48 → 32 | **22.516** | **33.015** |

Hai điều bảng này nói mà phép cộng không nói. Cắt `ui` thu về đủ 4 KB **tổng** nhưng chỉ 1 KB
vào **mảnh lớn nhất** — 3 KB kia rơi vào vùng khác. Và đẩy ngăn xếp MQTT sang PSRAM làm mảnh lớn
nhất **nhỏ đi** 256 B, vì khối điều khiển task vẫn ở RAM nội: nó mua 6 KB tổng và trả lại một ít
liền mạch. Chỉ `BOUNCE_ROWS` là trả về cả hai, vì 20 KB ấy nằm đúng trong vùng DMA nội và gộp
được.

### 8.2 Bản đồ vùng, cùng lượt đo

| Vùng | Dài | Trống | Mảnh lớn nhất | Số mảnh trống | Dùng được cho ngăn xếp task |
|---|---|---|---|---|---|
| `0x3fcb75bc` | 32.767 | 23.311 | **22.516** | 1 | **có** |
| `0x600fe000` | 8.168 | 4.700 | 4.596 | 1 | **không** — RTCRAM, vùng địa chỉ riêng |
| `0x3fce9710` | 22.308 | 8 | 0 | 1 | đầy |
| `0x3fcb2740` | 225.232 | 4.636 | 3.700 | 7 | không đủ cỡ |
| **Tổng** | | **32.655** | **22.516** | | đáy từng đo 24.739 |

**"Còn 33 KB" không có nghĩa xin được khối 33 KB.** 4.700 B là RTCRAM mà FreeRTOS không đặt
ngăn xếp lên được, 4.636 B còn lại là bảy khe nhỏ giữa 289 khối đã cấp. Chúng vẫn phục vụ hàng
trăm cấp phát nhỏ, chỉ không gom thành khối lớn.

### 8.3 Đủ cho hai task còn lại của §5.2

```
22.516 − 5.120 (sync_task) − 8.192 (ota_task) ≈ 9,2 KB còn liền
```

`prod` và `bench` rộng hơn ~20 KB nữa vì không mang canary lẫn `-Og`. `ota_task` tạo theo yêu
cầu chứ không thường trú, nên lúc nó chạy còn phải chia chỗ với đệm tải OTA — đo lại khi E13-T1
có code.

---
