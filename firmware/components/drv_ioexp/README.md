# `drv_ioexp` — L2

PCF8574 ở `0x20`, tám đường điều khiển chậm cho bốn thiết bị khác nhau.

## Làm gì

Đặt từng chân P0–P7 qua một **thanh ghi bóng**. Chip nhận cả tám đường trong một
byte và không đọc-sửa-ghi được, nên đổi P0 vẫn phải ghi kèm P1–P7.

| Chân | Giao cho |
|---|---|
| P0 | GT911 RST |
| P1 | VL53L1X XSHUT |
| P2 | Relay IN1 |
| P3 | MAX98357A SD |

## Phụ thuộc

`common`, `bsp_board`, `esp_driver_i2c`.

## Đo gì

Ghi được vào chip thật ở `0x20`, bóng khởi tạo `0xFF`.

## Giới hạn

Bóng khởi tạo ở `0xFF` vì mọi chân P tự lên cao qua nguồn dòng ~100 µA lúc cấp
điện (§2.3G). Chỉ giao cho P những việc mà mức cao lúc khởi động là vô hại.
Chip **sink 25 mA nhưng chỉ source ~100 µA**, nên tải phải đi theo chiều sink.
