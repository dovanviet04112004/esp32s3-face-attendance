# `drv_camera` — L2

OV5640 trên bus DVP, khung hình nằm ở PSRAM.

## Làm gì

Dựng sensor và giữ phơi sáng ổn định theo vùng giữa khung.

## Cấu hình chốt

Đây là **bảng tra duy nhất** cho cấu hình cam; đổi số nào thì sửa cả đây và KẾ HOẠCH §2.1
trong cùng một commit.

| Tham số | Giá trị | Ghi chú |
|---|---|---|
| `frame_size` | `FRAMESIZE_HVGA` 480×320 | mặt 122 px ở cự ly kiosk |
| `pixel_format` | `PIXFORMAT_RGB565` | ảnh chỉ nén một lần, ở khâu crop |
| `xclk_freq_hz` | 27 MHz | 14,19 fps |
| `fb_count` / `fb_location` | 4 / PSRAM | preview giữ một khung lúc vẽ, `ai_task` giữ một khung tới 2 s (KẾ HOẠCH §6.3) |
| `grab_mode` | `CAMERA_GRAB_LATEST` | ưu tiên khung mới, chấp nhận rơi khung |
| `ledc_timer` / `ledc_channel` | 2 / 2 | trên S3, khối LCD_CAM phát XCLK nên esp32-camera không đọc hai trường này; vẫn đặt cặp không ai giữ, vì timer 0 / channel 0 là đèn nền và timer 1 / channel 1 là servo |
| `set_vflip` / `set_hmirror` | 1 / 1 | module gắn lens trên đầu nối; gương cho kiosk |
| AE / AGC của sensor | **tắt cả hai** | thay bằng vòng đo vùng giữa ở `drv_camera_expose` |
| Gain | bắt đầu 1×, vòng đo chỉnh trong 1×–4× | gain cao đẻ nhiễu hạt, anti-spoof đọc nhầm thành kết cấu da |
| Mục tiêu sáng | kênh lục 30 / 63 | lấy mẫu thưa 1/4 giữa khung, bước 8 px |
| Giảm chấn | 1/4 quãng, nghỉ 2 khung | sensor trễ 1–2 khung; không giảm chấn là nhấp nháy |
| Lọc vằn 50 Hz | `0x3C01`\|=0x80, `0x3C00`\|=0x04 | ghi xong đọc ngược lại; chỉ ràng buộc AEC của sensor, mà AEC đang tắt |
| Chống nhấp nháy | phơi sáng theo số nguyên nửa chu kỳ điện (10 ms), gain bù phần lẻ | `drv_camera_expose` đo chu kỳ khung lúc khởi động để ra độ dài một dòng (E7-T11b) |

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
- XCLK do khối LCD_CAM của S3 phát, không qua LEDC; cặp LEDC trong cấu hình chỉ để không đè lên
  đèn nền (0 / 0) hay servo (1 / 1) nếu có ngày esp32-camera đọc nó.
- `PSRAM DMA mode disabled` — mỗi khung còn bị chép thêm một lần.
- Đẩy khung JPEG về máy mang tag `[manual]` ở `test_apps/sensor/`, cùng chỗ với
  bài chốt sàn 12 fps của E7-T11 (KẾ HOẠCH §4.5.8).
