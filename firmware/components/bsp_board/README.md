# `bsp_board` — L1

Sở hữu sơ đồ chân và hai bus dùng chung. Mọi driver từ L2 trở lên đọc chân từ đây.

## Làm gì

- `app_config.h` — **nguồn duy nhất** của mọi số hiệu GPIO, tần số bus, địa chỉ
  I²C. Đổi chân phải sửa cả file này và KẾ HOẠCH §2 trong cùng một commit.
- Dựng SPI2 cho panel và I2C0 cho bốn thiết bị dùng chung.
- Giữ mutex `m_i2c` mà bốn thiết bị đó tranh nhau.

## Phụ thuộc

`common` + driver GPIO/I²C/SPI/LEDC của IDF.

## Đo gì

Trên board: PSRAM 8 MB @ 80 MHz, CPU 240 MHz, flash QIO 80 MHz. Bus I²C trả về
`0x20` (PCF8574) và `0x5D` (GT911).

Module PCF8574 **có trở kéo ở SCL nhưng không có ở SDA** — đo bằng cách bật trở
kéo xuống trong chip rồi đọc chân. SDA vì thế cần một con 4,7 kΩ ngoài, và trở
kéo nội để tắt theo §2.3B.

## Giới hạn

Component không có hàm nghiệm thu nào (KẾ HOẠCH §4.5.8). Quét bus và dò trở kéo
nằm ở `test_apps/buses/`; bài dò trở kéo phải chạy **trước** `bsp_board_init` vì
sau đó hai chân thuộc về driver I²C, không đọc như GPIO thường được nữa.
