# CLAUDE.md

Quy tắc bắt buộc cho mọi thay đổi trong repo `esp32s3-face-attendance`.
Áp dụng cho cả người và AI agent. Đọc hết trước khi sửa dòng code đầu tiên.

| Tài liệu | Vai trò | Đổi khi nào |
|---|---|---|
| `docs/KE_HOACH_face_attendance_esp32s3.md` — gọi tắt **KẾ HOẠCH** | Kiến trúc. Nguồn sự thật | Chỉ khi kiến trúc đổi, theo quy trình §1.2 |
| `docs/TASKS.md` | Backlog: 14 epic, task và điều kiện xong | Thường xuyên, không cần duyệt |
| `CLAUDE.md` (file này) | Quy tắc làm việc | Hiếm, phải bàn trước |

**Quy ước trích dẫn**: `KẾ HOẠCH §x.y` là mục trong file kiến trúc; `§x.y` trơ trọi là mục trong chính file này.

---

## 1. Kế hoạch đi trước code

### 1.1 Trước khi sửa, đọc mục tương ứng

| Định làm gì | Đọc trước |
|---|---|
| Tạo file / thư mục mới | §4 — không có trong §4 thì **không được tạo** |
| Thêm dependency | §4.5.1 — registry / `third_party/` / tự viết |
| Đổi chân GPIO | §2 |
| Thêm task, queue, mutex, semaphore | §5 |
| Đụng bộ nhớ, partition, định dạng bản ghi | §6, và `sys_storage/include/storage_format.h` |
| Đổi model, dataset, split | §1, §4.4 |
| Đổi payload MQTT | `contracts/schema/` — **không** sửa ở firmware/backend/frontend |
| Thêm kỹ thuật tối ưu model | §3 |
| Chọn KD hay không KD cho một nhánh | §3.7 — **bắt buộc chạy đủ 4 arm**, không chọn cảm tính |
| Lượng tử hoá một nhánh | §3.8 — leo thang Q0→Q10, dừng khi đạt ngưỡng |
| Chọn layer giữ float | §3.9 — phải có `layer_sensitivity.csv`, không đoán |
| Cấp phát arena TFLM | §3.10 — `Σ tail + max(head)`, không phải `max` cũng không phải tổng |

### 1.2 Khi kế hoạch cần đổi

```
1. Nêu vấn đề + phương án + đánh đổi  →  chờ duyệt
2. Sửa KẾ HOẠCH
3. Sửa code
```

Không bao giờ code trước rồi cập nhật kế hoạch sau. Code không khớp kế hoạch là code sai, kể cả khi nó chạy.

Sửa KẾ HOẠCH thì viết lại mục đó thành bản hoàn chỉnh, độc lập. Không changelog, không đối chiếu bản cũ — git giữ lịch sử. Sửa số liệu thì sửa luôn mọi tham chiếu chéo `§x.y` và mục lục.

### 1.3 Đổi GPIO là thao tác nguyên tử

Chân GPIO khai ở đúng hai chỗ: `firmware/main/app_config.h` và KẾ HOẠCH §2. Sửa một chỗ mà quên chỗ kia thì phần cứng đã hàn sẽ không khớp. Phải sửa cả hai trong **cùng một commit**.

---

## 2. Luật comment

### 2.1 Mỗi loại thông tin có đúng một chỗ

| Thông tin | Nơi duy nhất |
|---|---|
| Code làm **cái gì** | Chính code và tên định danh |
| Ràng buộc / giả định code không tự thể hiện | Comment 1 dòng |
| Hợp đồng của hàm public | Doc comment ở header công khai |
| **Vì sao sửa, sửa cái gì, khác bản cũ ra sao** | **Commit message** |
| Quyết định kiến trúc | KẾ HOẠCH |
| Giải thích cho người review | Mô tả PR / trả lời trong chat |

> **Quá trình đi vào commit message. Trạng thái đi vào comment.**

