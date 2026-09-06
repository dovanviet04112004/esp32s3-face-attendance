# `drv_camera` — L2

OV5640 trên bus DVP, khung hình nằm ở PSRAM.

## Làm gì

Dựng sensor ở 480×320 RGB565, hai frame buffer trong PSRAM, `CAMERA_GRAB_LATEST`.
`drv_camera_dump()` đẩy một khung về máy chủ dạng JPEG hex để soi ngoài board.

## Phụ thuộc

`common`, `bsp_board`, `espressif__esp32-camera`.

## Đo gì

Sensor PID `0x5640`. Tốc độ khung phụ thuộc **cả cỡ khung lẫn XCLK**, và không
đơn điệu theo lượng dữ liệu:

| Cỡ khung | Byte/khung | fps @20 MHz |
|---|---|---|
| QQVGA 160×120 | 38.400 | 19,73 |
| QVGA 320×240 | 153.600 | 7,89 |
| **HVGA 480×320** | 307.200 | **8,87** |
| VGA 640×480 | 614.400 | 4,93 |

HVGA **nhanh hơn QVGA dù dữ liệu gấp đôi** — nút thắt là cấu hình PLL từng chế
độ của OV5640, không phải băng thông.

XCLK ở HVGA: 16 MHz → 7,09 · 20 MHz → 8,87 · 24 MHz → 11,82 · **27 MHz → 14,19**.

Mặt người ở khoảng cách kiosk: **122 px** trong khung 480×320. Quy ra crop:
tight 80×80 thu nhỏ 1,52×, recog 112×112 thu nhỏ 1,09×, và chỗ cho context tối
đa chỉ **2,63×** — dưới mức 2,7× mà §3 đặt ra.

## Giới hạn

- **Đổi `framesize` lúc chạy làm hỏng capture** (`Failed to get frame: timeout`).
  DMA cấu hình theo cỡ ban đầu, nên mỗi cỡ cần một lần dựng lại.
- Không dùng được QQVGA: mặt còn 60 px, crop recog 112×112 phải **phóng to gấp
  đôi**, tức bịa ra một nửa số pixel.
- Sensor lấy LEDC timer 1 / channel 1 vì đèn nền LCD giữ timer 0 / channel 0.
- `PSRAM DMA mode disabled` — mỗi khung còn bị chép thêm một lần.
