# `common` — L0

Kiểu dữ liệu và tiện ích mọi tầng trên đều dùng. Không phụ thuộc component nào.

## Làm gì

- `app_err.h` — `APP_RETURN_ON_ERR`, ghi log rồi trả lỗi ở đường khởi tạo.
- `lock_guard.hpp` — giữ mutex FreeRTOS theo phạm vi, nhả kể cả khi return sớm.
- `queue.hpp` — `Queue<T,N>` bọc `xQueueCreate`, chỉ nhận đúng kiểu đã khai.
- `mmap_region.hpp` — map phân vùng flash theo phạm vi, `munmap` khi ra khỏi.
- `frame_guard.hpp` — trả `camera_fb_t*` về pool, chống cạn frame pool.

## Phụ thuộc

`esp_common`, `log`, `freertos`, `esp_partition`. Không component tự viết nào.

## Đo gì

`test_apps/` chạy trên board: **6 test, 0 fail**. Phép đáng giá nhất map cùng
một cửa sổ 64 KB **32 lần liên tiếp** — guard quên `munmap` thì cạn handle và
test sập.

## Giới hạn

`frame_guard.hpp` include `esp_camera.h` mà `common` không REQUIRES esp32-camera:
nó chỉ biên dịch được bên trong component có khai phụ thuộc đó. Đây là ngoại lệ
duy nhất với luật "header công khai chỉ POD + `extern "C"`" ở §4.5.3 — các guard
là template C++ thuần header, code C không chạm tới.