Đây là luật quan trọng nhất của cả mục này. Cảm giác muốn viết "tại sao tôi sửa chỗ này" là có thật và hợp lý — nhưng chỗ của nó là commit message, không phải file code.

### 2.2 Nguyên tắc

- Code nói **CÁI GÌ**. Comment nói **TẠI SAO**.
- Không comment cái hiển nhiên.
- Không dùng comment để cứu tên biến/hàm khó hiểu → sửa tên.
- Chỉ comment khi có *why*, *constraint*, *assumption*, *workaround* mà code không tự thể hiện.
- Comment sai tệ hơn không có comment. Đổi code thì đổi comment trong cùng commit.
- **Đọc code đã hiểu mà không mất thông tin quan trọng → xóa comment.**

### 2.3 Định mức cứng

| Ràng buộc | Giới hạn |
|---|---|
| Comment trong thân hàm | **1 dòng** |
| Khối comment liên tiếp trong file thân | **tối đa 2 dòng**, và phải thuộc §2.5 |
| Doc comment ở header công khai | **tối đa 6 dòng** |
| Mật độ comment trên tổng số dòng code, mỗi file thân | **≤ 10%** |
| Doc comment trong `.c` / `.cpp` | **0** — hợp đồng chỉ nằm ở header |

Cần 2 dòng để giải thích một chỗ nghĩa là **code chưa đủ rõ**: tách hàm hoặc đổi tên, đừng viết dài hơn. Comment 3 dòng trở lên chưa bao giờ là câu trả lời đúng.

### 2.4 Cấm comment quá trình

Comment mô tả **trạng thái hiện tại** của code, không mô tả **lịch sử sửa**. Người đọc comment chưa từng thấy bản cũ; mọi câu chỉ có nghĩa khi đem so với bản cũ đều là rác.

Từ khóa bị CI chặn khi xuất hiện trong comment:

```
previously · used to · was · before · originally · changed · updated · fixed
refactored · instead of · now we · no longer · note that I · trước đây · đã sửa · thay vì
```

**Bad**
```c
// Fixed: we were calling this before bsp_init, which caused a crash.
// Changed to call it after the I2C bus is up.
// Previously the settle time was 100 ms but that turned out too short.
drv_tof_start(150);
```

**Good**
```c
// VL53L1X needs 150 ms to settle after XSHUT is released.
drv_tof_start(TOF_BOOT_SETTLE_MS);
```

Phần bị xóa đi không mất — nó nằm ở commit message:
```
fix(drv_tof): start ranging after bus init, raise settle time to 150 ms
```

### 2.5 Bốn tình huống được phép comment — danh sách đóng

Ngoài bốn loại này thì **không comment**.

| # | Loại | Ví dụ (đúng độ dài cho phép) |
|---|---|---|
| 1 | Ràng buộc phần cứng, kèm nguồn | `// OV5640 SCCB stalls below 6 MHz XCLK (DS rev 2.51 §4.2).` |
| 2 | Hợp đồng ẩn: thứ tự khóa, đơn vị, định dạng, bất biến | `// Lock order: m_facedb -> m_littlefs -> m_i2c -> m_spi_lcd (KEHOACH §5.3).` |
| 3 | Workaround, kèm triệu chứng nếu gỡ | `// GPIO45 is VDD_SPI strapping; driving it high before reset blocks boot.` |
| 4 | Quyết định phản trực giác | `// Cursor is persisted after the ack on purpose: at-least-once (KEHOACH §6.2.6).` |

Loại 4 **trích mã mục** thay vì chép lý do. Chép là tạo bản sao thứ hai, và bản sao sẽ lệch. Comment mâu thuẫn với KẾ HOẠCH thì dừng lại và hỏi, không tự sửa bên nào.

### 2.6 Hình thức thống nhất

