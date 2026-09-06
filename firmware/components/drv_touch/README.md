# `drv_touch` — L3

Cảm ứng điện dung GT911 trên bus I²C dùng chung.

## Làm gì

Chạy trình tự chọn địa chỉ rồi mở controller, trả về toạ độ chạm theo pixel panel.

Địa chỉ GT911 **bất định sau khi cấp nguồn**: chip chốt địa chỉ theo mức chân INT
đúng lúc RST được nhả, mà expander tự nhả RST trước khi firmware chạy. Chỉ lần
reset chủ động trong `drv_touch_init` mới quyết được nó (§2.3C).

## Phụ thuộc

`common`, `bsp_board`, `drv_ioexp` (chân RST nằm ở P0), `esp_lcd`,
`espressif__esp_lcd_touch_gt911`.

## Đo gì

Trả lời ở `0x5D`. Chạm bốn góc, hai vòng:

| Góc | Toạ độ mong đợi | Đo lượt 1 | Đo lượt 2 |
|---|---|---|---|
| Trên-trái | 0,0 | 17,0 | 23,0 |
| Trên-phải | 319,0 | 304,16 | 297,7 |
| Dưới-phải | 319,479 | 307,453 | 308,450 |
| Dưới-trái | 0,479 | 19,448 | 20,458 |

Lệch 15–25 px ở mép là tầm với của đầu ngón tay, không phải sai hệ toạ độ: `x` tăng
sang phải 0→319 và `y` tăng xuống 0→479, trùng khít hệ của panel.

## Giới hạn

Bộ điều khiển báo toạ độ trong hệ **dọc gốc của panel (320×480)**, và màn cũng
dựng đứng theo hệ đó, nên `swap_xy`/`mirror` đều tắt — khai nhầm thì `y` trả về
tới 426 trong khi biên báo là 320.
