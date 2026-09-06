# Arena TFLM — số đo trên board

Bảng của KẾ HOẠCH §3.10 và §6.4. Cột nào chưa đo được thì để 🔬, không điền số
suy ra.

## 1. Chỗ `arena_fast` nằm được

Đo trên `face_attendance` build `dev`, ESP32-S3 8 MB PSRAM octal, firmware ở
commit của E8-T1. Lúc này mới có `sys_storage` + `drv_lcd` + `drv_touch` +
`drv_camera` chạy; **chưa có Wi-Fi, chưa có LVGL**, nên các số dưới là mức
rộng rãi nhất mà `arena_fast` còn được hưởng.

| Xin arena ở đâu trong `app_main` | RAM nội trống | Khối liền lớn nhất | 175 KB vừa? |
|---|---|---|---|
| Sau `drv_camera_init()` | 192 KB | **143 KB** | ❌ lùi xuống PSRAM |
| Ngay sau `sys_storage_init()` | 293 KB | ≥ 175 KB | ✅ nằm SRAM nội |

**Ràng buộc là tính liền mạch, không phải tổng.** Ở dòng đầu vẫn còn 192 KB
trống — thừa so với 175 KB — nhưng `heap_caps_aligned_alloc` cần **một dải
liền**, mà lúc đó bounce buffer của LCD và mô tả DMA của camera đã cắt heap
thành nhiều mảnh, mảnh to nhất chỉ 143 KB. Cả hệ chỉ có đúng một chỗ xin một
dải lớn như vậy là arena, nên nó phải xin **trước** mọi driver.

Sau khi arena lấy 175 KB, RAM nội còn 118 KB và `drv_lcd`, `drv_touch`,
`drv_camera` vẫn init đủ, preview giữ nguyên 14,19 fps.

## 2. `tail` và `head` — E8-T7

| Model | tail | head | tổng |
|---|---|---|---|
| detect | 🔬 chưa có model | 🔬 | 🔬 |
| **spoof** | **111.916 B (109,3 KB)** | **234.624 B (229,1 KB)** | **346.540 B (338,4 KB)** |
| recog | 🔬 chưa có model | 🔬 | 🔬 |

`head` đọc trực tiếp từ lời từ chối của bộ cấp phát khi arena 175 KB không đủ
(`Requested: 234624, available 67488`); tổng đọc từ `arena_used_bytes()` khi
arena đã đủ rộng; `tail` là hiệu của hai số đó.

**Một mình nhánh anti-spoof đã cần 338 KB.** §6.4 dự trù 175 KB cho **cả**
detect lẫn spoof dùng chung, tức là hụt gần một nửa trước khi nhánh detect kịp
xuất hiện. Chip chỉ có ~232 KB liền mạch ở SRAM nội lúc `ai_engine_init()`
chạy, nên arena này **không có cách nào nằm ở SRAM nội** với model hiện tại;
nó đang chạy ở PSRAM, và cái giá của việc đó nằm ở `latency.md`.

`AI_ARENA_FAST_KB = 175` mặc định vì thế vẫn là ước lượng của §6.4 chứ không
phải số đo, và nó **sai**. Chưa sửa mặc định vì con số đúng phụ thuộc vào việc
model có được thu nhỏ hay không — xem mục 3 của `latency.md`.

## 3. Cảnh báo cho các mốc sau

Wi-Fi + lwIP lấy thêm ~55 KB SRAM nội (§6.4) và LVGL còn chưa lên. 118 KB
còn lại sau arena sẽ mỏng đi, nên phải đo lại mục 1 ở E8-T9 khi đã đủ thành
phần, chứ không được coi bảng này là số cuối.
