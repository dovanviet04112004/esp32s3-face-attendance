# `common` — L0

Kiểu dữ liệu và tiện ích mọi tầng trên đều dùng. Không phụ thuộc component nào.

## Làm gì

- `app_err.h` — `APP_RETURN_ON_ERR`, ghi log rồi trả lỗi ở đường khởi tạo.
- `lock_guard.hpp` — giữ mutex FreeRTOS theo phạm vi, nhả kể cả khi return sớm.

Khung camera và queue không có guard: chúng chuyển tay giữa các task C của `main`, không
có phạm vi C++ nào để bám (KẾ HOẠCH §4.5.5b).

Guard bọc tài nguyên chỉ một component sở hữu thì nằm trong component đó, không
lên đây: `Arena` ở `ai_engine`, mmap phân vùng ở `sys_storage` (KẾ HOẠCH §4.5.5).

## Phụ thuộc

`esp_common`, `log`, `freertos`. Không component tự viết nào.

## Đo gì

`test_apps/` chạy trên board: hai ca của `LockGuard` — nhả mutex khi ra khỏi phạm vi,
và báo hết giờ thay vì giả vờ đang giữ khi mutex đã bị người khác lấy.

## Giới hạn

Guard là ngoại lệ duy nhất với luật "header công khai chỉ POD + `extern "C"`" ở
KẾ HOẠCH §4.5.3: nó là C++ thuần header, code C không chạm tới.