| Chỗ | Dạng duy nhất được dùng |
|---|---|
| Thân hàm C/C++ | `//` một dòng, đặt **trên** dòng code |
| Khai báo dữ liệu (struct field, enum, `#define`) | `//` cuối dòng, ≤ 60 ký tự |
| Header công khai C/C++ | `/** */` Doxygen, ≤ 6 dòng |
| Python | docstring Google-style ở symbol public; thân hàm dùng `#` một dòng |
| TypeScript | TSDoc `/** */` ở symbol export; thân hàm `//` một dòng |

Cấm hoàn toàn: `/* */` nhiều dòng trong thân hàm · banner `//=====` hay `/*****` · ASCII art · comment chia section bên trong một hàm · `// end of function` · code bị comment out (xóa hẳn, git giữ).

### 2.7 Khuôn doc comment ở header

```c
/** Look up the closest enrolled template for an embedding.
 *  @ctx task | blocking | takes m_facedb
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND | ESP_ERR_INVALID_STATE
 */
esp_err_t svc_facedb_lookup(const int8_t *emb, float scale, match_result_t *out);
```

- Dòng đầu: một câu, làm gì. Không lặp lại tên hàm. Không dùng `@brief`.
- `@ctx` **bắt buộc trong firmware**: ngữ cảnh gọi (`task` / `isr-safe` / `any`), có chặn không, lấy khóa nào. Viết dạng tag, không viết văn.
- `@param` chỉ khi tên tham số không nói hết: đơn vị, ràng buộc, ai sở hữu bộ nhớ.
- Không lặp lại kiểu dữ liệu — chữ ký hàm đã có.

Python:
```python
def make_split(task: str, seed: int = 42) -> SplitResult:
    """Build an identity-disjoint split; mixed identities inflate recognition metrics."""
```
Chỉ thêm `Args` / `Returns` / `Raises` khi có ràng buộc không đọc được từ chữ ký và type hint.

### 2.8 Ba phép thử trước khi giữ lại một comment

1. **Xóa** — xóa đi có mất thông tin không? Không → xóa.
2. **Đổi tên** — đổi tên biến/hàm là hết cần comment? Có → đổi tên, xóa comment.
3. **Người lạ** — người chưa từng thấy bản cũ đọc có hiểu không? Không → đó là comment quá trình, xóa.

### 2.9 File sinh tự động

Mở đầu bằng đúng ba dòng, không thêm gì:
```
// GENERATED FILE - DO NOT EDIT.
// Source: contracts/schema/attendance_record.schema.json
// Regenerate: ./tools/gen_from_schema.sh
```

### 2.10 `third_party/`

Không sửa, không thêm comment vào code third-party. Ghi chú để ở `third_party/<name>/UPSTREAM.md`, sửa code thì để patch ở `third_party/<name>/patches/`.

### 2.11 Kiểm tra tự động

`tools/check_comments.py` chạy trong CI, fail khi vi phạm §2.3, §2.4, §2.6. Chạy tay trước khi commit:

```bash
python3 tools/check_comments.py
```

---

## 3. Đặt tên

| Phạm vi | Quy tắc | Ví dụ |
|---|---|---|
| Component firmware | Tiền tố = tầng (KẾ HOẠCH §4.5.4): `bsp_` `drv_` `sys_` `ai_` `net_` `svc_` `ui_` | `svc_facedb` |
| Symbol public C | `snake_case`, tiền tố bằng tên component | `svc_facedb_lookup()` |
| Symbol nội bộ C | `static`, `snake_case`, không tiền tố | `static compact_table()` |
| Lớp C++ | `PascalCase`; thành viên `snake_case_` có gạch dưới cuối | `class VisionPipeline` |
| Interface C++ | Tiền tố `I` | `ITfliteModel`, `IDoor` |
| Macro | `UPPER_SNAKE`, tiền tố `APP_` `BSP_` `DRV_` | `APP_CAM_XCLK_HZ` |
| File header | Trùng tên component | `svc_facedb.h` |
| Python | PEP 8 | `facepipe.tasks.detection.train_kd` |
| TypeScript | `camelCase` biến/hàm, `PascalCase` type/component | `useAttendance`, `DeviceCard` |
| Branch | `<type>/<scope>-<mô-tả-ngắn>` | `feat/firmware-svc-door` |

