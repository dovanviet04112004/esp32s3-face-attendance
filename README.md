# esp32s3-face-attendance

[![firmware](https://github.com/dovanviet04112004/esp32s3-face-attendance/actions/workflows/firmware.yml/badge.svg?branch=main)](https://github.com/dovanviet04112004/esp32s3-face-attendance/actions/workflows/firmware.yml)
[![deploy](https://github.com/dovanviet04112004/esp32s3-face-attendance/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/dovanviet04112004/esp32s3-face-attendance/actions/workflows/deploy.yml)
[![frontend](https://github.com/dovanviet04112004/esp32s3-face-attendance/actions/workflows/frontend.yml/badge.svg?branch=main)](https://github.com/dovanviet04112004/esp32s3-face-attendance/actions/workflows/frontend.yml)
[![ml](https://github.com/dovanviet04112004/esp32s3-face-attendance/actions/workflows/ml.yml/badge.svg?branch=main)](https://github.com/dovanviet04112004/esp32s3-face-attendance/actions/workflows/ml.yml)
[![contracts](https://github.com/dovanviet04112004/esp32s3-face-attendance/actions/workflows/contracts.yml/badge.svg?branch=main)](https://github.com/dovanviet04112004/esp32s3-face-attendance/actions/workflows/contracts.yml)

Máy chấm công nhận diện khuôn mặt chạy trọn trên một vi điều khiển ESP32-S3, và **Nhân Lực** —
hệ quản trị nhân sự nhận lượt chấm từ máy. Phát hiện mặt, chống giả mạo và nhận diện đều suy luận
ngay trên chip, ảnh không rời kiosk. Lượt chấm đi qua MQTT/TLS lên server, thành ngày công rồi
thành bảng lương. Người lao động xem công, xin nghỉ và nhận phiếu lương trên điện thoại.

Đồ án tốt nghiệp. Kiến trúc đầy đủ nằm ở [KẾ HOẠCH](docs/KE_HOACH_face_attendance_esp32s3.md);
README này là cửa vào.

## Một lượt chấm công

```
VL53L1X ─► OV5640 ─► YuNet ─► MiniFASNetV1SE ─► MobileFaceNet-ECA ─► so cosine với mẫu trên máy
có người   160×120   mặt +    thật hay giả?     vector 512-D               │
                     5 điểm                                                ▼
                                màn · loa · servo thanh chắn ◄── máy trạng thái chấm công
                                                                           │
 ┌─── ghi flash trước, gửi qua MQTT/TLS 8883 khi có mạng ──────────────────┘
 ▼
EMQX ─► NestJS API ─► PostgreSQL ─► ngày công ─► lương
        └─► dashboard Next.js và app Android, cập nhật tức thì
```

- **Mất mạng không mất công.** Kiosk ghi lượt chấm vào LittleFS trước, gửi khi có mạng. Mỗi lượt
  mang `local_id` duy nhất theo máy, server chống trùng bằng `unique(deviceId, localId)`: gửi lại
  bao nhiêu lần cũng chỉ thành một bản ghi.
- **Server giữ danh tính, máy giữ khuôn mặt** (KẾ HOẠCH §7.5). HR tạo nhân viên trên dashboard,
  khuôn mặt được chụp và ghi danh tại kiosk. Vector đặc trưng lưu trên server được mã hoá và không
  API đọc nào trả ra.
- **Kiosk tự đăng ký, server duyệt.** Máy xin vé qua HTTPS, nối broker bằng vé ấy, nhận bản cập
  nhật firmware và model qua OTA (KẾ HOẠCH §7.3, §7.7).

## Trạng thái — 10/10/2026

Chạy production từ 24/09/2026:

- Dashboard ở [app.cckiosk.io.vn](https://app.cckiosk.io.vn). Bản Android tải ở trang
  [Releases](https://github.com/dovanviet04112004/esp32s3-face-attendance/releases).
- API, broker và cơ sở dữ liệu chạy bằng Docker trên một VPS.
- Firmware 0.9.9 là bản phát hành mới nhất. Ba model chạy bằng ESP-DL trên board thật.

Số đo trên board, model INT8, median 50 lượt khi máy rảnh, đo 23/09
([`latency.md`](docs/measurements/latency.md) §13):

| | Phát hiện | Chống giả | Nhận diện | Cả ba nối nhau |
|---|---:|---:|---:|---:|
| ESP-DL, bộ đang chạy | 64 ms | 85 ms | 302 ms | **452 ms** |
| TFLite Micro + esp-nn, bộ đối chứng | 232 ms | 580 ms | 459 ms | 1.271 ms |

Cùng một bộ model thì ESP-DL nhanh hơn TFLite Micro 5,4 lần. Camera xem trước đạt 13,9 fps
([`ram.md`](docs/measurements/ram.md)), sát trần 14,2 fps của OV5640 ở XCLK 27 MHz (KẾ HOẠCH §2.1).

Độ chính xác của đúng các file đang chạy, chấm trên host bằng mô phỏng ESP-PPQ. Mô phỏng này khớp
`model->test()` trên chip:

| Nhánh | Kết quả |
|---|---|
| Phát hiện | AP 0,9497 với mặt từ 38 px, WIDER FACE val |
| Chống giả | 87 khung do chính OV5640 chụp: giữ 61/62 mặt thật, chặn 25/25 khung giả, ngưỡng 500‰ |
| Nhận diện | LFW 0,9958 · CFP-FP 0,9440 · AgeDB-30 0,9565 |

Còn mở, chi tiết ở [TASKS.md](docs/TASKS.md):

- Thời gian trọn một lượt chấm, từ lúc đứng vào tới lúc có kết quả 🔬.
- FAR/FRR trên ảnh OV5640 của nhiều người (E8-T12).
- Đáy RAM nội qua 10 phút chạy có Wi-Fi và MQTT/TLS, cần giữ từ 24 KB trở lên 🔬.
- Một lượt ba model 452 ms, còn trên ngân sách 360 ms.
- Secure Boot và mã hoá flash chưa bật (E13-T3).
- Báo cáo ĐATN (E14): các chương chưa viết, `docs/thesis/` mới có ghi chép thực nghiệm.

## Phần cứng

| Linh kiện | Vai trò |
|---|---|
| ESP32-S3-CAM (ESP32-S3-WROOM-1 N16R8: 16 MB flash, 8 MB PSRAM octal) | xử lý, chạy cả ba model |
| OV5640 | camera DVP, khung HVGA RGB565 |
| LCD ST7796S 4,0" 320×480, cảm ứng GT911 | màn chấm công, ghi danh khuôn mặt, cài đặt |
| VL53L1X | đo khoảng cách: có người tới gần thì kiosk thức |
| MAX98357A, loa 4 Ω 3 W | âm báo |
| SG90 | servo gạt thanh chắn |
| PCF8574 | mở rộng chân: reset cảm ứng, XSHUT của VL53L1X, tắt ampli |
| DS3231 | giữ giờ khi mất mạng |

Chân GPIO khai ở đúng hai chỗ: KẾ HOẠCH §2 và
[`app_config.h`](firmware/components/bsp_board/include/app_config.h). Đổi chân thì sửa cả hai
trong cùng một commit. Sơ đồ nguyên lý và PCB (KiCad 10) sinh từ script, xem
[hardware/README.md](hardware/README.md).

## Model

| Nhánh | Kiến trúc | Đầu vào | File `.espdl` |
|---|---|---|---:|
| Phát hiện | YuNet (`yunet_n`): box và 5 điểm mốc để căn mặt | 160×120 | 224 KB |
| Chống giả | MiniFASNetV1SE, đọc vùng quanh mặt rộng 2,7 lần | 80×80 | 551 KB |
| Nhận diện | MobileFaceNet-ECA, ra vector 512-D | 112×112 | 1.386 KB |

- Lượng tử INT8 bằng ESP-PPQ, chạy bằng ESP-DL 3.3.11, trọng số chép sang PSRAM. TFLite Micro
  với esp-nn vẫn dựng được (`AI_RUNTIME_TFLM` trong Kconfig) để làm đối chứng.
- Model nằm ở partition riêng: hai slot `models_0` và `models_1`, mỗi slot 2,25 MB. Nhờ vậy model
  cập nhật qua OTA độc lập với firmware.
- [`contracts/models.lock.json`](contracts/models.lock.json) ghi bộ đang deploy: file, sha256, run.
  Script nạp model kiểm sha256 theo lock này trước khi ghi lên board.

## Bố cục repo

| Thư mục | Nội dung |
|---|---|
| [`contracts/`](contracts/README.md) | Nguồn sự thật chung: JSON Schema của payload MQTT, danh sách topic, model đang deploy, vector vàng. `make gen` sinh DTO TypeScript và header C từ đây |
| `ml/` | Python 3.12, gói `facepipe`, quản lý bằng uv: dữ liệu, huấn luyện, lượng tử hoá, xuất và khoá model |
| `firmware/` | ESP-IDF 6.0.2, C và C++. Component chia tầng `bsp_` `drv_` `sys_` `ai_` `net_` `svc_` `ui_`, 28 test app chạy trên board |
| `hardware/` | Sơ đồ nguyên lý và PCB KiCad, sinh từ `hardware/gen/` |
| `backend/` | NestJS 12, Prisma 7, PostgreSQL 16, Redis và BullMQ, MQTT tới EMQX |
| `frontend/` | Next.js 16, React 19, Kumo; tiếng Việt và tiếng Anh; cài được như PWA |
| `android/` | Vỏ Trusted Web Activity đưa dashboard thành app Android |
| `deploy/` | Docker Compose cho máy dev và VPS, Traefik, cấu hình EMQX, sao lưu, `deploy.sh` |
| `tools/` | Sinh code và kiểm tra dùng chung: `gen_contracts`, `check_comments`, `check_layers`, `check_migrations`, `check_error_codes`, `check_schematic`, `check_pcb`… |
| `docs/` | Kế hoạch, backlog, ADR, số đo |

Ba khối `ml`, `firmware` và `backend`/`frontend` không chép định nghĩa của nhau. Payload, model
đang deploy và vector kiểm thử đều nằm ở `contracts/`, mỗi khối sinh code từ đó.

## Bắt đầu

Cần: Linux hoặc WSL2, Docker có `docker compose`, Node.js 24, Python 3.12 với
[uv](https://docs.astral.sh/uv/), và ESP-IDF v6.0.2 nếu dựng firmware. Mọi lệnh đi qua `Makefile`
ở gốc; `make help` liệt kê theo nhóm.

### Backend và dashboard

```bash
make be-install fe-install
cp deploy/.env.example deploy/.env          # điền mật khẩu
cp backend/.env.example backend/.env        # khớp mật khẩu với deploy/.env, đặt SEED_ADMIN_PASSWORD
cp frontend/.env.example frontend/.env.local
deploy/emqx/gen_certs.sh 127.0.0.1          # CA và chứng thư MQTTS; certs/ không vào git
make up                                     # EMQX, PostgreSQL, Redis, MinIO
make be-prisma be-migrate be-seed
make be-dev                                 # API ở http://localhost:3000, tài liệu API ở /docs
make fe-dev                                 # dashboard ở http://localhost:3001
```

- API nối broker bằng tài khoản dịch vụ `svc-ops`. Tạo tài khoản ấy một lần trong bảng
  `built_in_database` của EMQX, qua dashboard ở http://127.0.0.1:18083, mật khẩu là
  `EMQX_OPS_PASSWORD` (KẾ HOẠCH §7.4).
- Seed tạo `admin@kiosk.local` và một tài khoản cho mỗi vai: `hr`, `payroll`, `manager`,
  `employee`, `viewer` (`@kiosk.local`). Mọi tài khoản dùng chung mật khẩu `SEED_ADMIN_PASSWORD`.
- `make be-demo` **xoá sạch** cơ sở dữ liệu rồi nạp một công ty mẫu 5.000 người.
- `make fe-dev` chạy sau `make be-dev`, nên Next nhường cổng 3000 cho API và lấy cổng 3001.

### Firmware

```bash
. $IDF_PATH/export.sh
make fw-dev                         # profile dev: -Og, assert, console
make flash PORT=/dev/ttyACM0        # nạp rồi mở monitor
make fw-log PORT=/dev/ttyACM0       # in log của board trong 30 s
```

| Profile | Dùng cho |
|---|---|
| `dev` | gỡ lỗi: `-Og`, assert, heap poisoning, console |
| `bench` | đo: `-O2`, thống kê thời gian chạy |
| `prod` | máy thật: `-O2`, log mức WARN, không console, MQTT bắt buộc TLS |
| `fleet` | bản phát hành CI dựng từ `prod`: panic hay watchdog thì khởi động lại để rollback được |

- `prod` và `fleet` đọc thêm `firmware/sdkconfig.secrets`, file không vào git, giữ token để kiosk
  xin vé lần đầu.
- Board cắm vào Windows thì gắn sang WSL: `make usb-list`, rồi `make usb-attach BUSID=<id>`.
- Test app trên board: `make fw-app APP=<đường dẫn>`, rồi `make fw-app-flash APP=<đường dẫn>`.

### Model

Trọng số và dataset không nằm trong repo. Đường đi của một model:

```bash
make ml-sync                     # venv của ml/; máy không có GPU thì thêm TORCH=cpu
make data-fetch data-interim data-splits
make train-det ARGS="<config>"   # tương tự train-spoof, train-recog
make quantize RUN=artifacts/<nhánh>/runs/<run>
make export BRANCH=<nhánh> MODEL=<file .espdl> RUN_ID=<nhánh>/<run> ARENA_BYTES=0
make pack PORT=/dev/ttyACM0      # đóng models.bin, kiểm sha256 theo lock, ghi cả hai slot
```

`make export` chép file vào `firmware/models/<nhánh>/` và cập nhật lock trong cùng một bước.

## Kiểm tra

```bash
make lint         # mọi kiểm tra tĩnh CI chạy: tools/ và ruff
make typecheck    # tsc của backend và frontend
make check        # sinh lại từ contracts/, fail nếu file đã commit bị lệch
make ml-test      # pytest của ml/
make be-e2e       # e2e backend như CI: Postgres, Redis, EMQX dựng riêng (SPECS= để chọn suite)
```

| Workflow | Chạy khi | Làm gì |
|---|---|---|
| `contracts` | mọi push | kiểm schema, file sinh không lệch, header biên dịch được, các `tools/check_*` |
| `ml` | đổi `ml/`, `contracts/` | ruff, pytest |
| `firmware` | đổi `firmware/`, `contracts/`, `tools/` | dựng bằng ESP-IDF 6.0.2; trên `main`, phiên bản mới thì dựng bản `fleet` và đăng lên API |
| `backend` | push ngoài `main` hay pull request đổi `backend/`, `contracts/`; `deploy` gọi lại nó | Postgres, Redis, EMQX thật: migrate, seed, typecheck, e2e, build |
| `frontend` | đổi `frontend/`, `contracts/` | typegen, tsc, build |
| `deploy` | `main` đổi `backend/`, `contracts/`, `deploy/` | test backend, đẩy image lên GHCR, SSH vào VPS chạy `deploy.sh` |

## Triển khai

Push lên `main` là deploy.

- **API.** `deploy.yml` đẩy image `ghcr.io/dovanviet04112004/cckiosk-api:<sha>`, rồi `deploy.sh`
  trên VPS kéo image, chờ `/health`. API không khoẻ trong 120 s thì tự lùi về bản trước.
- **Dashboard.** Vercel dựng `frontend/` mỗi lần push.
- **Firmware.** Tăng `PROJECT_VER` trong `firmware/CMakeLists.txt`. CI dựng bản `fleet` rồi đăng
  lên API. ADMIN mời từng máy cập nhật từ dashboard. Kiosk tải qua một link có chữ ký và hạn dùng,
  ghi vào slot đang nghỉ, và lùi bản nếu bản mới không khởi động được.
- **App Android.** `android/build.sh` dựng APK từ `twa-manifest.json`; khoá ký không nằm trong repo.
- **Sao lưu.** Mỗi đêm có bản dump, WAL thì đẩy liên tục. Tất cả được nén, mã hoá bằng age rồi
  chép ra Cloudflare R2. Sao lưu quá hạn thì API gửi thư cho ADMIN.

Lần dựng đầu trên VPS không nằm trong CD: tài khoản SSH, `.env`, chứng thư broker, tài khoản dịch
vụ EMQX và tài khoản quản trị đầu tiên đều tạo tay (KẾ HOẠCH §4.8).

## Tài liệu

| File | Nội dung |
|---|---|
| [docs/KE_HOACH_face_attendance_esp32s3.md](docs/KE_HOACH_face_attendance_esp32s3.md) | Kiến trúc, nguồn sự thật: model, phần cứng, repo, task FreeRTOS, bộ nhớ, server, hệ nhân sự |
| [docs/TASKS.md](docs/TASKS.md) | Backlog 27 epic, mã task `E<epic>-T<số>` |
| [docs/adr/](docs/adr/) | Quyết định kiến trúc, mỗi quyết định một file |
| [docs/measurements/](docs/measurements/) | Số đo trên board: latency, RAM, arena, parity, từng nhánh model |
| [docs/DPIA.md](docs/DPIA.md) | Đánh giá tác động xử lý dữ liệu cá nhân theo Điều 24 Nghị định 13/2023/NĐ-CP |
| [docs/DU_LIEU.md](docs/DU_LIEU.md) | Dataset đã tải và xử lý, số đo trên đĩa |
| [docs/FREERTOS.md](docs/FREERTOS.md) | Sổ kiểm lỗi đồng thời của firmware |
| [docs/thesis/](docs/thesis/) | Ghi chép thực nghiệm cho báo cáo |

🔬 đánh dấu số phải đo trên board thật mà chưa đo.

## Quy tắc khi sửa

- Kế hoạch đi trước code. Đổi kiến trúc thì sửa KẾ HOẠCH trước, rồi mới sửa code.
- Payload MQTT, model đang deploy và vector vàng chỉ sửa ở `contracts/`, rồi `make gen`.
- Hằng số nghiệp vụ, URL, cổng và secret có đúng một nguồn (KẾ HOẠCH §4.9), không gõ thẳng vào code.
- Không commit secret, `.env`, khoá, trọng số model, dataset hay ảnh khuôn mặt.
- Commit theo Conventional Commits, scope là đường dẫn khối: `firmware/svc_vision`,
  `backend/attendance`. Code, comment và commit viết tiếng Anh; tài liệu viết tiếng Việt.
- Trước khi đẩy: `make lint`, `make typecheck`, và test của khối đã sửa.

## License

Code trong repo theo giấy phép MIT, xem [LICENSE](LICENSE). Trọng số model và dataset không nằm
trong repo. Một phần dataset chỉ cho phép dùng cho nghiên cứu, nên bộ model hiện tại cũng chỉ dùng
cho nghiên cứu; ràng buộc của từng mắt xích ở KẾ HOẠCH §1.4.
