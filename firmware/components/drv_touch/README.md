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

| Góc | Vòng 1 | Vòng 2 |
|---|---|---|
| Trên-trái | 16,15 | 38,15 |
| Trên-phải | 479,15 | 477,23 |
| Dưới-phải | 473,318 | 475,314 |
| Dưới-trái | 0,309 | 13,307 |

## Giới hạn

`x_max`/`y_max` phải khai theo hệ **dọc gốc của panel (320×480)**, không phải hệ
ngang 480×320 đang hiển thị — khai nhầm thì `y` trả về tới 426 trong khi biên
báo là 320.
