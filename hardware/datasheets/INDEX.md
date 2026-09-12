# Datasheet — danh tính của từng bản PDF

PDF trong thư mục này **không vào git** (KẾ HOẠCH §4.1). Bảng dưới giữ danh tính của chúng để
tải lại đúng bản đã dùng: hãng có sửa datasheet mà không đổi URL, nên URL một mình không đủ.

URL là bản chép từ **KẾ HOẠCH §2.6** — sửa thì sửa ở đó trước.

Điền `sha256` bằng:

```bash
sha256sum hardware/datasheets/*.pdf
```

| Tên file | Linh kiện | Nguồn (§2.6) | sha256 |
|---|---|---|---|
| `esp32-s3_datasheet.pdf` | ESP32-S3 (SoC) | espressif.com | — |
| `esp32-s3-wroom-1_datasheet.pdf` | ESP32-S3-WROOM-1 (N16R8) | espressif.com | — |
| `esp32-s3_trm.pdf` | ESP32-S3 Technical Reference Manual | espressif.com | — |
| `ov5640_datasheet.pdf` | OV5640 (camera) | sparkfun.com | — |
| `vl53l1x_datasheet.pdf` | VL53L1X (ToF) | st.com | — |
| `st7796s_datasheet.pdf` | ST7796S (LCD controller) | buydisplay.com | — |
| `gt911_datasheet.pdf` | GT911 (cảm ứng) | crystalfontz.com | — |
| `max98357a_datasheet.pdf` | MAX98357A (I²S DAC/amp) | analog.com | — |
| `pcf8574_datasheet.pdf` | PCF8574 (I/O expander) | ti.com | — |
| `ds3231_datasheet.pdf` | DS3231 (RTC) | analog.com | — |
| `sg90_datasheet.pdf` | SG90 (servo) | ee.ic.ac.uk | — |

**VL53L1X ULD API** (§2.6) là gói phần mềm chứ không phải PDF — nó đã nằm ở
`firmware/third_party/`, nguồn ghi trong `UPSTREAM.md` của chính nó.

**Board ESP32-S3-CAM (GOOUUU)** (§2.6) là trang web chứ không phải PDF, và nội dung cần dùng
— thứ tự chân hai hàng — **đã chép vào KẾ HOẠCH §2** rồi. Không tải gì về; §2 là bản giữ.