Đơn vị đo **luôn nằm trong tên**, không ngoại lệ: `timeout_ms`, `distance_cm`, `arena_bytes`, `xclk_hz`.

**Ngôn ngữ**: code, comment, log, commit message, tên branch → **tiếng Anh 100%**. `docs/`, `README.md`, `CLAUDE.md`, báo cáo ĐATN → tiếng Việt. Chuỗi hiển thị cho người dùng cuối → tiếng Việt, đặt trong file i18n, không hardcode trong logic.

---

## 4. Luật theo khối

### 4.1 Firmware

- Ranh giới C / C++ theo KẾ HOẠCH §4.5. Header công khai của component C++ chỉ chứa cú pháp C.
- `-fno-exceptions -fno-rtti`. Không `new` / `delete` sau khi boot xong.
- Tài nguyên có phạm vi ngắn (frame, khóa, mmap) **bắt buộc** dùng RAII guard, không tự gọi hàm giải phóng.
- Không component nào `REQUIRES` lên tầng trên hoặc ngang tầng. `tools/check_layers.py` kiểm tra.
- ISR: chỉ `*FromISR` + `portYIELD_FROM_ISR`. Không log, không I2C, không malloc.
- `xSemaphoreTake` luôn có timeout. Cấm `portMAX_DELAY` cho mutex.
- **Chỉ `sys_storage` được gọi `lfs_*`, `nvs_*`, `esp_partition_*`.** Component khác đi qua API công khai của nó.
- Layout nhị phân trên flash chỉ khai ở `sys_storage/include/storage_format.h`, kèm `static_assert` chốt `sizeof`. Không component nào khai lại struct.
- Đổi layout bản ghi → tăng `format_ver` **và** sửa KẾ HOẠCH §6.2 trong cùng commit.
- Mỗi model một thư mục riêng ở `ai_engine/src/<nhánh>/` và `firmware/models/<nhánh>/`. `ai_engine/src/core/` không được biết tên model nào.

### 4.2 ML

- Mỗi lần train ghi vào `artifacts/runs/<task>/<ngày>_<gitsha>_<cfghash>/` kèm `config.resolved.yaml`, `split.lock`, `env.txt`.
- Không hardcode đường dẫn dataset — khai ở `configs/common/paths.yaml`.
- `raw/` read-only tuyệt đối. Script ghi vào đó là bug.
- Sinh split mới thì kèm `SPLIT.md` (quy tắc, seed, sha256) và commit.
- Export model xong thì chạy `update_lock.py` cập nhật `contracts/models.lock.json` và `firmware/models/<nhánh>/meta.json`.
- **Không chốt arm KD hay cấu hình lượng tử hoá nếu chưa có bảng đối chứng.** `reports/ablation_teacher.md` và `reports/quant_ladder.md` phải đầy đủ trước khi ghi ADR.
- So sánh giữa các arm phải cùng seed, cùng `split.lock`, cùng số epoch. Khác một điều kiện là bảng vô nghĩa.
- Quyết định chọn model so bằng **accuracy sau INT8 trên `test_device`**, không phải FP32 trên val.

### 4.3 Backend / Frontend

- Payload MQTT và DTO sinh từ `contracts/schema/`. Không định nghĩa lại.
- Mọi payload từ kiosk đi qua `ValidationPipe`. Không tin dữ liệu thiết bị.
- Chống trùng bằng `unique(deviceId, localId)`, không bằng timestamp.

---

## 5. Commit

Theo **Conventional Commits**, scope là đường dẫn khối:

```
feat(firmware/svc_door): add IDoor with relay and servo adapters
fix(ml/quant): use percentile calibration instead of min-max
docs(plan): rewrite section 6.2 with on-device record formats
```

