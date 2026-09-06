# `drv_lcd` — L2

Panel ST7796S 320×480 dựng đứng trên SPI2, kèm đèn nền PWM.

## Làm gì

Dựng panel qua `esp_lcd_st7796` của registry, đẩy pixel RGB565, chỉnh độ sáng
đèn nền bằng LEDC.

## Phụ thuộc

`common`, `bsp_board`, `esp_lcd`, `esp_driver_ledc`, `espressif__esp_lcd_st7796`.

## Đo gì

Board KMRTM40045-SPI+CTP 4,0″ lên hình ở 320×480 dọc, SPI **80 MHz**. Panel sẵn
sàng sau **617 ms** kể từ lúc cấp điện (CPU 240 MHz).

Hướng và màu **đo bằng ba ô mốc tự vẽ trên board**, không suy từ ảnh camera — ảnh
camera có bốn ẩn số chồng nhau nên không cô lập được cái nào:

| Tham số | Giá trị đo được |
|---|---|
| Gốc toạ độ | trên-trái, `x`→phải, `y`→xuống |
| `swap_xy` | false |
| `mirror` | **(true, false)** — cột của panel đấu ngược |
| `invert_color` | **false** — module này trả ảnh âm khi nhận INVON |
| `rgb_ele_order` | **BGR** |

Preview camera đầy màn: **14,186 fps**, bằng đúng tốc độ sensor tự chạy, tức
đường LCD gần như không tốn thêm gì.

## Giới hạn

- SPI DMA **không với tới PSRAM**: mọi pixel đi qua hai bounce buffer 30.720 B ở
  RAM nội, cấp một lần lúc boot. Khung camera nằm ở PSRAM nên luôn phải qua đó.
- `esp_lcd_panel_io_tx_color` xếp hàng chứ chưa gửi xong khi trả về, nên buffer
  chỉ được ghi lại sau `on_color_trans_done` — ghi sớm là ra vạch kẻ trên màn.
- Màu do host dựng phải đảo byte; khung camera thì không, vì DVP đã ghi đúng thứ
  tự dây. Hai nguồn khác nhau, không dùng chung một nhánh.
- Đèn nền dùng LEDC timer 0 / channel 0. Camera phải lấy cặp khác.
- Chưa nối LVGL (E7-T5 còn nợ).
- Bài đi bốn màu cần mắt người nên mang tag `[manual]` ở `test_apps/panel/`, vòng
  tự động bỏ qua (KẾ HOẠCH §4.5.8).
