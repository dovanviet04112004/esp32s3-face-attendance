# esp32s3-face-attendance

Máy chấm công nhận diện khuôn mặt chạy hoàn toàn trên ESP32-S3, kèm backend quản lý và
dashboard web. Đồ án tốt nghiệp.

Ba model chạy trên thiết bị: phát hiện mặt (YuNet) → chống giả mạo (MiniFASNetV2-SE) →
nhận diện (MobileFaceNet). Cả ba train trực tiếp trên nhãn thật, lượng tử hoá INT8, nạp
vào flash qua partition riêng để OTA được độc lập với firmware.

## Tài liệu

| File | Nội dung |
|---|---|
| [docs/KE_HOACH_face_attendance_esp32s3.md](docs/KE_HOACH_face_attendance_esp32s3.md) | Kiến trúc — nguồn sự thật duy nhất |
| [docs/TASKS.md](docs/TASKS.md) | Backlog 14 epic |
| `CLAUDE.md` | Quy tắc bắt buộc cho mọi thay đổi — chỉ có ở bản local, không commit |
| `docs/adr/` | Quyết định kiến trúc, mỗi quyết định một file |
| `docs/measurements/` | Số đo trên board thật |

Đọc `CLAUDE.md` trước khi sửa dòng code đầu tiên.

## Bố cục

```
contracts/   Hợp đồng dùng chung — JSON Schema, vector vàng, models.lock.json
ml/          Python — train, lượng tử hoá, export
firmware/    ESP-IDF — C + C++
backend/     NestJS + Prisma + PostgreSQL
frontend/    Next.js trên Vercel
deploy/      Docker Compose + traefik + mosquitto
tools/       Script ngang khối
docs/        Kế hoạch, backlog, ADR, số đo, báo cáo
```

Chi tiết từng thư mục ở KẾ HOẠCH §4.

## Phần cứng

ESP32-S3-WROOM-1 N16R8 (16 MB flash, 8 MB octal PSRAM) · camera OV5640 · LCD ST7796S
3.5" cảm ứng GT911 · ToF VL53L1X · loa qua MAX98357A · relay hoặc servo mở cửa, điều
khiển qua PCF8574. Bảng đấu nối từng chân ở KẾ HOẠCH §2.

> Chân GPIO chỉ khai ở hai chỗ: `firmware/main/app_config.h` và KẾ HOẠCH §2. Đổi chân
> phải sửa cả hai trong cùng một commit.

## Lệnh hay dùng

```bash
make help          # liệt kê toàn bộ target
make gen           # sinh DTO TypeScript + gen_payload.h từ contracts/schema
make lint          # check_comments + check_layers + ruff + eslint
make train-det     # train nhánh detection
make fw-dev        # build firmware profile dev
make flash         # nạp và mở monitor
make up            # dựng hạ tầng docker
```

## Trạng thái

Đang ở E1 — dựng nền repo. Chưa có số đo nào trên board thật; mọi con số trong KẾ HOẠCH
đánh dấu 🔬 vẫn là ước lượng cho tới khi chạy E8.

## License

Code trong repo này: xem [LICENSE](LICENSE). Model weight và dataset **không** nằm trong
repo và phần lớn là research-only — ràng buộc license từng mắt xích ghi ở KẾ HOẠCH §1.4.
