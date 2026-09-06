# `drv_lcd` — L2

Panel ST7796S 480×320 trên SPI2, kèm đèn nền PWM.

## Làm gì

Dựng panel qua `esp_lcd_st7796` của registry, đẩy pixel RGB565, chỉnh độ sáng
đèn nền bằng LEDC. `drv_lcd_selftest()` đi bốn màu để nghiệm thu đường SPI.

## Phụ thuộc

`common`, `bsp_board`, `esp_lcd`, `esp_driver_ledc`, `espressif__esp_lcd_st7796`.

## Đo gì

Board KMRTM40045-SPI+CTP 4,0″ lên hình ở 480×320, SPI 40 MHz. Panel sẵn sàng
sau **617 ms** kể từ lúc cấp điện (CPU 240 MHz).

## Giới hạn

- `drv_lcd_fill` cấp bộ đệm một dòng bằng `MALLOC_CAP_DMA`: đường SPI này **không
  với tới PSRAM**, dòng lấy từ heap sai sẽ hỏng lúc truyền chứ không phải lúc cấp.
- Đèn nền dùng LEDC timer 0 / channel 0. Camera phải lấy cặp khác.
- Chưa có bounce buffer và chưa nối LVGL (E7-T5 còn nợ).
- `drv_lcd_selftest()` tốn ~2,8 giây mỗi lần khởi động, nên nằm sau
  `CONFIG_DRV_LCD_SELFTEST` và không có ở bản `bench`/`prod`.
