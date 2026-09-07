# `common` — L0

Kiểu dữ liệu và tiện ích mọi tầng trên đều dùng. Không phụ thuộc component nào.

## Làm gì

- `app_err.h` — `APP_RETURN_ON_ERR`, ghi log rồi trả lỗi ở đường khởi tạo.
- `lock_guard.hpp` — giữ mutex FreeRTOS theo phạm vi, nhả kể cả khi return sớm.
- `queue.hpp` — `Queue<T,N>` bọc `xQueueCreate`, chỉ nhận đúng kiểu đã khai.
- `frame_guard.hpp` — trả `camera_fb_t*` về pool, chống cạn frame pool.

Guard bọc tài nguyên chỉ một component sở hữu thì nằm trong component đó, không
lên đây: `Arena` ở `ai_engine`, mmap phân vùng ở `sys_storage` (KẾ HOẠCH §4.5.5).

## Phụ thuộc

`esp_common`, `log`, `freertos`. Không component tự viết nào.

## Đo gì

`test_apps/` chạy trên board: **4 test, 0 fail**. Phép đáng giá nhất lấp đầy
`Queue<int,4>` rồi gửi phần tử thứ năm — queue phải hết giờ và trả `false` chứ
không chặn task gọi.

## Giới hạn

`frame_guard.hpp` include `esp_camera.h` mà `common` không REQUIRES esp32-camera:
nó chỉ biên dịch được bên trong component có khai phụ thuộc đó. Đây là ngoại lệ
duy nhất với luật "header công khai chỉ POD + `extern "C"`" ở §4.5.3 — các guard
là template C++ thuần header, code C không chạm tới.