- Một commit = một mục đích. Không trộn format lại code với sửa logic.
- Commit chứa file sinh tự động phải tách riêng.
- Commit đổi GPIO phải chứa cả `app_config.h` và §2 của KẾ HOẠCH.
- **Body của commit là nơi viết "tại sao sửa"** — viết đủ dài ở đây, đừng viết vào code.
- Ghi mã task vào cuối body khi có: `Task: E4-T6`.

---

## 6. Tuyệt đối cấm

| Cấm | Vì sao |
|---|---|
| Commit secret, `.env`, private key, cert, JWT | Rò ra là phải quay vòng toàn bộ thiết bị |
| Commit weight model, dataset, ảnh khuôn mặt | Nặng, dữ liệu sinh trắc, license research-only |
| Sửa tay file trong `*/generated/`, `managed_components/`, `third_party/*/src/` | Mất khi build lại, mất khả năng update upstream |
| Nhúng `.tflite` thành mảng C | Mất khả năng OTA riêng model |
| `AllOpsResolver` của TFLM | Phình flash vài chục KB |
| Ghi LittleFS theo chu kỳ giây | Giết flash |
| Copy code Espressif vào `components/` rồi sửa | Không update được nữa |
| Tạo file `*_v2`, `*_final`, `summary_*`, `notes_*` | Sửa thẳng file gốc |

---

## 7. Checklist trước khi trả code

- [ ] Đường dẫn file mới có trong KẾ HOẠCH §4
- [ ] `python3 tools/check_comments.py` sạch
- [ ] `python3 tools/check_layers.py` sạch
- [ ] Không comment nào nằm ngoài 4 loại ở §2.5
- [ ] Không comment nào nói về sự thay đổi (§2.4)
- [ ] Mọi symbol public ở header có `@ctx`
- [ ] Tên có đơn vị đo (`_ms`, `_hz`, `_bytes`)
- [ ] Đổi schema → đã chạy lại generator
- [ ] Đổi GPIO → đã sửa cả `app_config.h` và KẾ HOẠCH §2
- [ ] Đổi model → đã cập nhật `contracts/models.lock.json` và `firmware/models/<nhánh>/meta.json`
- [ ] Đổi layout bản ghi → đã tăng `format_ver`, sửa `storage_format.h` và KẾ HOẠCH §6.2
- [ ] Chốt arm KD hoặc cấu hình quantize → có bảng đối chứng đầy đủ + ADR
- [ ] Commit message theo Conventional Commits, phần "tại sao" nằm ở body

---

## 8. Quy tắc cho AI agent

1. **Đọc mục liên quan của KẾ HOẠCH trước khi sửa.** Không suy đoán cấu trúc từ tên file.
2. **Giải thích thay đổi trong trả lời chat và commit message. Tuyệt đối không nhét vào code.** Sửa xong một bug thì trong file chỉ còn lại code đúng, không có dấu vết nào của lần sửa.
3. **Không thêm comment vào code vừa sửa để đánh dấu là đã sửa.**
4. **Được yêu cầu sửa X thì chỉ sửa X.** Không tiện tay thêm comment, đổi format, hay dọn dẹp code xung quanh.
5. **Không tự ý cải tiến cấu trúc.** Thấy chỗ nên đổi thì nêu ra và chờ duyệt.
6. **Không tạo file phụ.** Không `*_v2`, không file tổng hợp, không script rác. Sửa thẳng file đích.
7. **Không viết changelog trong file.** Mỗi file là một bản độc lập, hoàn chỉnh.
8. **Không chắc thì hỏi.** Đoán sai một quy ước rồi nhân ra 20 file tốn hơn nhiều so với hỏi một câu.
9. **Báo cáo tiếng Việt, code và comment tiếng Anh.**
10. **Phân biệt ước lượng với số đo.** Số chưa đo trên board thì đánh dấu 🔬, không trình bày như sự thật.
