# Máy chấm công nhận diện khuôn mặt trên ESP32-S3 — Kế hoạch triển khai

> 🔬 = số liệu phải đo trên board thật, không được lấy từ tài liệu.

---

## Mục lục

- [1. Sáu model + link + dữ liệu train](#1-sáu-model--link--dữ-liệu-train)
- [2. Phần cứng — bảng lắp mạch từng chân](#2-phần-cứng--bảng-lắp-mạch-từng-chân)
- [3. Kỹ thuật tối ưu model — 6 lớp](#3-kỹ-thuật-tối-ưu-model--6-lớp)
- [4. Cấu trúc repo](#4-cấu-trúc-repo)
  - 4.2 `contracts/` · 4.4 `ml/` · 4.5 `firmware/` · 4.6 backend · 4.7 frontend · 4.8 deploy · 4.9 cấm hardcode
- [5. Bảng task FreeRTOS + chia core + IPC](#5-bảng-task-freertos--chia-core--ipc)
- [6. Bộ nhớ và định dạng lưu trữ](#6-bộ-nhớ-và-định-dạng-lưu-trữ)
  - 6.1 Phân vùng flash · 6.2 Bố cục trên thiết bị (NVS · model · LittleFS · **định dạng bản ghi**)
  - 6.3 Buffer nằm ở RAM nội / PSRAM / flash · 6.4 Ngân sách SRAM
- [7. Backend, Frontend, Deploy](#7-backend-frontend-deploy)
- [8. Thứ tự thực hiện](#8-thứ-tự-thực-hiện)

---

## 1. Sáu model + link + dữ liệu train

### 1.1 Bảng model

| Nhánh | Vai trò | Model | Link code / weight | Thông số | License |
|---|---|---|---|---|---|
| **Detect** | Teacher | **YOLO26m-pose** (fine-tune WIDER FACE, 5 keypoint) | [ultralytics/ultralytics](https://github.com/ultralytics/ultralytics) · [docs](https://docs.ultralytics.com/models/yolo26) · weight `yolo26m-pose.pt` tự tải | ~20M params, ~68 GFLOPs @640² | AGPL-3.0 / Enterprise |
| **Detect** | Student | **YuNet (yunet_n)** | Train: [ShiqiYu/libfacedetection.train](https://github.com/ShiqiYu/libfacedetection.train) · ONNX + INT8 tham chiếu: [opencv_zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | **75.856 params**; WIDER FACE val Easy/Med/Hard **0.884 / 0.866 / 0.750** đo ở **độ phân giải gốc**, không phải ở 160×120 của dự án này (§3 lớp 2); ra box **+ 5 landmark** | **MIT** |
| **Anti-spoof** | Teacher | **CDCN++** (có MAFM, giám sát depth map) | [ZitongYu/CDCN](https://github.com/ZitongYu/CDCN) | ACER 0.2% (OULU-NPU P1), HTER 6.5% (CASIA→Replay) | Research-only ⚠️ |
| **Anti-spoof** | Student | **MiniFASNetV2-SE ×2** — mỗi tỉ lệ crop một backbone | [minivision-ai/Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing) — kiến trúc ở `src/model_lib/MiniFASNet.py` | **0.53M params** (2 × 0.26M + head), 0.088 GFLOPs @80×80 | Research-only ⚠️ |
| **Recognition** | Teacher | **ResNet50 @ WebFace600K** (`w600k_r50`, lõi của buffalo_l) | Weight PyTorch + train code: [arcface_torch](https://github.com/deepinsight/insightface/tree/master/recognition/arcface_torch) · pack ONNX: [model_zoo](https://github.com/deepinsight/insightface/tree/master/model_zoo) | LFW 99.83 · CFP-FP 99.33 · AgeDB-30 98.23 · IJB-C(E4) 97.25 | Research-only ⚠️ |
| **Recognition** | Student | **MobileFaceNet (MBF)** | Cùng repo `arcface_torch`, backbone `mbf`, config `configs/*_mbf` | **1.20M params** (đo trên bản trong repo), 4.58MB FP32 → **~1.2MB INT8**, embedding 512-D | Research-only ⚠️ (code MIT, weight/data non-commercial) |

**Hai ràng buộc thiết kế quyết định bộ 6 này:**
> **Landmark chỉ có ở `train`.** Bộ `retinaface_gt_v1.1` không gán landmark cho `val`, nên
> tập đo NMSE landmark phải cắt ra từ chính `train` và không giao với phần đem train. Đo
> landmark trên `val` gốc là đo trên nhãn không tồn tại. Box thì `val` vẫn đủ, AP vẫn đo bình thường.

- Student detect **bắt buộc phải ra 5 landmark**, nếu không thì không align được mặt trước khi vào MobileFaceNet, accuracy nhận diện rớt mạnh. YuNet ra sẵn 5 điểm.
- Teacher detect **cũng phải có landmark** thì mới distill được landmark head, nên dùng biến thể `-pose` chứ không dùng bản detect thuần.
- Anti-spoof student là **hai backbone riêng**, một cho crop 1.0× và một cho 2.7×, ghép
  embedding rồi mới phân lớp — đúng cách bản tham chiếu minivision làm (họ ship hai
  checkpoint rồi ensemble). Dùng chung một backbone cho cả hai tỉ lệ thì rẻ hơn 0,1M tham
  số nhưng bắt cùng bộ trọng số vừa đọc kết cấu da ở crop sát vừa đọc mép giấy ở crop rộng
  — hai loại đặc trưng không liên quan gì nhau. Giá phải trả: anti-spoof suy luận **hai
  lượt** mỗi khuôn mặt. Chấp nhận được vì nó chỉ chạy khi detect thấy mặt, không chạy mỗi
  frame.

**Ngân sách `models_0` — đếm trên tham số thật, không phải ước lượng:**

| Nhánh | Params | ≈ INT8 |
|---|---|---|
| Detect (YuNet) | 75.631 | 76 KB |
| Anti-spoof (MiniFASNetV2-SE ×2) | 525.362 | 525 KB |
| Recognition (MobileFaceNet, embedding 512-D) | 1.199.488 | 1.199 KB |
| **Tổng** | **1.800.481** | **~1,80 MB trong 2 MB** (§6.1) |

Còn ~200 KB, chưa trừ overhead flatbuffer của TFLite (5–15% mỗi file). 🔬 Số cuối chỉ có
sau khi export ở E4-T11/E5-T11/E6-T10; nếu vượt thì hạ `input_hw` của detect trước, vì nó
là nhánh rẻ nhất để train lại.

### 1.2 Dữ liệu train — từng model

Cột **Nguồn thật** là chỗ dữ liệu được lấy về, không phải trang chủ của dataset. Nhiều bộ
gốc nằm sau Google Drive hoặc sau thoả thuận ký tay; nơi nào có mirror công khai thì dùng
mirror, và ghi rõ mirror nào để lần sau lấy lại được đúng bản đó.

**Nhánh detect**

| Dữ liệu | Nguồn thật | Kích thước | Vai trò |
|---|---|---|---|
| WIDER FACE ảnh | HF `wider_face` | train 1.37 GB / 12.880 ảnh · val 346 MB / 3.226 ảnh · split 3.4 MB | ảnh cho teacher và student |
| Bộ chấm điểm WIDER | `eval_tools.zip` của nhóm tác giả | 8.4 MB | **định nghĩa Easy/Medium/Hard** — không có nó thì mọi ngưỡng AP trong tài liệu này vô nghĩa |
| Nhãn 5 landmark | `retinaface_gt_v1.1.zip`, Google Drive của insightface | 4.49 MB | nhãn box + landmark, **dùng chung cho teacher và student** |

Nhãn thật sự có bao nhiêu, đo trên file chứ không lấy từ tài liệu:

| Split | Ảnh | Mặt | Mặt có đủ 5 landmark |
|---|---|---|---|
| train | 12.880 | 159.393 | **75.913** |
| val | 3.226 | 39.697 | **0** |
| test | 16.097 | 0 | 0 |

> **Landmark chỉ tồn tại ở `train`.** Tập đo NMSE landmark phải cắt ra từ `train` và không
> giao với phần đem train. Đo landmark trên `val` là đo với nhãn không tồn tại. Box thì
> `val` đủ, AP đo bình thường. `test` chỉ có danh sách tên ảnh, không dùng được để đo gì.

**Nhánh anti-spoof**

| Dữ liệu | Nguồn thật | Kích thước | Vai trò |
|---|---|---|---|
| CelebA-Spoof | HF `Ar4ikov/celebA_spoof` (**parquet**, không phải layout gốc) | 67.1 GB | train teacher CDCN++ và student MiniFASNet |
| NUAA Imposter | HF `akahana/anti-spoofing-nuaaaa` | 376 MB | test khác miền — ảnh in |
| UniqueData live + replay | HF `UniqueData/anti-spoofing_Real` + `_replay` | 542 MB + 702 MB | test khác miền — màn hình phát lại, có cặp live đối chứng |
| AxonData face-anti-spoofing | HF `AxonData/face-anti-spoofing-dataset` | 4.94 GB | test khác miền — video, có **mặt nạ latex 3D** |
| Tập spoof tự thu | tự thu bằng OV5640 | ≥500 ảnh mỗi loại | test sát thực tế nhất |

> **Không dùng OULU-NPU, CASIA-MFSD, Replay-Attack, MSU-MFSD.** Cả bốn bắt gửi bản cam kết
> ký tay qua email và chờ nhiều tuần. Bốn bộ trên thay được **chức năng** của chúng — dữ
> liệu thu độc lập, khác miền với tập train — nhưng **không thay được khả năng so số trực
> tiếp** với bảng trong bài báo CDCN++ hay MiniFASNet, và không có giao thức OULU P1–P4.
> Báo cáo phải ghi đúng như vậy, không được trình bày như thể đã chạy trên benchmark chuẩn.

**`ml/bench/live_demo.py` là công cụ nhìn, không phải phép đo.** Nó chạy đủ chuỗi
detect → align → spoof → recog trên webcam của máy host để thấy pipeline hoạt động ở thời
gian thực, kèm nút đăng ký mặt ngay trên trang phục vụ. Webcam host **không phải OV5640**:
khác cảm biến, khác ống kính, khác đường xử lý ảnh. Số nó in ra không được đưa vào bảng
nghiệm thu và không thay được "tập spoof tự thu" ở bảng trên.

**Từ khi board có màn LCD, đường nghiệm thu không đi qua PC nữa.** Xem thì xem preview
chạy trên chính LCD (E7-T11); thu dữ liệu thì ghi khung xuống partition `storage` rồi kéo
về bằng `parttool.py`, không stream qua serial. Hai thay đổi này bỏ được hai nguồn sai lệch
mà §9 của `docs/measurements/antispoof/` đã đo: khung không còn bị nén lần thứ hai để
truyền đi, và ảnh nghiệm thu sinh ra từ đúng cảm biến, đúng ống kính, đúng cấu hình thu của
thiết bị thật. `live_demo.py` và `cam_bridge.py` ở lại, nhưng chỉ để lặp nhanh khi sửa
model trên PC — không phải đường nghiệm thu.

Kho mặt đã đăng ký nằm ở `ml/artifacts/recognition/gallery.npz`, khung chụp lại từ nút
"Chụp khung này" nằm ở `ml/artifacts/antispoof/snaps/` — cả hai trong vùng gitignore, vì
embedding và ảnh khuôn mặt là dữ liệu sinh trắc và §6 cấm commit. Mỗi lần chụp ghi bốn file
cùng tên gốc: khung gốc, crop `tight`, crop `wide`, và JSON kèm điểm số cùng tỉ lệ mà mỗi
crop thực sự đạt được — số cuối là thứ đọc một điểm thấp phải đối chiếu (§3).

**Nhánh recognition**

| Dữ liệu | Nguồn thật | Kích thước | Vai trò |
|---|---|---|---|
| R50 @ WebFace600K | weight có sẵn của arcface_torch | ~166 MB | teacher, freeze, chỉ sinh embedding |
| MS1MV3 | HF `gaunernst/ms1mv3-recordio` (`train.rec` + `train.idx` + `property`) | 27.4 GB | train student — **mặc định** |
| Glint360K | HF `gaunernst/glint360k-wds-gz` (**webdataset `.tar.gz`**, đã shard sẵn) | 122 GB / 1385 shard | train student — khi cần nhiều ID hơn |
| LFW · CFP-FP · AgeDB-30 | HF `gaunernst/face-recognition-eval` (`.bin` chuẩn insightface) | 488 MB cả bộ | đo TAR@FAR |
| CFP-FF · CALFW · CPLFW | cùng repo trên, đi kèm sẵn | — | thêm chiều đánh giá, không tốn lần tải riêng |
| Tập nhân viên tự thu | tự thu | ≥2.000 ảnh | đo trên đúng người sẽ dùng máy |

MS1MV3 là mặc định chứ không phải phương án dự phòng: bản `recordio` chỉ 27.4 GB, đúng
định dạng `recordio_to_wds.py` đọc được, nên chạy được toàn bộ pipeline sớm hơn nhiều.
Glint360K để dành khi số ID trở thành giới hạn thật, đo được chứ không phỏng đoán.

**Dùng cho cả ba nhánh**

| Dữ liệu | Vai trò |
|---|---|
| Ảnh OV5640 tự thu (≥2.000, đủ dải sáng và khoảng cách) | validate cuối + calibrate INT8 |

### 1.3 Quy tắc chia dữ liệu

- **Identity-disjoint** cho recognition: một người không được xuất hiện ở cả train và val/test.
- Anti-spoof **giữ nguyên chia train/valid/test của upstream**. Mirror CelebA-Spoof không mang nhãn identity nên không tự kiểm identity-disjoint được; chia lại là phá luôn sự tách của giao thức gốc mà không có gì thay thế.
- Ảnh OV5640 tự thu tách 2 phần **không giao nhau**: `calib/` (300 ảnh, dùng cho PTQ) và `test_device/` (validate cuối).
- Calib chỉ lấy từ **ảnh live**; một khung spoof lọt vào tập PTQ sẽ kéo dải activation về phía tấn công.
- Tập đo landmark cắt từ `train` của detect, không giao với phần đem train (§1.2).
- File split lưu `.txt` và **commit vào git** (`ml/data/splits/`, bố cục ở §4.4.2) — kèm `SPLIT.md` ghi seed và sha256 để tái lập kết quả.

### 1.4 License

Toàn bộ chain dính research-only ở ít nhất một mắt xích (dataset nhận diện, dataset anti-spoof, teacher YOLO AGPL). Với đồ án tốt nghiệp là hợp lệ. Nếu thương mại hoá phải thay: teacher YOLO → Enterprise license hoặc tự train; Glint360K → dataset có license thương mại; CelebA-Spoof → tự thu. Ghi rõ trong báo cáo.

---

## 2. Phần cứng — bảng lắp mạch từng chân

**Board**: ESP32-S3-CAM (GOOUUU / ESP32-S3-WROOM-1 **N16R8**) — 16MB Flash, 8MB **Octal** PSRAM, camera OV5640 hàn sẵn qua đế DVP.
**Pinout camera**: giống `CAMERA_MODEL_ESP32S3_EYE` trong `camera_pins.h`.

### 2.1 Chân camera OV5640 — cố định trên board (chỉ để khai báo trong code)

| Tín hiệu | GPIO | Ghi chú |
|---|---|---|
| SIOD (SCCB SDA) | **GPIO4** | Bus SCCB **riêng** của camera — không dùng chung bus I2C hệ thống |
| SIOC (SCCB SCL) | **GPIO5** | |
| VSYNC | **GPIO6** | |
| HREF | **GPIO7** | |
| XCLK | **GPIO15** | LEDC phát 27 MHz (OV5640 nhận 6–27 MHz) |
| PCLK | **GPIO13** | |
| D0 / Y2 | **GPIO11** | |
| D1 / Y3 | **GPIO9** | |
| D2 / Y4 | **GPIO8** | |
| D3 / Y5 | **GPIO10** | |
| D4 / Y6 | **GPIO12** | |
| D5 / Y7 | **GPIO18** | |
| D6 / Y8 | **GPIO17** | |
| D7 / Y9 | **GPIO16** | |
| PWDN | `-1` | không nối |
| RESET | `-1` | không nối |

**Điều kiện thu — một cấu hình duy nhất cho preview, suy luận và thu dữ liệu.** Ba đường
dùng chung một cấu hình, vì model học phân bố nào thì lúc chạy phải nhận đúng phân bố đó.

| Tham số | Giá trị | Vì sao |
|---|---|---|
| Cỡ khung | HVGA 480×320 | mặt 122 px ở cự ly kiosk; QQVGA còn 60 px, crop recog phải phóng to gấp đôi |
| Định dạng | RGB565 | ảnh chỉ bị nén **một lần** ở khâu crop, khớp lịch sử nén của tập train |
| XCLK | 27 MHz | 14,19 fps, đủ trên sàn 12 fps của E7-T11 |
| Frame buffer | 3, ở PSRAM, `CAMERA_GRAB_LATEST` | preview giữ một khung gần trọn một chu kỳ; hai cái thì sensor không còn chỗ đáp |
| `vflip` / `hmirror` | 1 / 1 | module gắn lens phía trên đầu nối nên khung ra ngược; gương là thứ người dùng chờ đợi ở kiosk |
| Phơi sáng | **thủ công, đo vùng giữa khung** | xem dưới |
| Gain | cố định 8 | gain cao đẻ nhiễu hạt, mà nhiễu hạt chính là thứ nhánh anti-spoof đọc nhầm thành kết cấu da |
| Lọc vằn 50 Hz | `0x3C01` bit 7 = tay, `0x3C00` bit 2 = 50 Hz | tên bit lấy từ driver OV5640 của nhân Linux; ghi xong **đọc ngược lại**, lệch là `drv_camera_init` trả lỗi |

**Phơi sáng nằm thượng nguồn của ngưỡng anti-spoof, nên nó là quyết định kiến trúc chứ
không phải tham số driver.** Đo được: cùng một mặt thật, đủ sáng cho liveness 0,9999, ngược
sáng còn 0,683 — biên độ 0,32, trong khi khoảng cách từ mặt thật tới ngưỡng chỉ 0,006. AE
mặc định đo sáng **cả cảnh**, nên trần nhà sáng kéo phơi sáng xuống và dìm mặt vào bóng;
mất kết cấu da là mất đúng thứ model dùng để tách da thật khỏi ảnh in. Cơ chế ấy hỏng cả
hai chiều: nó cũng làm màn hình điện thoại cháy trắng.

Cách cài: **tắt AE/AGC của sensor**, rồi `drv_camera_expose()` tự đo. Mỗi khung nó lấy mẫu
thưa một phần tư giữa khung, quy kênh lục ra độ sáng, và lái `set_aec_value` về mức mục
tiêu. Toàn bộ đi qua API có tên của `esp32-camera`, không gõ thẳng thanh ghi nào.

Vòng lặp phải **giảm chấn**: sensor mất một tới hai khung mới áp dụng giá trị mới, nên đo
mỗi khung rồi chỉnh ngay là đọc phải khung cũ và ảnh nhấp nháy sáng tối. Mỗi lần chỉnh đi
một phần tư quãng đường còn thiếu, rồi nghỉ ba khung cho sensor bắt kịp.

Cửa sổ giữa khung là xấp xỉ dùng được ngay của "đo theo hộp mặt", vì kiosk luôn có mặt ở
giữa. Khi E8 đưa detector lên board thì thay vùng lấy mẫu bằng hộp mặt thật — vòng lặp giữ
nguyên. Phơi sáng cố định cho ngưỡng bền nhất nhưng phải hiệu chỉnh lại theo từng chỗ lắp,
nên chỉ dùng nếu đo thấy cách này vẫn trôi quá biên.

Hai thanh ghi lọc vằn ràng buộc **AEC của chính sensor**, mà cấu hình này lại tắt AEC đi.
Nên chúng chỉ có tác dụng nếu sau này bật AEC trở lại; còn ở chế độ thủ công, trách nhiệm
chống nhấp nháy nằm ở bộ điều khiển của mình: thời gian phơi phải là bội số của nửa chu kỳ
lưới (10 ms ở 50 Hz), và phần lẻ bù bằng gain. 🔬 Chưa cài — thấy sọc trôi dưới đèn huỳnh
quang thì đây là chỗ sửa, không phải hai thanh ghi trên.

**Preview không nằm trên đường dữ liệu của model.** Model đọc thẳng khung 480×320 gốc;
màn chỉ lấy lát giữa 213×320 trải kín 320×480. Preview vì thế thấy **hẹp hơn** model, tức
ai lọt vào màn thì chắc chắn model cũng thấy — chiều an toàn. Phóng to ở đây không đụng gì
tới dữ liệu model ăn.

### 2.2 Chân CẤM dùng

| GPIO | Lý do |
|---|---|
| **33, 34, 35, 36, 37** | Octal PSRAM (N16R8) — chạm vào là chết PSRAM. Bản Octal cần thêm SPIIO4–7 và SPIDQS, không chỉ ba chân cuối |
| 26–32 | SPI Flash nội (không ra chân trên board này) |
| 19, 20 | USB D+ / D− (nạp + console USB-CDC) |
| 0, 3, 45, 46 | **Strapping** — dùng được nhưng phải theo quy tắc ở bảng dưới |

ESP32-S3 **không có** GPIO22–25. Dải chân thật là 0–21 và 26–48; đừng tính bốn số đó vào chân trống.

### 2.3 Bảng đấu nối ngoại vi

#### A. LCD ST7796S 3.5" 320×480 dọc — SPI 4 dây (SPI2_HOST)

| Chân LCD | GPIO | Vai trò | Lưu ý |
|---|---|---|---|
| VCC | 3V3 | | |
| GND | GND | | |
| SCL / SCK | **GPIO42** | SPI CLK | **80 MHz** — ở 40 MHz một khung 307 KB mất 61 ms, màn hiện hai khoảnh khắc cùng lúc và mặt di chuyển thấy rõ vạch |
| SDA / MOSI | **GPIO41** | SPI MOSI | |
| SDO / MISO | — | không nối | Không cần đọc ngược từ panel |
| CS | **GPIO47** | Chip select | |
| DC / RS | **GPIO39** | Data / Command | Chân thường. Không đặt trên GPIO45: board LCD hay có pull-up ở DC, mà GPIO45 là strapping VDD_SPI — kéo lên lúc reset là chọn flash 1.8 V và board không boot |
| RES | **GPIO40** | Reset panel | (nguyên là SD_DATA — trống vì không dùng microSD) |
| BLK | **GPIO21** | Backlight | LEDC PWM 5 kHz. Nếu backlight > 40 mA → qua MOSFET N (AO3400) |

#### B. Bus I2C hệ thống (I2C_NUM_0, 400 kHz)

| Tín hiệu | GPIO | Ghi chú |
|---|---|---|
| SDA | **GPIO1** | Chính là chân QWIIC trên board |
| SCL | **GPIO2** | |
| Pull-up | 4.7 kΩ lên 3V3 | Đo trước: board GT911 thường đã có sẵn. **Chỉ để 1 cặp pull-up trên toàn bus**, tháo pull-up của các board còn lại. |

| Thiết bị | Địa chỉ |
|---|---|
| GT911 (touch) | `0x5D` (mặc định) hoặc `0x14` |
| VL53L1X (ToF) | `0x29` |
| PCF8574 (I/O expander) | `0x20` (A2A1A0 = GND GND GND) |
| DS3231 (RTC, tùy chọn) | `0x68` |

#### C. Cảm ứng GT911

| Chân | Nối tới | Ghi chú |
|---|---|---|
| VCC | 3V3 | |
| GND | GND | |
| SDA | GPIO1 | bus chung |
| SCL | GPIO2 | bus chung |
| **INT** | **GPIO14** | GPIO thật (không qua expander) — cần ngắt độ trễ thấp **và** dùng để chọn địa chỉ lúc power-up |
| **RST** | **PCF8574 P0** | |

> **Trình tự chọn địa chỉ GT911** (làm trong `drv_touch`): kéo RST = 0 → đặt INT là output, 0 = `0x5D` / 1 = `0x14` → giữ ≥ 10 ms → thả RST = 1 → giữ INT thêm 50 ms → chuyển INT sang input có ngắt.

⚠️ Trình tự này **bắt buộc chạy**, không phải tuỳ chọn. PCF8574 là chân quasi-bidirectional: lúc cấp nguồn mọi chân bật lên HIGH qua nguồn dòng ~100 µA, nên P0 nhả reset GT911 ngay trước khi firmware kịp chạy, và GT911 chốt địa chỉ theo GPIO14 đang thả nổi. Địa chỉ sau power-up là bất định; chỉ lần reset do `drv_touch` chủ động mới quyết định được nó.

#### D. ToF VL53L1X

| Chân | Nối tới | Ghi chú |
|---|---|---|
| VIN | 3V3 (breakout có LDO nên 3.3–5 V đều được) | |
| GND | GND | |
| SDA / SCL | GPIO1 / GPIO2 | bus chung |
| **GPIO1 (INT)** | **GPIO3** | GPIO3 nằm trong dải RTC GPIO (0–21) → **dùng làm nguồn đánh thức deep-sleep**. ⚠️ Strapping JTAG-source: để hở lúc boot, VL53L1X chỉ kéo xuống sau khi được cấu hình → an toàn |
| **XSHUT** | **PCF8574 P1** | P1 lên HIGH lúc cấp nguồn nên VL53L1X tự chạy ở địa chỉ mặc định `0x29` — đúng thứ ta cần vì chỉ có một con. P1 chỉ dùng để reset lại lúc chạy |

#### E. Âm thanh MAX98357A (I²S) + loa 4Ω/3W

| Chân | Nối tới | Ghi chú |
|---|---|---|
| VIN | **5V** | Không lấy 3V3 — mất công suất |
| GND | GND | |
| **BCLK** | **GPIO43** | Nguyên là U0TXD → giải phóng bằng `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y` |
| **LRC / WS** | **GPIO44** | Nguyên là U0RXD |
| **DIN** | **GPIO46** | Strapping này chỉ chọn mức log ROM, không chặn boot. DIN là input trở kháng cao, pull-down nội của chip đã đủ — không cần hàn điện trở |
| **SD (shutdown/mode)** | **PCF8574 P3** | Kéo LOW khi không phát → hết nhiễu xì. Hoặc nối 100 kΩ lên VIN = chế độ mono (L+R)/2 |
| GAIN | để hở | = 9 dB. Nối GND = 12 dB |
| OUT+ / OUT− | Loa | Ngõ ra **cầu (BTL)** — **tuyệt đối không nối OUT− xuống GND** |
| Tụ lọc | 470–1000 µF gần VIN | Bắt buộc, nếu không sẽ reset board khi phát to |

#### F. Chấp hành — lắp cả hai, chọn lúc chạy

Hai bộ chấp hành cùng tồn tại trên board. Servo gạt thanh chắn là thứ thực sự mở cửa mô hình; relay là ngõ ra dành cho khoá điện, đấu sẵn nhưng **tiếp điểm để hở**. `svc_door` bọc cả hai sau `IDoor` (§4.5.5e), chọn bằng `Kconfig` — logic chấm công không biết bên dưới là cái nào.

**F1 — Module 4 relay 5 V opto, tiếp điểm để hở**

| Chân module | Nối tới | Ghi chú |
|---|---|---|
| VCC | **3V3** | Chỉ nuôi LED opto. Cùng mức với PCF8574 nên lúc P2 ở HIGH thì hai đầu LED bằng áp, opto tắt hẳn |
| **JD-VCC** | **Rail 2 — 5 V riêng** | **Rút jumper VCC–JD-VCC trước.** Còn jumper thì 4 cuộn hút ăn chung rail ESP32 |
| GND | GND chung | |
| **IN1** | **PCF8574 P2** | Active-LOW. PCF8574 sink 25 mA nhưng chỉ source ~100 µA → đi đúng chiều nó khoẻ |
| IN2–IN4 | để trống | Dư cho sau, muốn dùng thì lấy P4–P6 |
| COM / NO kênh 1 | **để hở** | Chưa có khoá điện. Đây là ngõ ra dành sẵn |

Nghiệm thu `drv_relay` không cần tải: đóng kênh 1 thì nghe tiếng cạch, LED kênh 1 sáng, và đo thông mạch COM–NO thấy nối. Ba dấu hiệu đó đủ chứng minh driver chạy đúng.

🔬 Sau khi đấu, đặt P2 ở HIGH rồi nhìn LED kênh 1: phải tắt hẳn. Nguồn HIGH của PCF8574 chỉ ~100 µA, đủ yếu để không kích opto nhưng đây là chỗ sát ngưỡng — LED còn sáng mờ hoặc relay rung thì hàn 4,7 kΩ từ IN1 lên 3V3. Hết cách thì dời IN1 sang GPIO48, bỏ LED RGB onboard.

**F1b — Khi lắp khoá điện thật (chưa làm)**

Ngõ ra ở trên nối được thẳng vào khoá chốt điện 12 V mà không sửa gì bên firmware. Lúc đó cần thêm ba thứ: khoá chốt 12 V ~0,6 A loại fail-secure, một nguồn 12 V/2 A riêng, và một diode **1N4007 mắc song song hai đầu khoá, vạch trắng về phía +12 V**. Mạch 12 V **không** chung mass với ESP32; nó chỉ gặp phần còn lại ở tiếp điểm cơ khí bên trong relay.

Thiếu 1N4007 thì lúc relay ngắt, từ trường cuộn khoá sập sinh xung ngược vài trăm vôn đánh hồ quang qua tiếp điểm; tiếp điểm rỗ dần rồi dính, và cửa mở vĩnh viễn.

**F2 — Servo SG90 + thanh chắn**

| Chân | Nối tới | Ghi chú |
|---|---|---|
| PWM (vàng) | **GPIO38** | Phải là GPIO thật (LEDC hoặc MCPWM, 50 Hz) — **không** qua PCF8574 |
| VCC (đỏ) | **Nguồn 5 V riêng** (chung với JD-VCC) | SG90 stall ~700 mA và cú sụt áp đó đủ làm ESP32 brownout giữa lúc mở cửa |
| GND (nâu) | GND chung với ESP32 | Bắt buộc chung mass, nếu không xung PWM không có mốc tham chiếu |

Tụ 470 µF sát chân nguồn servo. Xung 50 Hz, độ rộng 500–2400 µs quét hết tầm ~180°.

#### G. PCF8574

| Chân | Gán cho |
|---|---|
| A0 / A1 / A2 | GND, GND, GND → địa chỉ `0x20` |
| SDA / SCL | GPIO1 / GPIO2 |
| INT | không dùng (poll trong `io_task`) |
| **P0** | GT911_RST |
| **P1** | VL53L1X_XSHUT |
| **P2** | RELAY_IN1 |
| **P3** | MAX98357_SD |
| P4–P7 | dự phòng (P4–P6 dành cho relay IN2–IN4 nếu đấu tiếp) |

Trạng thái nhận diện hiện trên LCD nên không có LED rời. Mọi chân P đều lên HIGH lúc cấp nguồn (§2.3.C) — chỉ giao cho P những việc mà mức HIGH lúc khởi động là vô hại. Relay opto active-LOW khớp đúng luật này: chưa có firmware thì cả 4 kênh tắt, cửa khoá chặt.

### 2.4 Chân trống sau khi lắp hết

| GPIO | Trạng thái |
|---|---|
| GPIO45 | **để trống, không nối gì** — strapping VDD_SPI, pull-down nội giữ mức thấp lúc reset |
| GPIO48 | LED RGB WS2812 onboard — dùng làm đèn báo trạng thái hệ thống |
| GPIO0 | nút BOOT onboard — dùng làm nút "factory reset" (giữ 5 s) |

**Không còn chân GPIO thường nào trống.** GPIO38 là servo PWM, GPIO39 là LCD DC. Cần thêm đường điều khiển chậm thì lấy ở PCF8574 — còn P4–P7. Cần thêm đường nhanh thì chỉ còn cách lấy GPIO48 và bỏ LED RGB onboard, không có chỗ nào khác.

### 2.5 Ngân sách nguồn

Hai rail, chung mass.

**Rail 1 — 5 V / 2 A, logic và ngoại vi**

| Tải | Dòng điển hình | Dòng đỉnh |
|---|---|---|
| ESP32-S3 (Wi-Fi TX) | 100 mA | **350 mA** |
| OV5640 (đang stream) | 120 mA | 200 mA |
| LCD ST7796 + backlight | 100 mA | 150 mA |
| MAX98357A + loa 3W | 30 mA | **600 mA** |
| VL53L1X | 20 mA | 40 mA |
| GT911 | 5 mA | |
| LED opto relay (qua 3V3) | 2 mA | 4 mA |
| **Tổng** | ~377 mA | **~1.34 A** |

**Rail 2 — 5 V / ≥ 1,5 A, cơ cấu chấp hành**

| Tải | Dòng điển hình | Dòng đỉnh |
|---|---|---|
| SG90 | 150 mA | **700 mA** (kẹt) |
| Cuộn hút relay (JD-VCC) | 70 mA (1 kênh) | 280 mA (cả 4) |

Tách rail 1 khỏi rail 2 vì hai đỉnh trùng nhau: kiosk phát tiếng báo đúng lúc mở cửa. Chung một rail thì 1,34 A của đỉnh amp cộng 0,7 A của servo đủ kéo sụt áp và reset ESP32. Rút jumper VCC–JD-VCC chính là thao tác đẩy cuộn hút sang rail 2.

Lắp khoá điện theo §2.3.F1b thì thêm rail 3 — 12 V / 2 A, chỉ nuôi khoá, 0 mA lúc nghỉ và 600 mA lúc hút, cách ly hoàn toàn qua tiếp điểm relay.

Tụ: 1000 µF gần jack 5 V, 470 µF gần MAX98357A, 470 µF gần chân nguồn servo, 100 µF gần LCD.

### 2.6 Datasheet

| Linh kiện | Datasheet |
|---|---|
| ESP32-S3 (SoC) | https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf |
| ESP32-S3-WROOM-1 (module N16R8) | https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf |
| ESP32-S3 Technical Reference Manual | https://www.espressif.com/sites/default/files/documentation/esp32-s3_technical_reference_manual_en.pdf |
| OV5640 (camera) | https://cdn.sparkfun.com/datasheets/Sensors/LightImaging/OV5640_datasheet.pdf |
| VL53L1X (ToF) | https://www.st.com/resource/en/datasheet/vl53l1x.pdf |
| VL53L1X ULD API (driver C) | https://www.st.com/en/embedded-software/stsw-img009.html |
| ST7796S (LCD controller) | https://www.buydisplay.com/download/ic/ST7796S.pdf |
| GT911 (touch) | https://www.crystalfontz.com/controllers/GOODIX/GT911/458/ |
| MAX98357A (I²S DAC/amp) | https://www.analog.com/media/en/technical-documentation/data-sheets/MAX98357A-MAX98357B.pdf |
| PCF8574 (I/O expander) | https://www.ti.com/lit/ds/symlink/pcf8574.pdf |
| DS3231 (RTC, tùy chọn) | https://www.analog.com/media/en/technical-documentation/data-sheets/DS3231.pdf |
| SG90 (servo) | http://www.ee.ic.ac.uk/pcheung/teaching/DE1_EE/stores/sg90_datasheet.pdf |
| SRD-05VDC-SL-C (relay trên module) | https://www.circuitbasics.com/wp-content/uploads/2015/11/SRD-05VDC-SL-C-Datasheet.pdf |
| 1N4007 (diode dập) | https://www.vishay.com/docs/88503/1n4001.pdf |

---

## 3. Kỹ thuật tối ưu model — 6 lớp

Xếp theo đúng thứ tự thực hiện.

### Lớp 1 — Kiến trúc (làm TRƯỚC khi train)

| Kỹ thuật | Nội dung | Áp cho |
|---|---|---|
| Chọn op thân thiện INT8 | Thay SiLU/HardSwish/GELU/**PReLU** → **ReLU6** hoặc **ReLU**. Sigmoid trong khối SE → **HardSigmoid dạng ReLU6(x+3)/6** | cả 3 |
| Kiểm tra op TFLM/ESP-NN **trước khi train** | ESP-NN chỉ tăng tốc: `CONV_2D`, `DEPTHWISE_CONV_2D`, `FULLY_CONNECTED`, `ADD`, `MUL`, `AVG/MAX_POOL`, `SOFTMAX`. Op ngoài danh sách → rơi về kernel C tham chiếu, chậm 10–40× | cả 3 |
| Tránh op không có kernel | `RESIZE_BILINEAR` động, `TRANSPOSE_CONV`, `GATHER`, `ARGMAX` → chuyển ra hậu xử lý viết tay bằng C | detect (NMS, decode anchor) |
| Số kênh về bội số 8/16 | ESP-NN SIMD nạp 16 byte/lần; kênh lẻ = padding phí | cả 3 |
| Giảm độ phân giải đầu vào | detect **160×120** · anti-spoof **81×81** · recog **113×113** | cả 3 |
| Cho feature map lẻ ở mỗi lần stride-2 | Hết `PAD` — xem dưới | cả 3 |
| Gộp kênh bằng `AvgPool2d` cỡ cố định | `AdaptiveAvgPool2d(1)` xuất ra `MEAN`, **không có kernel esp-nn**; cỡ cố định ra `AVERAGE_POOL_2D`, có | khối SE |
| Width multiplier thay vì pruning | Scale kênh 0.75× / 0.5× rồi train lại từ đầu — ổn định hơn prune sau | student |

**Feature map lẻ ở conv stride-2 thì không sinh `PAD`.** TFLite `CONV_2D` chỉ diễn đạt được `SAME` và `VALID`; pad nào không trùng `SAME` phải thành op riêng, mà `PAD` không có kernel esp-nn. Với `k=3, s=2`:

| Đầu vào của conv | `SAME` cần | PyTorch `padding=1` cho | Gộp được? |
|---|---|---|---|
| chẵn N | 1 ô, đặt lệch (0,1) | 2 ô, đối xứng (1,1) | ❌ sinh `PAD` |
| **lẻ N** | 2 ô, đối xứng (1,1) | 2 ô, đối xứng (1,1) | ✅ |

Nên **recognition đổi đầu vào 112 → 113**: chuỗi hạ mẫu thành 57 → 29 → 15 → 8, lẻ ở mọi bước, và cả bốn `PAD` biến mất mà **không đụng tới một conv nào** — kernel giữ nguyên 3×3, trường tiếp nhận giữ nguyên. Giá phải trả: kernel global khép sổ 7×7 → 8×8 (+7.680 tham số) và activation to hơn 1,8%. Đo được 82 ms, xem `docs/measurements/latency.md`.

Hệ quả: `align.cpp` warp ra **113×113**, và `decode` của loader cũng đưa ảnh MS1MV3 về 113 — cả hai đều là "khuôn mặt đã căn, dựng lại ở 113×113", nên train và thiết bị nhìn thấy cùng một thứ.

Anti-spoof theo cùng quy tắc: **80 → 81**, chuỗi thành 41 → 21 → 11 → 6, và 8 `PAD` (4 mỗi backbone) biến mất. Kernel khép sổ 5×5 → 6×6. `preproc.cpp` cắt ra 81×81.

**Khối SE phải gộp kênh bằng `AvgPool2d` cỡ cố định.** `nn.AdaptiveAvgPool2d(1)` xuất ra `GlobalAveragePool` rồi thành `MEAN`, mà `MEAN` không có kernel esp-nn — 20 khối SE của anti-spoof tốn 217 ms vì đúng chỗ này. Khai cỡ cửa sổ bằng số thì ra `AVERAGE_POOL_2D`, có kernel. Cái giá là mỗi khối SE phải biết feature map của nó rộng bao nhiêu, tức phải suy từ kích thước đầu vào chứ không để mạng tự co giãn.

**ReLU và ReLU6 tốn thời gian như nhau, và bằng không.** Kernel conv của esp-nn nhận `activation_min` / `activation_max` rồi kẹp ngay trong vòng lặp assembly, nên hàm kích hoạt chỉ là một cặp số trên đầu ra conv, không phải một op riêng. Vì thế chọn giữa hai cái **không phải chuyện tốc độ** mà là chuyện lượng tử hoá:

| | Tốc độ | CLE (§3.8) | Dải activation |
|---|---|---|---|
| `PReLU` | **chậm**: op riêng, không có kernel esp-nn | ✅ thuần nhất dương | không chặn |
| `ReLU` | 0 | ✅ thuần nhất dương | không chặn trên |
| `ReLU6` | 0 | ❌ trần cố định phá tính thuần nhất | chặn ở 6 |

Mặc định là `ReLU6` vì dải bị chặn giúp INT8; nhưng nhánh nào cần CLE thì `ReLU` là lựa chọn duy nhất không mất tốc độ. Khai bằng `model.params.activation` ở config nhánh, để so được bằng số thay vì tranh luận. **`PReLU` thì không được dùng ở bất kỳ nhánh nào** — nó tốn 42,3% thời gian của cả pipeline, đo ở `docs/measurements/latency.md`.

### Lớp 2 — Huấn luyện & Distillation

| Kỹ thuật | Chi tiết |
|---|---|
| **Logit KD** | `KL(soft_teacher/T ‖ soft_student/T) · T²` + task loss. T = 2–4 |
| **Feature KD (FitNets)** | Ghép feature map trung gian teacher↔student qua conv 1×1 adapter, loss L2 |
| **Attention Transfer** | Chuyển bản đồ chú ý `sum(|F|²)` theo kênh — rẻ, hiệu quả với model bé |
| **Detect: localization KD** | Distill cả tọa độ box **và 5 landmark**, không chỉ classification |
| **Detect: FGD (feature imitation có mặt nạ)** | Chỉ bắt chước feature ở vùng gần GT box, bỏ nền → student không học nhiễu nền |
| **Anti-spoof: depth-map KD** | Distill **depth map 32×32** của CDCN++ (L1 pixel-wise) + **contrastive depth loss**. Giá trị của nó phụ thuộc đích depth phủ đúng vùng mặt — xem mục dưới |
| **Recog: embedding KD** | Cosine + L2 giữa embedding 512-D teacher/student, cộng **ArcFace** trên nhãn thật |
| **Recog: relation KD (RKD)** | Giữ khoảng cách & góc giữa các cặp/bộ ba embedding trong batch — quan trọng hơn khớp từng vector |
| **Progressive / multi-stage KD** | GĐ1 chỉ feature KD → GĐ2 thêm logit/localization KD → GĐ3 thêm task loss (tăng dần trọng số) |
| **Soft target: online vs cache** | Cache được hay không là do **augment**, không do tiện. Cache offline 1 lần nếu augment cố định (nhanh 2–3×); augment ngẫu nhiên mạnh thì teacher phải chạy online |
| **Chia theo loại soft target** | **Hình học cache được** (box, landmark, score): biến đổi theo ảnh y hệt nhãn thật, kể cả mosaic. **Feature map thì không**: nó là tensor dày theo không gian ảnh, mosaic ghép 4 ảnh rồi cắt ngẫu nhiên nên không có phép nào đưa nó theo. Nhánh nào cần feature KD dưới augment mạnh thì teacher **bắt buộc nằm trong vòng train** |
| **Quantization-friendly training** | Weight decay trên weight conv, clip activation, triệt outlier → phân bố hẹp, INT8 mất ít |
| **Augment mô phỏng OV5640** | Nhiễu Poisson-Gaussian, nén JPEG q=60–90, sai lệch cân bằng trắng, vignette, motion blur, ánh sáng ngược |
| **Anti-spoof: augment tỉ lệ crop** | Rút ngẫu nhiên tỉ lệ wide rồi cắt lại từ record, **rút cùng một phân bố cho cả hai lớp**. Bắt buộc, xem mục dưới |

#### Công thức lấy mẫu của detect phải khớp kích thước đầu vào

Ở đầu vào 160×120, letterbox ép ảnh WIDER 1024 px xuống hệ số 0,156. Đo trên chính tập
train: **median khuôn mặt còn 2,9 px**, và **85,5% khuôn mặt nhỏ hơn một ô lưới stride-8**.
Hộp nhỏ hơn độ phân giải lưới thì không hồi quy được — đó là dạy nhiễu, không phải dạy mặt.

Hệ quả đo được với `LEVEL_RANGES` cũ `(0,32) (32,96) (96,∞)`:

| Tầng | Stride | % số mặt rơi vào | Prior dương |
|---|---|---|---|
| 0 | 8 | 98,8% | 5.860 |
| 1 | 16 | 1,2% | 917 |
| 2 | 32 | 0,0% | **0** |

Tầng 2 chưa từng nhận một mẫu dương nào: ba đầu ra, dùng thật một. Và phân bố lúc train
(median 2,9 px) lệch hẳn phân bố lúc chạy — kiosk nhìn **một** mặt ở 0,5–1,5 m, 🔬 ước
20–45 px. Đây là lệch train/serve về kích thước, không phải chuyện thiếu epoch.

**Công thức chốt, mọi ngưỡng lấy từ đo:**

| Tham số | Giá trị | Căn cứ |
|---|---|---|
| `crop_scale` | `[0.3, 1.0]` | Cắt vùng ngẫu nhiên rồi phóng về đầu vào. Median lên 13,6 px, p75 21 px, p90 34,8 px — chồng lên dải của kiosk |
| `min_face_px` | `8` | Đúng một ô lưới stride-8. Lọc **sau** khi crop, tại đúng độ phân giải đầu vào |
| `LEVEL_RANGES` | `(0,16) (16,48) (48,∞)` | Chia 61,1% / 33,6% / 5,3% trên phân bố sau augment |

Lọc sau crop chứ không lọc khỏi dataset: cùng một khuôn mặt được học khi rơi vào crop gần
và bỏ qua khi ảnh cắt xa. Lọc vĩnh viễn là dạy model rằng chỗ đó là nền.

Cái giá phải trả nằm ở §4.4.1: student giờ **có** augment phóng to, nên nó phải đọc ảnh
gốc chứ không đọc bản resize sẵn.

#### Nghiệm thu detect đo trên miền nhánh này phục vụ

Ba số Easy/Med/Hard của YuNet ở §1.1 đo trên **ảnh WIDER ở độ phân giải gốc**. Dự án này
chạy 160×120. Lấy số của một kích thước đầu vào làm cổng nghiệm thu cho kích thước khác
là so hai phép đo khác nhau, và cổng đó không đạt được vì lý do vật lý chứ không vì train
kém.

Đo trên WIDER val sau khi letterbox về 160×120, trung vị cạnh khuôn mặt:

| Tập | Trung vị (px) |
|---|---|
| easy | 10,4 |
| medium | 7,1 |
| hard | **3,1** — 48,8% dưới 3 px |

Medium và Hard phần lớn là vệt vài pixel. Nâng đầu vào là đường duy nhất để với tới
chúng, và 🔬 arena ước tính chặn đường đó: 150 KB ở 160×120, 337 KB ở 240×180, 600 KB ở
320×240, so với ~175 KB `arena_fast` mà detect chia với anti-spoof (§3.10). Detect chạy
mỗi frame nên không đẩy sang PSRAM được.

**Miền phục vụ được định nghĩa bằng chính pipeline, không phải chọn cho dễ.** Camera đưa
khung 640×480 cho nhánh AI (§6.3), detect chạy đúng một phần tư của nó, recognition cần
crop 112×112. Mặt **32 px ở đầu vào detect = 128 px trong khung camera**, vừa trên 112.
Dưới ngưỡng đó crop căn chỉnh phải phóng to mới đủ cho MobileFaceNet, nên bắt được cũng
không dùng được ở khâu sau. Đó là biên, và nó là cổng.

| Mốc | Ngưỡng | Đo bằng |
|---|---|---|
| Student FP32 | **AP ≥ 0,90** trên mặt ≥ 32 px | `eval.py`, cột `ge32px` |
| Student INT8 | sụt **< 1%** so với FP32 (§3.8) | `eval.py`, cột `ge32px` |
| Vận hành | recall **≥ 0,90** và **≤ 0,15** khung thừa mỗi ảnh, trên ảnh một mặt cỡ kiosk | `eval.py` |
| Teacher | WIDER hard ≥ 0,80 **đo ở 640²**, đầu vào của chính teacher | `eval.py --input-hw 640 640` |

Mặt dưới 32 px không tính đúng cũng không tính sai — dùng đúng luật ignore của kit, giống
cách Easy/Med/Hard là ba cách đọc một tập dự đoán. Tính chúng là dương tính giả sẽ thành
phạt model vì tìm ra mặt thật.

**Ba số WIDER chính thức vẫn báo cáo đủ, chỉ không dùng để chốt.** Bỏ chúng đi là giấu
điểm yếu; giữ chúng làm cổng là chốt nhánh bằng một phép đo nó không phục vụ. Báo cáo cả
hai, ghi rõ kích thước đầu vào của từng con số.

#### Nhánh anti-spoof chống đúng hai kiểu tấn công, và nói thẳng kiểu thứ ba nó không chống

Mọi quyết định phía dưới chỉ có nghĩa khi biết nhánh này đang chặn cái gì. Chốt phạm vi:

| Kiểu tấn công | Trong phạm vi | Có dữ liệu train | Chấm điểm ở |
|---|---|---|---|
| Ảnh in trên giấy, ảnh thẻ giơ trước camera | ✅ | CelebA-Spoof, NUAA | cổng APCER |
| Phát lại trên màn hình điện thoại / máy tính bảng | ✅ | CelebA-Spoof | cổng APCER |
| Mặt nạ 3D, silicone, latex | ❌ | **không có** | chỉ quan sát, trên Axon |

Hai kiểu đầu để lại dấu vết nhánh này đọc được: moiré, mép giấy, viền màn hình, ánh phản
đều trên một mặt phẳng. Mặt nạ 3D thì không — nó có chiều sâu thật, nên tín hiệu duy nhất
còn lại là kết cấu bề mặt, thứ mà một model 80×80 INT8 trên ESP32-S3 không đủ sức đọc.

**Đo Axon vẫn báo cáo, nhưng không được làm cổng.** Chốt một nhánh bằng phép đo không có
dữ liệu train tương ứng là chốt bằng may rủi: điểm tốt lên hay xấu đi đều không nói được
điều gì về thay đổi vừa làm. Kiosk đặt trong nhà, có người qua lại, nên một chiếc mặt nạ
silicone vừa đắt vừa dễ bị nhìn thấy — rủi ro còn lại này nhận là nhận, không vá bằng
augmentation bịa ra.

#### Tỉ lệ crop wide bị hình học khung hình chặn trên

Anti-spoof student đọc hai khung của cùng một mặt: crop **tight** 1,0× và crop **wide**
2,7×. Hai loại dấu hiệu nằm ở hai chỗ khác nhau — kết cấu da và moiré nằm trong mặt, còn
mép giấy, viền màn hình, bàn tay đang cầm nằm **ngoài** mặt. Bịt nhánh wide lại, điểm của
một tập ảnh thẻ giơ trước camera nhảy từ 0,0035 lên 0,3195: phần lớn khả năng bắt tấn công
đi qua ngữ cảnh.

Nhưng ngữ cảnh 2,7× **không phải lúc nào cũng tồn tại**. Tỉ lệ lớn nhất còn dựng được là
`min(cao, rộng) / cạnh_mặt`, và nó tụt khi người lại gần:

| Khung 1280×720 | Cạnh mặt | Tỉ lệ lớn nhất còn lọt |
|---|---|---|
| Ảnh thẻ giơ trước camera | 235 px | 3,07× |
| Quay đầu, nghiêng, ngược sáng | 319 px | 2,26× |
| Ngồi cách một cánh tay | 349 px | 2,06× |
| Ngồi sát camera | 696 px | 1,03× |

**Ở khoảng cách người dùng thật, 2,7× đã không dựng được.** Chỉ nhóm tấn công dựng được,
vì ảnh thẻ bị giơ xa hơn mặt người — nghĩa là "ảnh wide còn nguyên" tương quan với nhãn
tấn công, đúng loại đường tắt phải chặn.

Áp vào kiosk: camera đưa khung 640×480 cho nhánh AI (§6.3) và nhận diện cần mặt ≥ 128 px
(mục trên). 2,7× lọt khung khi mặt ≤ 480 / 2,7 = **178 px**. Dải dùng được là mặt 128–178
px, tức tỉ lệ khoảng cách **1,39 lần**. Hẹp, và nằm ngoài dải đó là chuyện thường chứ
không phải ngoại lệ.

**Chốt: tỉ lệ wide là biến, không phải hằng số. Crop wide = ô vuông lớn nhất còn lọt khung,
trần 2,7×, và ô vuông đó được TRƯỢT cho chứa trọn hộp mặt chứ không ép đặt giữa mặt.**
Thiếu chỗ thì thu tỉ lệ lại, không kéo giãn và không đệm.

Bốn cách dựng, đo trên 48 khung camera thật với **cùng một bộ trọng số**, chỉ đổi ảnh wide:

| Cách dựng | Mặt gần | Cách một cánh tay | Cách biệt thật/tấn công |
|---|---|---|---|
| Cắt theo biên rồi kéo về vuông | 0,2538 | 1,0000 | 15,6× |
| Đệm phản chiếu cho đủ 2,7× | 0,0823 | 0,9999 | — |
| Lấy luôn crop tight làm wide | 0,9953 | **0,0002** | — |
| **Ô vuông lớn nhất còn lọt khung** | **0,9957** | **0,9999** | **108,3×** |

Cắt theo biên đẻ ra khung chữ nhật rồi `resize` vuông, tức là kéo méo mặt: ở cự ly gần
hộp mất 74% diện tích và tỉ lệ cạnh thành 1,78. Đệm phản chiếu thì nội dung là bịa, và
model đọc nội dung bịa quanh mặt đúng như nó được dạy — thành dấu hiệu tấn công. Lấy tight
làm wide thì mất ngữ cảnh cả ở cự ly còn thừa chỗ, nên mặt thật ở khoảng cách bình thường
bị chấm 0,0002. Chỉ ô vuông lọt khung vừa không méo, vừa không bịa, vừa giữ đúng lượng
ngữ cảnh **còn tồn tại thật**.

**Trượt, không đặt giữa.** Ô vuông lớn nhất *đặt giữa tâm mặt* mà lọt khung có cạnh
`2·min(cx, cy, W−cx, H−cy)`; ô vuông lớn nhất *lọt khung* có cạnh `min(W, H)`. Hai số này
lệch nhau đúng bằng phần lệch tâm của khuôn mặt, và khi mặt nằm lệch xuống dưới hoặc sát
một mép thì số đầu tụt xuống **dưới cả cạnh hộp mặt** — crop cắt cụt cằm và miệng. Vì ô
vuông sau đó vẫn phải trượt cho lọt khung, ràng buộc đặt giữa **không mua được gì**: nó bị
áp rồi bị bỏ ngay ở bước sau.

Đo trên 8 khung điện thoại có mặt lớn và lệch tâm, cùng bộ trọng số, chỉ đổi cách dựng
(`docs/measurements/antispoof/measurements.md` §12.5):

| | Số khung qua ngưỡng 0,90 | Điểm thấp nhất |
|---|---|---|
| Ép đặt giữa | 2 / 8 | **0,0004** |
| **Trượt cho lọt** | **4 / 8** | **0,1499** |

Khung tệ nhất đi từ 0,0004 lên 0,9860. Bốn khung còn dưới ngưỡng đều là mặt chiếm trên 87%
cạnh ngắn khung hình — ở đó ngữ cảnh **không tồn tại trong ảnh**, và không cách dựng nào
lấy được thứ máy ảnh chưa chụp. Đó là biên của nhánh, và nó là việc của cảm biến khoảng
cách chứ không phải của model.

Ba ràng buộc đi kèm:

- **Prep và inference gọi chung một hàm.** Lệch hai bên là nguồn của mọi phép đo sai:
  model đọc ở kiosk một phân bố hình học khác hẳn phân bố nó được train.
- **Tỉ lệ thật đạt được ghi vào từng record.** Đích depth của teacher dựng từ nó (mục dưới),
  và không có nó thì không kiểm được phân bố tỉ lệ mà một run đã thấy.
- **Đổi cách dựng thì shard hết giá trị.** Mọi run train trước đó đọc một phân bố hình học
  khác; sinh lại shard rồi train lại là bắt buộc, không phải tuỳ chọn.

#### Hộp mặt phải đến từ detector, không từ chú thích của dataset

Dùng chung một hàm cắt là chưa đủ nếu hai bên đưa vào **hai hộp khác nhau**. CelebA-Spoof
ship sẵn cột `Bbox` do người gán nhãn vẽ, còn kiosk chỉ có hộp YuNet trả về. Đo hai hộp trên
cùng 759 ảnh gốc, cùng hệ toạ độ pixel:

| So YuNet với `Bbox` | Trung vị | p90 |
|---|---|---|
| Tỉ lệ cạnh | **1,049** | 1,330 |
| Xê dịch tâm | **3,0%** cạnh hộp | — |
| Tỉ lệ ảnh lệch tâm quá 2% | **73,8%** | |

Riêng tỉ lệ cạnh đo lại được trên 8.782 bản ghi shard bằng `wide_scale` — với bản ghi bị khung
hình cắt cụt thì `wide_scale` chính là `min(W,H)/cạnh mặt`, nên thương của hai bản dựng khử
hết phần còn lại: trung vị **1,029**, p10 0,939, p90 1,124, và **77,4%** số hộp lệch quá 2%.

Hộp detector to hơn vài phần trăm và lệch tâm 3%. Nghe nhỏ, nhưng model mất **15% số khung**
chỉ vì xê dịch 2% (mục dưới), nên đây là một độ lệch hệ thống trên **mọi** crop nó từng học.

**Chốt: shard dựng bằng hộp của detection student, không dùng cột chú thích.** `xdomain_crop.py`
đã theo đúng luật này cho NUAA và Axon; tập train chính phải theo cùng. Ảnh nào detector
không thấy mặt thì bỏ, vì kiosk cũng sẽ không thấy — đo được 0,28% số ảnh, và tỉ lệ hai lớp
gần như không đổi (1,884 → 1,877), nên phép bỏ này không kéo theo lệch cân bằng nhãn.

**Hệ quả về thứ tự chạy:** `01_prepare_interim.sh` nhánh antispoof từ đây cần một checkpoint
detection đã train xong, nên nó không còn chạy được trên một bản clone trắng. Số thứ tự của
script vẫn là thứ tự chạy cho từng nhánh, nhưng riêng antispoof thì `10_train_teacher_det.sh`
và `20_kd_det.sh` phải xong trước. Đường dẫn checkpoint khai ở `configs/common/paths.yaml`
theo §4.9, không gõ thẳng vào script.

#### Model dựa vào mặt nằm đúng chỗ, nên hộp rung là phải dạy

Xê dịch hộp mặt rồi chấm lại 44 khung mặt thật đang đạt 0,99:

| Xê dịch | 0% | 2% | 5% | 10% |
|---|---|---|---|---|
| Tỉ lệ qua ngưỡng 0,90 | 100% | **85%** | 77% | 72% |
| Phân vị 10 của điểm | 0,93 | 0,87 | **0,50** | 0,09 |

Detector rung vài phần trăm giữa hai khung liên tiếp, nhất là khi người dùng đang xoay đầu
hoặc bước tới. Trong khi đó **mọi mẫu train đều có mặt nằm chính giữa crop** — không phép
augment nào tịnh tiến nó.

**Chốt: rút một vector tịnh tiến cho hộp mặt trước khi cắt, cùng phân bố cho cả hai lớp, có
cổng xác suất.** Biên độ lấy theo mức detector thật sự rung, không lấy tròn: ±10% cạnh hộp
phủ được cả phần lệch hệ thống giữa hai quy ước hộp ở mục trên.

#### Tỉ lệ crop tương quan với nhãn, nên phải rút ngẫu nhiên cho cả hai lớp

Trong CelebA-Spoof, ảnh tấn công bị giơ xa hơn mặt người, nên tỉ lệ wide dựng được **tương
quan thẳng với nhãn**. Đếm trên 3.000 bản ghi train dựng bằng ô vuông trượt:

| Tỉ lệ wide | Số mẫu | Mặt thật | Tấn công |
|---|---|---|---|
| **< 1,0** — crop ngắn hơn hộp mặt | 309 | **0** | **309** |
| ≥ 1,0 | 2.691 | 835 | 1.856 |

Dưới 1,0 là **dự đoán hoàn hảo**: không một mặt thật nào rơi vào đó. Model học đúng thứ
được dạy — *cắt cụt ⇒ tấn công* — và đường tắt ấy nổ mỗi lần người dùng lại gần, nổ theo
bậc độ lớn chứ không trôi quanh ngưỡng. Không ngưỡng nào chữa được.

Chỗ này **không tự hết khi sửa cách dựng crop**. Ô vuông trượt đã lấy lại phần lớn khuôn
mặt bị cắt, nhưng phần còn lại dưới 1,0 chính là những ảnh mà hộp mặt lớn hơn cạnh ngắn
khung hình — tức ảnh chụp lại màn hình choán hết khung. Sửa hình học làm tương quan **đậm
hơn**, không nhạt đi.

Phép augment này chỉ **thu nhỏ** ngữ cảnh có sẵn — không có cách nào bịa thêm phần khung
hình mà ảnh gốc không chứa. Nó vì thế **một chiều**, và một phép một chiều **bắt buộc phải
có cổng xác suất**: không có cổng thì mọi mẫu đều bị đẩy về một phía và tập train thôi
không còn chứa điều kiện lúc suy luận. Augment quang học và augment nén đều có cổng `p=0,5`
nên mẫu sạch vẫn nằm trong tập train; tỉ lệ crop là phép duy nhất từng áp cho **100%** mẫu,
và đó là lỗi.

Đo vị trí của điều kiện kiosk bên trong phân bố train, trên 3.000 bản ghi:

| Chính sách | Phân vị của \|tight − wide\| lúc suy luận | Phân vị của tỉ lệ |
|---|---|---|
| Rút đều `[0.7, 2.7]`, không cổng | **74,3** | **80,6** |
| `p=0,15` trong `[0.7, 1.2]` | 57,8 | 57,8 |

Không cổng thì kiosk chạy ở vùng đuôi trên của những gì model từng thấy: chỉ khoảng một
phần tư số mẫu train có đủ ngữ cảnh như một khung kiosk điển hình.

**Chốt: mỗi mẫu có xác suất `p = 0,15` được rút một tỉ lệ trong `[0.7, 1.2]`; 85% còn lại
giữ nguyên tỉ lệ lưu trong record.** Rút từ cùng một phân bố cho cả live lẫn spoof — đó là
toàn bộ mục đích, vì khi hai lớp cùng gặp vùng cắt cụt thì tỉ lệ hết mang thông tin về nhãn.

Đặt tham số theo hai đại lượng phải cùng đạt, đo trên 6.000 bản ghi train thật:

| Chính sách | \|tight − wide\| | `P(spoof \| tỉ lệ < 1,0)` | mẫu live < 1,0 |
|---|---|---|---|
| Không augment | 57,7 | 0,969 | 4 |
| Rút đều `[0.7, 2.7]` | 42,0 | 0,678 | 323 |
| **`p=0,15` trong `[0.7, 1.2]`** | **50,9** | **0,719** | **188** |

Cột trái đo lượng thông tin phân biệt nhánh wide với nhánh tight; tụt cột này là bỏ đói
nhánh wide và mất luôn khả năng đọc bối cảnh. Cột giữa đo đường tắt, cơ sở `P(spoof)` là
0,659. Dải rộng đứt được đường tắt nhưng trả giá 27% ngữ cảnh; dải hẹp áp cho thiểu số giữ
được 88% ngữ cảnh mà vẫn kéo đường tắt về sát cơ sở.

Cận dưới đặt tại 0,7 vì đó là vùng mà mặt thật ở cự ly gần thật sự rơi vào: 🔬 tám khung
điện thoại đo được 0,70–0,98, và đuôi dưới của chính tập train chạm 0,74. Trên 1,0 chỉ
augment nhánh wide; **dưới 1,0 phải cắt cả hai nhánh cùng một lượng**, vì thiếu chỗ thì
`fitted_box` thu cả tight lẫn wide bằng nhau — cắt mỗi wide là dạy một hình học không tồn tại.

Trần vẫn là tỉ lệ mà từng ảnh dựng được. Ràng buộc "không kéo giãn, không đệm" ở mục trên
không được phép lách qua đường augment.

Ba điều kiện để phép augment này có nghĩa:

- **Chỉ áp lúc train.** Val và test giữ nguyên tỉ lệ thật, nếu không thì bảng đối chứng
  đo trên một phân bố hình học không có ở kiosk.
- **Phân bố tỉ lệ lúc train phải bám phân bố lúc suy luận.** Kiosk dựng nhánh wide ở 2,7
  cố định, nên trung vị tỉ lệ khi train mà tụt xa 1,9 là đã đo một thứ khác với thứ sẽ chạy.
  Đổi tham số augment thì đo lại hai cột trên trước khi tốn giờ GPU.
- **Ghi tỉ lệ đã rút vào batch**, không phải tỉ lệ gốc của record. Đích depth của teacher
  dựng từ nó, và dựng theo tỉ lệ gốc là đặt gò Gauss lệch khỏi vùng mặt.

#### Nhánh tight phải học phơi sáng, nếu không nó đọc độ sáng thay cho kết cấu

Nhánh tight đọc crop 1,0× và phải tách mặt thật khỏi bản in bằng **kết cấu bề mặt**: lỗ
chân lông, độ bóng của da, vân moiré của màn hình. Kết cấu là đại lượng cục bộ, không phụ
thuộc mức sáng chung của khung.

Đo trên checkpoint A0 chưa có augment quang học, làm tối và bẹt tương phản chính những
khung nó đang chấm đúng:

| Biến đổi | Mặt thật, một cánh tay | Mặt thật, sát camera | Ảnh thẻ |
|---|---|---|---|
| Nguyên bản | 0,9999 | 0,9963 | 0,0025 |
| Tối 15%, tương phản 80% | **0,0262** | **0,0594** | 0,0001 |
| Tối 30%, tương phản 65% | 0,0066 | 0,0289 | 0,0001 |

**Tối 15% là ngưỡng mắt người gần như không thấy, mà điểm rơi từ 0,9999 xuống 0,026.** Đó
là bằng chứng nhánh tight không đọc kết cấu như thiết kế — nó bám vào **độ sáng và tương
phản tuyệt đối**. Mẫu tấn công gần như không đổi, nên phép biến đổi này chỉ phá một lớp.

Chế độ hỏng ngoài đời khớp đúng: người đứng trước tường trắng hoặc cửa sổ thì máy đo sáng
bám theo nền, kéo khuôn mặt thiếu sáng và mất tương phản, và model gọi mặt thật là tấn
công. Chiều ngược lại cũng vậy — màn hình tự phát sáng cho khuôn mặt phơi sáng đẹp, nên
một đòn replay ở xa lại được đọc là thật.

CelebA-Spoof không dạy được điều này: nó quay live và spoof trong cùng những căn phòng với
cùng cách đặt sáng, nên mức sáng gần như không đổi trong tập.

**Chốt: augment phơi sáng là bắt buộc cho nhánh anti-spoof**, cùng hạng với augment nén.
Rút một hệ số phơi sáng và một hệ số tương phản, áp **một lần cho cả hai view** vì hai crop
là một cảnh qua một ống kính. Dải phải trùm được vùng đã đo ra lỗi, tức xuống tới 0,55 phơi
sáng và 0,50 tương phản, đồng thời phủ cả phía dư sáng.

Cận trên phải **đối xứng trong log** với cận dưới: `1 / 0,55 = 1,82` nên gain dừng ở **1,80**,
và `1 / 0,50 = 2,00` nhưng tương phản dừng ở **1,50** vì trên mức đó ảnh bẹt về hai cực. Một
dải lệch về phía tối không mở rộng tập train mà **dời** nó, và cái bị mất là đuôi cháy sáng:

| Tỉ lệ mẫu có nền cháy sáng quá 4% | |
|---|---|
| Shard gốc | 14,4% |
| Sau augment dải lệch `(0,55; 1,25)` | **4,8%** |
| Sau augment dải đối xứng `(0,55; 1,80)` | 14,0% |
| Khung kiosk thật | **~35%** |

Nền cháy sáng có tương quan **−0,724** với điểm — mạnh gấp đôi mọi đặc trưng khác đo được —
nên đuôi này không phải chi tiết bỏ qua được.

`backlight` không thay được: nó kéo một bên khung **về phía trắng**, tức làm sáng lên, còn
`vignette` chỉ tối bốn góc và nhân đúng 1,0 ở giữa khung — nơi khuôn mặt nằm.

#### Model sống bằng dải mắt–mũi, nên che chỗ đó là hỏng — và đó là ràng buộc hai chiều

Đo trên 44 khung mặt thật mà A0 đang chấm 0,9995, phá dần từng kiểu rồi chấm lại:

| Kiểu phá | 15% | 30% | 45% | 60% |
|---|---|---|---|---|
| Che phần **dưới** mặt (mồm, cằm) | 0,999 | 0,998 | 0,998 | **0,951** |
| Che **dải giữa** (mắt, mũi) | 0,997 | 0,743 | **0,076** | 0,295 |
| Che một **cạnh** | 0,998 | 0,981 | 0,726 | 0,510 |
| Mép khung cắt **ngang** | 0,959 | 0,870 | 0,749 | **0,077** |
| Mép khung cắt **trên** | 1,000 | 0,997 | 0,999 | 0,990 |

Che mồm gần như vô hại; che mắt là chết. Cắt mép trên vô hại; cắt mép ngang là chết. Suy ra
**khẩu trang chạy được**, còn bàn tay đưa lên quá sống mũi thì không.

Đây không thuần tuý là lỗi. Dải mắt–mũi là nơi tập trung tín hiệu sống — độ nổi sống mũi,
hốc mắt — nên model bám vào đó là **đúng thiết kế**. Dạy nó bỏ qua vùng ấy là dạy nó chấp
nhận cả những đòn tấn công cũng thiếu vùng ấy. Vì thế hai biện pháp dưới đây phải đi cùng
nhau, và biện pháp chặn đứng trước.

**Chốt 1 — tiền kiểm hình học, chạy trước khi chấm.** Hộp mặt phải nằm trọn trong **vùng
ảnh thật** của khung, có lề. Không đạt thì trả về "đưa mặt vào khung", **không** trả về
phán quyết sống/giả. Vùng ảnh thật là khung đã trừ viền letterbox: đường thu ảnh có thể độn
đen hai bên, và `fitted_box` không biết phân biệt đen với tường nên sẽ kéo viền vào crop.

**Chốt 2 — augment che, có cổng, rút cùng phân bố cho cả hai lớp.** Một khối chữ nhật xám
đặt ngẫu nhiên trong hộp mặt, áp **một lần cho cả hai view** vì hai crop là một cảnh. Cổng
xác suất là bắt buộc, cùng lý do đã ghi ở mục tỉ lệ crop: phép này một chiều, không cổng
thì mọi mẫu đều bị che và tập train rời khỏi điều kiện vận hành. Rút cùng phân bố cho cả
hai lớp là bắt buộc, nếu không thì "bị che" trở thành đường tắt dự đoán nhãn.

Nghiệm thu phép augment này bằng **APCER**, không chỉ BPCER. Nó nới điều kiện chấp nhận nên
rủi ro cố hữu là cho tấn công lọt; một bản vá kéo BPCER xuống mà đẩy APCER lên là bản vá
hỏng.

#### Đích depth phải phủ đúng vùng mặt trong khung teacher đọc

CDCN++ không phân loại, nó hồi quy một bản đồ 32×32. CelebA-Spoof không có kênh depth nên
đích là một tiên nghiệm: mặt thật là bề mặt có độ nổi, đòn tấn công phẳng nên bản đồ toàn
số 0. Tiên nghiệm đó chỉ đúng **ở nơi thực sự có mặt**.

Teacher đọc crop **wide**, không đọc crop tight. Hộp mặt chiếm `1 / tỉ_lệ_thật` của mỗi
cạnh, nên ở trần 2,7× nó chỉ là **14,1% diện tích**; phần còn lại là tường, vai, hậu cảnh.

Một gò Gauss phủ cả khung đặt phần lớn tín hiệu ra ngoài mặt:

| `sigma` | Khối lượng đích nằm trên mặt | Nằm trên nền |
|---|---|---|
| 0,28 — gò phủ cả khung | 28,8% | **71,2%** |
| 0,104 — thu theo cạnh hộp | 86,4% | 13,6% |
| **mask hộp mặt + gò** | **100%** | 0% |

L1 tính trên toàn bản đồ, nên tỉ lệ khối lượng cũng là tỉ lệ tín hiệu loss. Với gò phủ cả
khung, **71,2% của loss dạy model về phần nền**: mẫu live bắt bức tường phía sau nhận giá
trị "bề mặt sống", mẫu spoof bắt chính bức tường đó bằng 0. CelebA-Spoof quay live và spoof
trong cùng những căn phòng, nên đó là ép phần nền mang nhãn lớp — đúng đường tắt bối cảnh
mà giám sát depth sinh ra để chặn. Bản đồ PRNet của CDCN gốc bằng 0 ngoài vùng mặt.

**Chốt: đích bằng 0 ngoài hộp mặt, gò nằm trong hộp.** Vị trí hộp biết trước bằng dựng
hình — luôn ở giữa khung, cạnh bằng `1 / tỉ_lệ_thật` của cạnh khung — nên không cần
landmark, không cần PRNet, không cần thêm dữ liệu.

**Mặt nạ dựng theo tỉ lệ thật của từng mẫu, không theo một hằng số.** Tỉ lệ wide thay đổi
theo khoảng cách (mục trên); đo trên ba shard train, hộp mặt chiếm trung bình **0,53** cạnh
khung với mẫu live và **0,58** với mẫu spoof, không phải 0,37 của trần 2,7×. Dùng một hằng
số thì gò bị đặt lệch trên phần lớn dữ liệu, và phần lệch đó rơi đúng vào vùng mặt — chỗ
duy nhất mang tín hiệu phân biệt hai lớp.

**Che mặt nạ mà giữ nguyên cách lấy trung bình thì hỏng theo chiều ngược lại.** Ngoài hộp,
live và spoof có cùng đích 0, nên toàn bộ phần phân biệt hai lớp dồn vào phần diện tích của
hộp. Lấy một trung bình trên cả bản đồ sẽ pha loãng nó theo đúng tỉ lệ đó, và bản đồ phẳng
— đáp án suy biến teacher rơi vào ở epoch đầu — chỉ còn tốn 0,0585 thay vì 0,4160.

Nên **L1 lấy trung bình riêng trong hộp và ngoài hộp rồi cộng lại**: mặt và phòng mỗi bên
một nửa số phiếu, bất kể hộp to nhỏ ra sao. Đo lại trên đích mới, cái giá của bản đồ phẳng
trở về **0,4160**, nhưng lần này toàn bộ khoản phạt đến từ vùng mặt.

Hệ quả: `live_reference_mean` phụ thuộc tỉ lệ thật, nên **mọi điểm liveness của teacher đọc
bằng trung bình bản đồ chỉ so được trong cùng một công thức đích và cùng một tỉ lệ**.
Student không bị ảnh hưởng: nó xuất logit và đọc bằng softmax, không đi qua hằng số này.

### Lớp 3 — Nén cấu trúc

| Kỹ thuật | Ghi chú |
|---|---|
| **Structured pruning** (channel/filter, tiêu chí BN-γ hoặc L1-norm) | **Chỉ dùng loại này.** Unstructured/sparse pruning **vô nghĩa trên MCU** — không có kernel sparse |
| Iterative prune → fine-tune | Cắt ≤ 20% kênh mỗi vòng, fine-tune lại, lặp |
| Khi nào bỏ qua | Cả 3 student đã rất nhỏ; nếu đo thấy accuracy tụt > 1% khi cắt 10% kênh thì **bỏ hẳn bước này** |
| Layer fusion (Conv+BN+ReLU) | **Bắt buộc** trước khi quantize — TFLite Converter làm tự động, phải mở visualizer xác nhận |

### Lớp 4 — Lượng tử hoá (chi tiết tới từng layer)

**Mức chi tiết (granularity)**

| Mức | Nội dung | Quyết định |
|---|---|---|
| Per-tensor weight | 1 scale cho cả layer | ❌ Không dùng — cả 3 model đầy depthwise conv, range giữa các kênh lệch rất lớn |
| **Per-channel (per-axis) weight** | Mỗi output channel 1 scale | ✅ **Bắt buộc**, TFLite hỗ trợ sẵn, không cần code thêm |
| Activation | Luôn per-tensor (phân bố đổi theo runtime, không cố định như weight) | Không có lựa chọn khác trên TFLite |
| **Mixed-precision theo layer** | Giữ FP32/FP16 cho layer nhạy | Chỉ dùng nếu QAT + per-channel vẫn chưa đạt. Ưu tiên giữ float: **conv đầu tiên** và **layer embedding/logits cuối** |
| INT16 activation × INT8 weight | TFLite có chế độ này | Dự phòng cho MobileFaceNet nếu embedding lệch nhiều; ⚠️ kernel INT16 của ESP-NN hạn chế → chậm hơn |

**Kỹ thuật bổ trợ**

| Kỹ thuật | Vì sao cần |
|---|---|
| **Cross-Layer Equalization (CLE)** | Cân bằng range weight giữa các layer liền kề bằng phép scale tương đương — **cứu accuracy depthwise conv rất mạnh**, làm trước PTQ, không cần train lại |
| **Bias correction / bias absorption** | Bù sai số trung bình do quantize gây ra ở bias — miễn phí, luôn nên làm |
| **AdaRound** | Học cách làm tròn weight (lên/xuống) thay vì round-to-nearest — nâng PTQ gần bằng QAT mà không cần nhãn |
| **BRECQ** | Tái tạo theo từng block, mạnh hơn AdaRound; dùng nếu AdaRound chưa đủ |
| **Chọn thuật toán calibration** | `min-max` (nhạy outlier) vs **`percentile 99.9%`** vs `MSE` vs `KL/entropy` — thử cả 4, chọn theo accuracy. 300–500 ảnh calib là đủ |
| **QAT với LSQ (Learned Step Size)** | Học luôn scale factor, hội tụ tốt hơn fake-quant thường |
| **Quantization-aware KD** | Sau khi bật fake-quant, distill lại từ chính bản FP32 của mình (self-distillation) — bù phần lớn sụt accuracy |
| **Layer-wise sensitivity analysis** | Chạy `tf.lite.experimental.QuantizationDebugger`, lấy RMSE/cosine từng layer → xếp hạng độ nhạy. **Đây là dữ liệu để quyết mixed-precision**, không đoán mò |

### Lớp 5 — Runtime ESP32-S3

| Kỹ thuật | Chi tiết |
|---|---|
| **Arena ở RAM nội, không PSRAM** | ESP-NN đo person_detection trên S3: **2300 ms → 54 ms** khi bật ESP-NN + arena ở RAM nội. Arena ở PSRAM chậm hơn nhiều lần. 🔬 Đo cả 2 |
| **Align 16 byte** | `heap_caps_aligned_alloc(16, size, MALLOC_CAP_INTERNAL)` — SIMD của LX7 yêu cầu |
| **Quy tắc arena** | Xem §3.10 — không phải `max(3)` cũng không phải tổng của 3. Công thức đúng: **Σ tail + max(head)** khi 3 interpreter dùng chung một `MicroAllocator` |
| **Model nằm trong flash, mmap** | `esp_partition_mmap(models_part, ..., ESP_PARTITION_MMAP_DATA, &ptr)` → trọng số đọc thẳng từ flash qua cache, **tốn 0 byte RAM**. Không nhúng model thành mảng C trong firmware |
| **`MicroMutableOpResolver` riêng từng model** | Chỉ đăng ký đúng op cần → giảm vài chục KB flash so với `AllOpsResolver` |
| Cấu hình sdkconfig | `CONFIG_ESP32S3_INSTRUCTION_CACHE_32KB` · `CONFIG_ESP32S3_DATA_CACHE_64KB` · `CONFIG_SPIRAM_SPEED_80M` · `CONFIG_SPIRAM_MODE_OCT` · `CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_240` · `CONFIG_COMPILER_OPTIMIZATION_PERF` |
| Hot path vào IRAM | Hàm hậu xử lý (NMS, affine warp) đặt `IRAM_ATTR` nếu profiler chỉ ra nghẽn |
| Chạy tuần tự + early exit | ToF không thấy người → **không chạy model nào**. Detect không thấy mặt → **dừng**, không chạy spoof/recog. Spoof fail → không chạy recog. Tiết kiệm ~70% năng lượng |
| Cache embedding | Chỉ chạy recog khi spoof pass **và** box ổn định qua 2 frame liên tiếp |

### Lớp 6 — Đo lường (làm song song, không để cuối)

| Chỉ số | Cách đo |
|---|---|
| Arena thật từng model | `interpreter->arena_used_bytes()` ngay sau `AllocateTensors()` |
| Latency từng model | `esp_timer_get_time()` bọc quanh `Invoke()` |
| Latency từng **op** | `tflite::MicroProfiler` — chỉ ra op nào không có kernel ESP-NN |
| RAM đỉnh toàn hệ | `heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL)` + `MALLOC_CAP_SPIRAM` |
| Watermark stack từng task | `uxTaskGetStackHighWaterMark()` — chỉnh lại stack cho khít |
| Accuracy trên thiết bị | Firmware chế độ `bench`: đọc ảnh từ LittleFS → chạy pipeline → trả kết quả qua UART/HTTP cho `ml/bench/device_client.py` so với ground truth |
| Nhiệt độ + dòng | Đo dòng thật lúc Wi-Fi TX + AI + loa cùng lúc |

### 3.7 Bảng đối chứng A — có teacher hay không có teacher

Không mặc định KD tốt hơn. **Phải chứng minh bằng số**, và nếu KD không thắng thì chọn bản không teacher — nhẹ hơn, train nhanh hơn, ít phụ thuộc license teacher hơn.

**Ba nhánh chạy độc lập, mỗi nhánh làm đủ bảng này.**

| Arm | Cách train | Ghi vào run |
|---|---|---|
| **A0** | Student, random init, **chỉ task loss** trên nhãn thật | `arm=baseline` |
| **A3** | A0 + **toàn bộ KD của nhánh**: logit + feature + phần đặc thù — localization+FGD (detect) · depth map + contrastive depth (spoof) · RKD (recog) | `arm=kd_full` |

**Đúng hai arm, không có mốc trung gian.** Bảng này trả lời một câu duy nhất: *KD có
đáng dùng cho nhánh này không*. Đó cũng đúng là câu quyết định model nào đem ship.

Cái bị bỏ phải nói rõ trong báo cáo: bảng **không** trả lời được *thành phần nào của KD
tạo ra chênh lệch*. Muốn biết điều đó thì phải có các mốc chỉ-logit và chỉ-feature, tức
gấp đôi số lần train mỗi nhánh. Với ngân sách thời gian hiện tại, đổi lấy phần phân tích
đó là không đáng — nhưng **không được trình bày kết quả 2 arm như thể đã tách được đóng
góp của từng thành phần**.

Nếu về sau còn thời gian, thêm arm là chuyện cộng thêm dòng, không phải làm lại: giữ
nguyên seed và `split.lock` thì mọi arm mới so được thẳng với hai arm đã có.

**Điều kiện so sánh công bằng — sai một cái là bảng vô nghĩa:**

| Phải giống hệt nhau | Được khác |
|---|---|
| Kiến trúc student, seed khởi tạo | Hàm loss |
| `split.lock` (cùng tập train/val/test) | Có nạp teacher hay không |
| Augment, optimizer, lịch learning rate | Thời gian train mỗi bước |
| Số epoch, tiêu chí chọn checkpoint tốt nhất | |
| Tập test cuối để báo cáo | |
| `train.compile` — bật hay tắt | |

`train.compile` nằm ở cột trái vì `torch.compile` gộp và thay kernel, nên đổi kết quả ở
chữ số cuối. Hai arm khác nhau ở khoá này thì chênh lệch đo được lẫn với chênh lệch do
kernel, không tách ra được. Giá trị của nó có trong `config.resolved.yaml` của từng run —
đó là chỗ để kiểm lại khi đọc bảng.

Arm có KD tốn thêm một lần forward của teacher mỗi bước. Giữ **cùng số epoch** rồi **ghi rõ chi phí chênh lệch** — đó là cách so chuẩn cho báo cáo, đừng cân bằng bằng GPU-hour rồi cho A0 nhiều epoch hơn.

Chạy **3 seed** nếu đủ thời gian, báo cáo trung bình ± độ lệch. Không đủ thì 1 seed và ghi rõ là 1 seed — chênh lệch dưới 0,3% với 1 seed thì không kết luận được gì.

**Quy tắc chọn**: so bằng **accuracy sau INT8 trên tập `test_device`**, không phải accuracy FP32 trên val. Cái chạy trên board mới là cái tính. Chênh lệch dưới ngưỡng nhiễu → chọn A0 vì đơn giản hơn.

Kết quả ghi vào `docs/measurements/<nhánh>/ablation_teacher.md`, và quyết định ghi thành một ADR trong `docs/adr/`.

---

### 3.8 Bảng đối chứng B — thang lượng tử hoá

Chạy trên arm thắng ở §3.7. **Đúng 4 mốc**, đi từ rẻ đến đắt, dừng ngay khi đạt ngưỡng.

| ID | Cấu hình | Vai trò |
|---|---|---|
| **Q0** | FP32 | Trần. Mọi con số dưới đây tính theo % so với Q0 |
| **Q1** | **PTQ**: per-channel weight + calib percentile 99.9% + **CLE** + **bias correction** | Mốc thực dụng — không cần train lại, không cần nhãn |
| **Q2** | **QAT + LSQ** + quantization-aware KD | Train lại có nhận thức lượng tử hoá |
| **Q3** | Bản thắng giữa Q1/Q2 + **mixed-precision theo §3.9** | Giữ float vài layer nhạy nhất |

Bốn mốc kể một mạch truyện rõ: **trần → rẻ → đắt → mổ từng lớp**. Trả lời được ba câu hỏi mà hội đồng sẽ hỏi: lượng tử hoá mất bao nhiêu, train lại có bù được không, và mổ từng lớp có đáng không.

**Vì sao Q1 gộp cả CLE và bias correction** thay vì tách thành nhiều dòng: cả hai đều **không cần train lại, không cần nhãn, chạy trong vài phút**, và đều nhắm đúng điểm yếu của depthwise conv — thứ chiếm phần lớn cả 3 model. Tách ra chỉ làm bảng dài mà không thêm kết luận nào. Ghép vào cho Q1 thành "PTQ tốt nhất khả thi", để phép so với Q2 trả lời đúng câu hỏi đáng hỏi: *QAT có đáng công train lại không*.

**Bốn thuật toán calibration** (min-max · percentile · MSE · entropy) vẫn thử, nhưng là **sweep nội bộ khi dựng Q1**, không phải 4 dòng trong bảng chính. Đổi thuật toán calib chỉ là chạy lại converter, tính bằng phút chứ không phải giờ. Chọn cái thắng, ghi cả 4 số vào phụ lục `docs/measurements/<nhánh>/calib_sweep.md`.

**AdaRound và BRECQ nằm ngoài bảng.** Chỉ đụng tới nếu Q2 cũng không đạt và không muốn hạ độ phân giải — khi đó ghi thành một dòng Q1b riêng.

Mỗi dòng ghi đủ **5 cột** vào `docs/measurements/<nhánh>/quant_ladder.md`:

| Q | Accuracy (chỉ số của nhánh) | Δ so với Q0 | Kích thước `.tflite` | 🔬 head arena | 🔬 latency trên board |
|---|---|---|---|---|---|

**Quy tắc chọn**: mốc **rẻ nhất** thoả cả ba ngưỡng — accuracy sụt < 1% so với Q0, arena vừa chỗ đã định ở §3.10, latency đạt ngân sách. Q1 đạt thì dừng, không chạy Q2 cho đẹp bảng.

---

### 3.9 Đi sâu từng lớp — chọn layer giữ float

Chỉ chạy khi Q1 và Q2 ở §3.8 đều chưa đạt ngưỡng. Đây là mốc Q3.

**Bước 1 — đo độ nhạy từng layer.** `tf.lite.experimental.QuantizationDebugger` chạy trên tập calib, xuất RMSE và cosine similarity giữa đầu ra FP32 và INT8 của **từng layer**:

```
artifacts/<nhánh>/reports/layer_sensitivity.csv
layer_name, op_type, rmse, cosine, weight_range_ratio, output_channels
```

`weight_range_ratio` = max/min của range trọng số giữa các output channel. Tỉ lệ cao ở depthwise conv là dấu hiệu CLE chưa xử lý hết.

**Bước 2 — xếp hạng và quét.** Sắp giảm dần theo RMSE, giữ float `k` layer đầu bảng, quét `k = 0, 1, 2, 3, 5, 8`:

| k | Layer giữ float | Accuracy | Kích thước | 🔬 head arena | 🔬 latency |
|---|---|---|---|---|---|

**Bước 3 — chọn điểm gãy**, không chọn `k` lớn nhất. Thường `k = 1–2` lấy lại phần lớn accuracy; từ `k = 3` trở đi accuracy tăng không đáng kể mà arena và latency phình nhanh vì layer float không có kernel ESP-NN.

**Dự đoán cần kiểm chứng** (ghi vào báo cáo dù đúng hay sai): layer nhạy nhất thường là **conv đầu tiên** (nhận ảnh thô, range rộng) và **layer embedding/logits cuối** (đầu ra cần độ phân giải cao). Nếu đo ra khác thì đó là kết quả đáng viết.

**Ràng buộc bắt buộc**: mọi layer giữ float phải kiểm bằng `tflite_op_check.py` xem TFLM có kernel không. Layer float rơi vào kernel C tham chiếu thì chậm gấp 10–40 lần, đánh mất toàn bộ lợi ích.

---

### 3.10 Arena dùng chung — công thức đúng

TFLM chia arena làm hai vùng, và chỉ một trong hai vùng dùng lại được:

| Vùng | Chứa gì | Khi 3 model dùng chung 1 `MicroAllocator` |
|---|---|---|
| **Tail** (persistent) | Metadata `TfLiteTensor`, dữ liệu node/registration, variable tensor — sống suốt vòng đời model | **Cộng dồn**. Mỗi model xếp chồng lên nhau, không nhả ra |
| **Head** (non-persistent) | Activation, scratch buffer — chỉ sống trong một lần `Invoke()` | **Dùng chung, lấy `max`**. Đúng vì 3 model chạy tuần tự |

```
arena_total  =  tail_det + tail_spoof + tail_recog  +  max(head_det, head_spoof, head_recog)
```

Cách làm: tạo **một** `MicroAllocator::Create(arena, size)` rồi truyền **cùng con trỏ allocator đó** vào cả 3 `MicroInterpreter` (constructor có overload nhận `MicroAllocator*`). Không tạo 3 buffer rời, cũng không hủy/tạo lại interpreter mỗi lần đổi model.

Tail nhỏ hơn head nhiều — cỡ vài chục KB mỗi model (metadata theo số tensor và số node), còn head là nơi activation nằm. Nhưng tail **không** biến mất khi đổi model, nên đừng bỏ qua nó khi tính ngân sách.

**Hệ quả cho dự án này**, sau khi đo thật (`docs/measurements/arena.md`): chốt **hai arena**, chia theo **tần suất chạy**, không phải theo tốc độ mong muốn:

| Arena | Ở đâu | Dùng cho | Kích thước |
|---|---|---|---|
| `arena_fast` | **SRAM nội**, align 16 B | **detect một mình**, `MicroAllocator` riêng | `tail_det + head_det` = **185 KB** đo thật |
| `arena_big` | **PSRAM**, align 16 B | **anti-spoof + recognition**, dùng chung 1 `MicroAllocator` | `Σ tail + max(head)` 🔬 |

Ba số đo dẫn tới cách chia này:

1. **SRAM chỉ mua được 4–10%.** Đưa toàn bộ activation của detect và spoof về SRAM nội chỉ cắt 1,9% của cả chuỗi. Băng thông PSRAM không phải nút thắt, phép tính trong kernel mới là.
2. **detect chạy mỗi frame, hai nhánh kia chạy mỗi lần có người.** Nên 10% của detect là 10% liên tục, còn 4% của spoof chỉ xuất hiện lúc có mặt. Chỗ SRAM đắt thì đưa cho thằng chạy nhiều nhất.
3. **spoof + recog gộp lại không vừa SRAM bằng cách nào cả.** Ép chúng vào `arena_fast` thì cả hai cùng trượt, và `arena_fast` phải phình tới mức không còn chỗ cho Wi-Fi lẫn stack task.

detect một mình cần 185 KB thay vì 512 KB mà vẫn không đủ, nên cách chia này là thứ **làm cho hệ chạy được**, không chỉ nhanh hơn.

Ba con số `tail` và ba con số `head` phải đo thật ở E8, không suy ra từ `arena_used_bytes()` tổng.

**Tách `head` và `tail` khi cả arena không vừa SRAM nội.** `MicroAllocator::Create` có bản nhận **hai** buffer rời: một cho vùng persistent (`tail`) và một cho vùng non-persistent (`head`). Vì `head` là chỗ activation nằm — thứ mỗi lần `Invoke()` quét đi quét lại — còn `tail` chỉ là metadata đọc một lần mỗi node, nên khi cả `arena_fast` không vừa SRAM nội thì đặt **`head` ở SRAM nội, `tail` ở PSRAM** vẫn giữ được phần nóng ở bộ nhớ nhanh. Khai bằng `AI_ARENA_FAST_HEAD_KB`: bằng 0 thì một buffer như cũ, lớn hơn 0 thì tách. Mức thu được phải đo, không suy ra — số nằm ở `docs/measurements/latency.md`.

**`ai_engine_init()` phải chạy trước mọi driver.** Ràng buộc thật của `arena_fast` không phải tổng RAM nội còn trống mà là **một dải liền mạch**: `heap_caps_aligned_alloc` không ghép được nhiều mảnh rời. Đo trên board (`docs/measurements/arena.md`): xin sau `drv_camera_init()` thì còn 192 KB trống nhưng mảnh to nhất chỉ 143 KB, arena 175 KB **lùi xuống PSRAM**; xin ngay sau `sys_storage_init()` thì nằm gọn SRAM nội, và LCD, touch, camera vẫn init đủ với 118 KB còn lại. Arena là chỗ duy nhất trong hệ xin một dải lớn như vậy, nên nó xin đầu tiên.

### Pipeline train

```
[1] Kiến trúc student (ReLU6, kênh bội 8, kiểm tra op TFLM)
         │  random init — KHÔNG load .pth có sẵn
         ▼
[2] Teacher: freeze → sinh soft target (+ feature map + depth map + embedding)
         │
         ▼
[3] KD nhiều giai đoạn:  feature → +logit/localization → +task loss
         │
         ▼
[4] Student FP32  ──🔬 đo accuracy gốc (mốc so sánh)
         │
         ├─(tùy chọn)→ Structured pruning → fine-tune  ── bỏ nếu tụt >1% khi cắt 10%
         ▼
[5] Fold Conv+BN → CLE → Bias correction
         │
         ▼
[6] Q1 — PTQ per-channel + CLE + bias correction (calib 300 ảnh OV5640)
         │
    🔬 sụt accuracy < 1%? ──Có──┐
         │Không                  │
         ▼                       │
[7] Q2 — QAT + LSQ + quantization-aware KD
         │                       │
    🔬 vẫn chưa đạt?              │
         ▼                       │
[8] Q3 — sensitivity analysis → mixed-precision (giữ float layer nhạy nhất)
         │                       │
         └───────────┬───────────┘
                     ▼
[9] Student INT8 → ONNX → onnx2tf → .tflite
                     ▼
[10] tflite_op_check.py — mọi op có trong MicroMutableOpResolver chưa?
                     ▼
[11] Gộp 3 .tflite thành 1 image cho partition `models_0` → flash
                     ▼
[12] 🔬 Trên board: arena_used_bytes, latency/op, RAM đỉnh, accuracy ảnh thật
                     ▼
              Đạt? ──Không──► quay lại bước tương ứng (5 / 7 / 1)
                     ▼ Có
                   CHỐT
```

---

## 4. Cấu trúc repo

### 4.1 Tổng thể

```
esp32s3-face-attendance/
├── .github/
│   └── workflows/{contracts.yml, ml.yml, firmware.yml, backend.yml, frontend.yml}
│                   ★ GitHub Actions CHỈ đọc .github/workflows ở gốc repo
├── .gitignore  ├── .gitattributes  ├── .editorconfig  ├── .pre-commit-config.yaml
├── README.md   ├── LICENSE         ├── Makefile
├── CLAUDE.md                       ★ quy tắc làm việc — gitignore, chỉ có ở máy local
│
├── contracts/     Hợp đồng dùng chung — nguồn sự thật duy nhất cho 3 khối
├── ml/            Python — train, KD, quantize, export
├── firmware/      ESP-IDF — C + C++
├── backend/       NestJS
├── frontend/      Next.js → Vercel
├── deploy/        Docker Compose, traefik — CHỈ hạ tầng chạy, KHÔNG chứa CI
├── tools/         Script ngang khối: gen_from_schema · check_comments · check_layers
└── docs/
    ├── KE_HOACH_face_attendance_esp32s3.md      # kiến trúc — nguồn sự thật
    ├── TASKS.md                                 # backlog
    ├── DU_LIEU.md                               # dữ liệu đã tải và xử lí — số đo trên đĩa
    ├── adr/{0001-yunet-thay-ulfg.md, ...}       # quyết định kiến trúc, mỗi cái 1 file
    ├── measurements/{arena.md, latency.md, power.md}   # số 🔬 đo được trên board
    └── thesis/                                  # bản báo cáo ĐATN
```

| File gốc | Vai trò |
|---|---|
| `.editorconfig` | Thống nhất indent/EOL cho 4 ngôn ngữ. Không có thì diff đầy nhiễu whitespace |
| `.gitattributes` | `* text=auto eol=lf`, `*.tflite binary`, `*/generated/* linguist-generated` |
| `.pre-commit-config.yaml` | Chạy `check_comments` · `ruff` · `clang-format` · `prettier` trước khi commit |
| `Makefile` | Điểm vào duy nhất: `make gen` · `make lint` · `make train-det` · `make flash` |

Ba khối `ml` / `firmware` / `backend+frontend` **không bao giờ copy định nghĩa của nhau**. Payload MQTT, danh sách model đang deploy, vector kiểm thử — tất cả nằm ở `contracts/`, mỗi bên sinh code từ đó. Đây là thứ giữ monorepo không rữa sau vài tháng.

### 4.2 `contracts/` — nguồn sự thật duy nhất

```
contracts/
├── schema/                              # JSON Schema — viết 1 lần, sinh ra 3 ngôn ngữ
│   ├── attendance_record.schema.json
│   ├── heartbeat.schema.json
│   ├── device_event.schema.json
│   ├── device_cmd.schema.json
│   ├── enroll_payload.schema.json
│   └── ota_manifest.schema.json
├── mqtt_topics.yaml                     # topic + QoS + retained + chiều + schema tương ứng
├── golden/                              # ✅ COMMIT — vector vàng: Python sinh, C kiểm
│   ├── detection/{decode/, nms/}         #   {in_000.npz, out_000.npz, ...} trong mỗi thư mục
│   ├── antispoof/{preproc/}
│   └── recognition/{align/, l2norm/, cosine/}
├── models.lock.json                     # model đang deploy: name, version, sha256, run_id
└── README.md
```

`tools/gen_from_schema.sh` sinh ra:

| Đích | File sinh ra | Ai dùng |
|---|---|---|
| TypeScript | `backend/src/common/generated/*.ts` | DTO + validation của NestJS |
| TypeScript | `frontend/types/generated/*.ts` | React |
| C header | `firmware/components/common/include/gen_payload.h` | struct + hàm serialize/parse |

**File sinh ra không được sửa tay.** CI chạy lại generator rồi `git diff --exit-code` — lệch là fail.

`golden/` giải bài toán "hậu xử lý Python phải khớp 1:1 với C": `ml/export/emit_golden.py` xuất tensor đầu vào + kết quả mong đợi ra `.npz`; `firmware/test_apps/parity` đọc **chính file đó** và so sánh trên board. Lệch ở decode anchor / NMS / affine warp lộ ra ngay, không phải mò lúc tích hợp.

`models.lock.json`:
```json
{
  "detection":   { "file": "yunet_int8.tflite",       "sha256": "a3f9...", "run_id": "detection/20260915-1420_7c3ab91_e04f12", "arena_bytes": 121344 },
  "antispoof":   { "file": "minifasnet_int8.tflite",  "sha256": "77c1...", "run_id": "antispoof/20260921-0905_1de44f0_9ab301", "arena_bytes": 58880 },
  "recognition": { "file": "mobilefacenet_int8.tflite","sha256": "0b52...", "run_id": "recognition/20260908-2210_3f8c012_44ee9a", "arena_bytes": 297984 }
}
```

### 4.3 Quy ước áp dụng cho cả repo

| Loại | Ví dụ | Git |
|---|---|---|
| Source | code, config YAML, schema, file split `.txt`, asset gốc (font, WAV, icon) | ✅ commit |
| Sinh từ `contracts/schema/` | `*/generated/*`, `gen_payload.h` | ✅ commit — không sửa tay, CI sinh lại rồi `git diff --exit-code` |
| Sinh ra từ source, sinh lại được tại chỗ | `sdkconfig`, `managed_components/`, `build/` | ❌ gitignore |
| Artifact nặng | checkpoint, `.onnx`, `.tflite`, ảnh dataset | ❌ gitignore — lưu ngoài (NAS/S3), ghi sha256 vào lock file |
| Dữ liệu thô | dataset tải về | ❌ gitignore — mô tả trong `manifest.yaml` |
| Cấu hình công cụ AI agent | `CLAUDE.md`, `.claude/`, `.cursor/` | ❌ gitignore — chỉ tồn tại ở máy local |

Bốn thứ **bắt buộc commit** dù là dữ liệu hoặc code sinh tự động: `contracts/golden/` (vài trăm KB), `ml/data/splits/`, `contracts/models.lock.json`, và toàn bộ code sinh từ `contracts/schema/`. Mất chúng là mất khả năng tái lập, hoặc mất chốt chặn giữ ba khối khớp nhau.

---

### 4.4 `ml/` — Python

#### 4.4.1 Tách dữ liệu ra khỏi code

Dataset hàng trăm GB không nằm trong repo. `ml/data/` là **thư mục dữ liệu**, gitignore toàn bộ trừ `README.md`, `splits/`, `**/manifest.yaml`. Đường dẫn thật khai trong `configs/common/paths.yaml`, có thể symlink sang ổ khác.

**Ba tầng dữ liệu — không bao giờ trộn:**

| Tầng | Nội dung | Quy tắc bất di bất dịch |
|---|---|---|
| `raw/` | Đúng như lúc tải về | **Read-only.** Không script nào được ghi vào đây |
| `interim/` | Đã giải nén / đổi định dạng (`.rec` → shard jpg, WIDER → COCO json) | Sinh lại được từ `raw/` bằng 1 lệnh |
| `processed/` | Sẵn sàng nạp DataLoader (crop align 112×112, webdataset shard) | Sinh lại được từ `interim/` bằng 1 lệnh |

Nếu một thư mục không sinh lại được bằng script thì nó đang nằm sai tầng.

**Hai ổ — quyết định bằng việc tập dữ liệu có vừa page cache hay không**

Ba tầng ở trên chia theo *vòng đời*. Chỗ đặt file là chuyện khác hẳn, và nó chỉ có một
câu hỏi: **tập dữ liệu có vừa page cache không?** Ổ khai ở `paths.yaml`:

| Khoá | Đường dẫn | Dành cho |
|---|---|---|
| `cold_drive` | `/mnt/e/face-attendance-data` — ổ Windows qua **drvfs** | Bản tải về, và mọi tập **lớn hơn page cache** |
| `fast_drive` | `/data/face-attendance` — ảnh **ext4** đặt trên chính ổ đó | Tập **nhỏ hơn page cache** mà vòng train đọc lại mỗi epoch |

`fast_drive` là một file `E:\wsl-data.img` được `mount -o loop` vào `/data`, khai trong
`/etc/fstab` để còn sống sau `wsl --shutdown`. Dữ liệu vẫn nằm vật lý trên `E:`; khác biệt
là WSL đọc nó bằng ext4 native thay vì qua giao thức drvfs.

Số đo trên máy này, cùng một tập ảnh, cùng vòng đọc:

| Cách đọc | drvfs | ext4 loop |
|---|---|---|
| File nhỏ (~115 KB), cache **lạnh** | 90,8 ảnh/s | 141,8 ảnh/s |
| File nhỏ (~115 KB), cache **nóng** | 255 ảnh/s | **38.856 ảnh/s** |
| File lớn, đọc tuần tự | **197 MB/s** | 33 MB/s |

Hai đường này **cắt nhau**, nên không có ổ nào thắng tuyệt đối:

- **drvfs không được page cache của Linux giữ.** Đọc lại tập cũ vẫn phải qua Windows,
  mỗi epoch, mãi mãi — 255 ảnh/s là trần. File trên ext4 thì được giữ như file thường,
  nên từ epoch 2 trở đi gần như miễn phí: nhanh hơn **152×**.
- **ext4 trên loopback có trần băng thông ~33 MB/s**, vì mọi block của nó vẫn phải đi qua
  drvfs. Nâng readahead của loop device từ 128 KB lên 4 MB **không đổi gì** — đã thử.
- drvfs đắt ở **số lần mở file** (~15 ms mỗi lần), không ở số byte.

Nên: tập vừa cache thì ext4 thắng áp đảo nhờ được cache; tập không vừa cache thì đằng nào
cũng phải đọc lại từ đĩa mỗi epoch, và lúc đó drvfs thắng nhờ băng thông gấp 6 lần.

**Trần cache là con số phải tính, không được đoán.** WSL được cấp 10 GB, tiến trình train
chiếm ~2,5 GB, nên phần còn lại cho page cache là **~7 GB**.

**Symlink không cứu được gì.** Một symlink đặt trên drvfs trỏ sang ext4 vẫn bắt mỗi lần
`open()` trả tiền tra cứu drvfs trước. Muốn drvfs ra khỏi vòng lặp thì **cả mục lục lẫn
payload** phải nằm trên `fast_drive`. Khi bố cục Ultralytics và ảnh gốc cùng nằm trên
`fast_drive` thì dùng **hardlink**: cùng inode, tốn 0 byte và 0 lần tra cứu thêm.

**Luật xếp dữ liệu**

| Nhánh | Đọc mỗi epoch | Cỡ tập | Dạng đúng | Ổ |
|---|---|---|---|---|
| Detection **teacher** | 11.618 ảnh × 4 (mosaic) | 1,5 GB | file lẻ **ảnh gốc** — Ultralytics chỉ nhận dạng này, và nó train ở 640 có scale augment | `fast_drive` |
| Detection **student** | 11.618 ảnh | **394 MB** | file lẻ **đã thu nhỏ cạnh dài 320** | `fast_drive` |
| Anti-spoof | **419.935 mặt × 2 tỉ lệ** | 8,2 GB | **shard**, hai tỉ lệ **cùng một record** | `cold_drive` |
| Recognition | 5.179.510 ảnh | 36 GB | shard — mirror đã sẵn dạng này | `cold_drive` |

**Student detection dùng file lẻ chứ không shard, và đó là ngoại lệ có lý do.** Luật shard ở
trên tồn tại để né phí mở file 15 ms của drvfs; `fast_drive` đã xoá phí đó (cache nóng cho
38.856 ảnh/s). Với 11.618 ảnh nằm gọn trong page cache thì shard không mua thêm gì, mà lại
đổi `Dataset` lấy `IterableDataset` — mất trộn mẫu ở mức từng ảnh, chỉ còn trộn theo bộ đệm.

Thứ **thật sự** mua được tốc độ ở nhánh này là **thu nhỏ ảnh**, vì nghẽn là giải nén chứ
không phải mở file. Số đo:

| | ảnh/s (chỉ đọc) | ảnh/s (đọc + train) | epoch |
|---|---|---|---|
| Ảnh gốc 1,4 GB | 258 | 271 | 28 s |
| **Thu nhỏ 320, 394 MB** | **1.135** | **1.111** | **10 s** |

`shrink_coco.py` thu ảnh **và** tỉ lệ lại toạ độ trong cùng một lần quét. Làm hai lần, hoặc
resize mà quên nhãn, cho ra tập dữ liệu vẫn nạp được, vẫn train được, và **sai đúng một hệ
số ở mọi khuôn mặt** — không có gì báo lỗi.

Cả hai arm A0 và A3 phải dùng **cùng một** tập đã thu nhỏ; đó là điều kiện của §3.7.

Detection là nhánh **duy nhất** không đóng shard được, vì Ultralytics đọc file lẻ; may là
nó cũng là nhánh duy nhất đủ nhỏ để nằm trọn trong page cache. Hai nhánh còn lại vượt xa
trần 7 GB nên đặt trên `fast_drive` chỉ đổi băng thông 197 MB/s lấy 33 MB/s: recognition
sẽ mất **18,6 phút mỗi epoch** thay vì **3,1 phút**, đổi lại không được gì.

Ở 150 file/s, riêng việc mở file của anti-spoof đã tốn **~93 phút mỗi epoch**, trong khi
model 0,53M tham số tính xong trong vài giây. Đóng gói thành shard là chênh lệch giữa
nhánh đó mất mười ngày hay một ngày. Gói hai tỉ lệ vào một record thì một epoch trả tiền
419.935 lần đọc chứ không phải 839.870.

Record trong shard gom theo **dấu chấm đầu tiên** của tên member — đúng quy ước
WebDataset mà shard MS1MV3 đang dùng (`{key}.jpg` + `{key}.cls`). Đó là thứ cho phép một
record chở nhiều payload: `{key}.tight.jpg` + `{key}.wide.jpg` + `{key}.json`.

**Resize sẵn chỉ khi vô hại.** Ảnh trong shard được resize về đúng kích thước train *chỉ
khi* pipeline train không có augment phóng to — nếu có, resize là âm thầm bớt thông tin
model đáng lẽ được thấy. Teacher detection có mosaic và scale augment ở 640, nên **giữ ảnh
gốc**.

**Student detect cũng giữ ảnh gốc**, vì §3 Lớp 2 đã đưa `crop_scale` `[0.3, 1.0]` vào công
thức của nó. Cắt 30% của bản 320 px rồi đưa về 160 px là **phóng 1,67×** — bịa pixel; cắt
30% của ảnh gốc 1024 px cho 307 px rồi thu về 160 px, chi tiết thật. Bản `widerface_small`
đúng cho công thức không có augment phóng to và hết đúng khi có; đo được cái giá của nó là
epoch 19 giây so với 28.

> **Tối ưu cách xếp, không tối ưu giao thức.** Được phép đổi: bố cục file, số worker,
> kích thước shard, thứ tự đọc. **Không được đổi để chạy nhanh hơn**: split (§1.3),
> điều kiện so sánh của bảng đối chứng (§3.7), tập calib tách khỏi test, hay việc đo
> accuracy sau INT8 trên `test_device`. Nhanh mà mất một trong số đó là hỏng cả kết quả.

#### 4.4.2 Chia theo bài toán trước, theo dataset sau

```
ml/data/                                      # gitignore, trừ 3 loại file đánh ✅
├── README.md                                 # ✅ cái gì phải nằm ở đâu, lệnh nào sinh ra
│
├── raw/
│   ├── detection/
│   │   ├── widerface/
│   │   │   ├── {WIDER_train, WIDER_val, WIDER_test, wider_face_split}/
│   │   │   ├── eval_tools/ground_truth/      # ★ Easy/Medium/Hard — thang do cua muc 0.80
│   │   │   └── manifest.yaml                 # ✅
│   │   └── retinaface_labels/
│   │       ├── {train, val, test}/label.txt
│   │       └── manifest.yaml                 # ✅
│   ├── antispoof/
│   │   ├── celeba_spoof/                     # parquet, mirror Ar4ikov
│   │   │   ├── data/*.parquet
│   │   │   └── manifest.yaml                 # ✅
│   │   └── xdomain/                          # ★ test khác miền, thay 4 bộ phải ký giấy
│   │       ├── nuaa/          + manifest.yaml    # ✅ ảnh in
│   │       ├── unique_live/   + manifest.yaml    # ✅ live đối chứng
│   │       ├── unique_replay/ + manifest.yaml    # ✅ màn hình phát lại
│   │       └── axon_masks/    + manifest.yaml    # ✅ video, mặt nạ latex 3D
│   ├── recognition/
│   │   ├── ms1mv3/{train.rec, train.idx, property}     + manifest.yaml   # ✅ mặc định
│   │   ├── glint360k/glint360k-*.tar.gz                + manifest.yaml   # ✅ webdataset sẵn
│   │   └── benchmarks/{lfw/, ...}                      + manifest.yaml   # ✅
│   └── device/                               # ★ ảnh OV5640 tự thu — dùng cho CẢ 3 nhánh
│       └── ov5640/
│           ├── images/                       # <session>_<seq>.jpg, gốc từ board
│           ├── meta/                         # <session>_<seq>.json: lux, khoảng cách, phơi sáng
│           └── manifest.csv                  # ✅ file, person_id, session, lighting,
│                                             #    distance_cm, is_spoof, spoof_type, capture_date
│
├── interim/                                  # mac dinh tren cold_drive; chi widerface_yolo
│   │                                         #   va anh WIDER goc nam tren fast_drive
│   ├── detection/widerface_coco/{train.json, val.json}      # box + 5 landmark, format COCO
│   ├── detection/widerface_yolo/{images/, labels/, data.yaml}  # ★ fast_drive: vua page cache
│   │                                             #   images/ la HARDLINK toi raw/, anh giu nguyen goc
│   ├── detection/widerface_shards/{train, val}/  # ★ shard cho student, resize san 160x120
│   ├── antispoof/celeba_spoof_crops/{train, valid, test}/shard_*.tar
│   │                                             #   1 record = tight.jpg + wide.jpg + json
│   │                                             #   ★ hop mat cat bang detection student,
│   │                                             #     KHONG dung cot Bbox cua dataset (§3)
│   ├── recognition/ms1mv3_shards/{000000.tar, ...}          # webdataset
│   │   └── record_counts.json                # ★ so ban ghi moi split giu lai, sinh tu dong
│   │                                         #   lan dau. Dem tay phai doc het 36 GB, va
│   │                                         #   lich LR can con so do TRUOC khi train
│   └── recognition/identities.txt                           # danh sach ID doc tu shard
│
├── processed/
│   ├── detection/{train_160x120/, val_640x480/}
│   ├── antispoof/{train_80x80/, val_80x80/}
│   └── recognition/{train_112x112/, val_112x112/}
│
├── splits/                                   # ✅ COMMIT TOÀN BỘ
│   ├── detection/v1/{train.txt, landmark_val.txt, SPLIT.md}
│   │                                             #   val cua WIDER dung truc tiep de do AP,
│   │                                             #   khong can file split
│   ├── antispoof/v1_upstream/{train_ids.txt, val_ids.txt, test_ids.txt, SPLIT.md}
│   ├── recognition/v1_identity_disjoint/{train_ids.txt, val_ids.txt, SPLIT.md}
│   └── device/v1/{calib_det.txt, calib_spoof.txt, calib_recog.txt, test_device.txt, SPLIT.md}
│
└── cache/                                    # LMDB/npy cache của DataLoader — xoá lúc nào cũng được
```

**`manifest.yaml`** — mỗi dataset một file. Đây chính là thứ để "lần sau lục lại":
```yaml
name: widerface
source_url: http://shuoyang1213.me/WIDERFACE/
downloaded: 2026-09-02
license: research-only
sha256:
  WIDER_train.zip: 3fedf70df8c1a2...
counts: { images: 32203, faces: 393703 }
notes: dùng annotation 5 landmark của RetinaFace, KHÔNG dùng label box gốc
consumed_by: [detection/teacher, detection/student]
```

**`SPLIT.md`** — mỗi split một file:
```
Quy tắc:  identity-disjoint, seed=42, tỉ lệ 80/10/10 theo person_id
Sinh bằng: python -m facepipe.data.make_split --task recognition --seed 42
sha256:   train_ids.txt = a3f9c1...  val_ids.txt = 77b204...
Số ID:    train 288186 / val 36023 / test 36023
```

`calib_*.txt` và `test_device.txt` **phải có test tự động kiểm tra không giao nhau** (`ml/tests/test_splits.py`). Đây là loại lỗi im lặng làm kết quả INT8 đẹp giả — calibrate trên chính ảnh dùng để test thì con số nào cũng đẹp.

#### 4.4.3 Code

```
ml/
├── pyproject.toml  ├── uv.lock            # ✅ pin phiên bản, không dùng requirements.txt rời
├── Dockerfile                             # môi trường train tái lập được
├── Makefile
├── .env.example                           # ✅ commit — HF_TOKEN và các biến, giá trị giả
├── .env                                   # ❌ gitignore — giá trị thật (§4.9)
│
├── configs/
│   ├── common/{paths.yaml, hardware.yaml}
│   ├── detection/{teacher_yolo26m_pose.yaml, student_yunet.yaml, kd.yaml, quant.yaml}
│   ├── antispoof/  (4 file cùng tên)
│   └── recognition/(4 file cùng tên)
│
├── src/facepipe/
│   ├── core/                              # ── HẠ TẦNG TRAIN: 3 nhánh cùng import ──
│   │   │   KHÔNG chứa tên nhánh nào. Không import ngược từ tasks/.
│   │   ├── registry.py                    # @register("yunet") → gọi model bằng tên trong YAML
│   │   ├── config.py                      # pydantic schema + merge YAML + override CLI
│   │   ├── trainer.py                     # vòng train chung: AMP, EMA, grad-clip, ckpt, resume
│   │   ├── distiller.py                   # TeacherWrapper + DistillLoss trừu tượng
│   │   ├── hooks.py                       # forward hook lấy feature map cho feature-KD
│   │   ├── run_dir.py                     # ★ tạo thư mục run, ghi config.resolved + env + split.lock
│   │   ├── scheduler.py  ├── metrics.py  ├── logger.py  └── seed.py
│   │
│   ├── data/
│   │   ├── datasets/{widerface.py, celeba_spoof.py, xdomain_spoof.py,
│   │   │             recognition_wds.py, ov5640_device.py}
│   │   ├── transforms/{det.py, spoof.py, recog.py, sensor_sim.py}
│   │   ├── prepare/                       # ★ raw → interim → processed
│   │   │   ├── widerface_to_coco.py
│   │   │   ├── celeba_spoof_parquet.py    # mirror CelebA-Spoof là parquet, không phải bbox.json
│   │   │   │                              #   ra thẳng shard, hai tỉ lệ trong một record
│   │   │   ├── recordio_to_wds.py         # MXNet RecordIO → shard; Glint360K đã shard sẵn
│   │   │   ├── images_to_wds.py           # ★ NƠI DUY NHẤT định nghĩa bố cục record shard
│   │   │   │                              #   ShardWriter + read_shard — dùng cho cả 3 nhánh
│   │   │   ├── shrink_coco.py             # ★ thu nho anh + ti le lai toa do trong MOT lan
│   │   │   │                              #   quet. He so scale chi ton tai o mot cho, nen
│   │   │   │                              #   khong the co anh moi voi nhan cu
│   │   │   ├── xdomain_crop.py            # bốn bộ khác miền → shard, mặt do nhánh detect tìm
│   │   │   │                              #   crop mà kiosk không tự tạo ra được thì không phải phép thử công bằng
│   │   │   └── device_index.py            # quét ov5640/images → manifest.csv
│   │   ├── make_split.py                  # ★ sinh split + ghi SPLIT.md + sha256
│   │   └── loaders.py
│   │
│   ├── tasks/                             # ── BA NHÁNH, MỖI NHÁNH MỘT THƯ MỤC ĐỘC LẬP ──
│   │   │   Cùng khuôn: README · teacher/ · student/ · losses/ · postproc/
│   │   │              · data.py · quant.py · train_kd.py · eval.py
│   │   │   ★ = file phải khớp 1:1 với bản C ở firmware, kiểm bằng contracts/golden/
│   │   │
│   │   ├── detection/
│   │   │   ├── README.md                  # teacher gì, student gì, metric gì, lệnh chạy
│   │   │   ├── teacher/
│   │   │   │   ├── yolo26_pose_wrapper.py # bọc Ultralytics → interface teacher chung
│   │   │   │   ├── finetune_widerface.py  # COCO-pretrain → WIDER FACE + 5 landmark
│   │   │   │   └── export_soft_target.py  # cache logit + feature map ra .npz shard
│   │   │   ├── student/
│   │   │   │   ├── yunet.py               # backbone + neck
│   │   │   │   ├── head.py                # 3 đầu ra: cls / bbox / 5 landmark
│   │   │   │   ├── anchors.py             # ★ sinh prior box, khớp anchors trong decode.cpp
│   │   │   │   └── blocks.py              # conv-bn-relu6, depthwise sep, kênh bội 8
│   │   │   ├── losses/
│   │   │   │   ├── kd_logit.py            # KL trên nhánh phân loại
│   │   │   │   ├── kd_localization.py     # distill cả box VÀ 5 landmark
│   │   │   │   ├── kd_feature_fgd.py      # feature imitation có mặt nạ quanh GT
│   │   │   │   └── task_loss.py           # focal + IoU + landmark L1 trên nhãn thật
│   │   │   ├── postproc/
│   │   │   │   ├── decode.py              # ★ ai_engine/src/detection/decode.cpp
│   │   │   │   ├── nms.py                 # ★ ai_engine/src/detection/nms.cpp
│   │   │   │   └── emit_golden.py         # → contracts/golden/detection/{decode,nms}/
│   │   │   ├── data.py                    # dataloader + augment riêng nhánh
│   │   │   ├── quant.py                   # tập calib + layer giữ float riêng nhánh
│   │   │   ├── train_kd.py                # điểm vào duy nhất để train nhánh này
│   │   │   └── eval.py                    # WIDER AP + NMSE landmark trên ảnh OV5640
│   │   │
│   │   ├── antispoof/
│   │   │   ├── README.md
│   │   │   ├── teacher/
│   │   │   │   ├── cdcnpp.py              # kiến trúc CDCN++ (gồm MAFM)
│   │   │   │   ├── depth_gt.py            # sinh depth map GT cho ảnh live
│   │   │   │   ├── train_teacher.py       # CelebA-Spoof, có depth supervision
│   │   │   │   └── export_soft_target.py  # cache logit + depth map 32×32
│   │   │   ├── student/
│   │   │   │   ├── minifasnet_v2_se.py
│   │   │   │   └── blocks.py              # SE dùng HardSigmoid ReLU6(x+3)/6 cho INT8
│   │   │   ├── losses/
│   │   │   │   ├── kd_logit.py
│   │   │   │   ├── kd_depth_map.py        # L1 pixel-wise trên depth 32×32
│   │   │   │   ├── contrastive_depth_loss.py
│   │   │   │   └── task_loss.py           # BCE live/spoof
│   │   │   ├── postproc/
│   │   │   │   ├── preproc.py             # ★ ai_engine/src/antispoof/preproc.cpp
│   │   │   │   └── emit_golden.py         # → contracts/golden/antispoof/preproc/
│   │   │   ├── data.py                    # patch crop 1.0×/2.7×, augment in ảnh + màn hình
│   │   │   ├── quant.py
│   │   │   ├── train_kd.py
│   │   │   └── eval.py                    # ACER, HTER cross-dataset, ROC tập tự thu
│   │   │
│   │   └── recognition/
│   │       ├── README.md
│   │       ├── teacher/
│   │       │   ├── r50_wf600k.py          # nạp arcface_torch R50, freeze
│   │       │   └── export_embedding.py    # cache embedding 512-D ra .npy memmap
│   │       ├── student/
│   │       │   ├── mobilefacenet.py
│   │       │   └── blocks.py
│   │       ├── losses/
│   │       │   ├── arcface.py             # margin loss trên nhãn thật
│   │       │   ├── kd_embedding.py        # cosine + L2 với embedding teacher
│   │       │   └── kd_relation_rkd.py     # giữ khoảng cách + góc giữa các cặp trong batch
│   │       ├── postproc/
│   │       │   ├── align.py               # ★ ai_engine/src/recognition/align.cpp
│   │       │   ├── l2norm.py              # ★ ai_engine/src/recognition/l2norm.cpp
│   │       │   ├── cosine.py              # ★ svc_facedb/src/embedding_index.cpp
│   │       │   └── emit_golden.py         # → contracts/golden/recognition/{align,l2norm,cosine}/
│   │       ├── data.py                    # webdataset Glint360K + sampler theo ID
│   │       ├── quant.py
│   │       ├── train_kd.py
│   │       └── eval.py                    # LFW/CFP-FP/AgeDB + TAR@FAR tập nhân viên
│   │
│   ├── compress/
│   │   ├── prune/{bn_gamma.py, l1_filter.py, finetune.py}
│   │   ├── quant/{fold_bn.py, cle.py, bias_correction.py, adaround.py,
│   │   │          calibrator.py, ptq_tflite.py, qat_lsq.py}
│   │   ├── sensitivity/{layer_sensitivity.py, mixed_precision_planner.py}
│   │   └── report/quant_debug.py
│   │
│   └── export/
│       ├── to_onnx.py  ├── onnx_to_tf.py  ├── tf_to_tflite_int8.py
│       ├── tflite_op_check.py             # đối chiếu op ↔ danh sách ESP-NN/TFLM
│       ├── emit_golden.py                 # ★ xuất vector vàng ra contracts/golden/
│       ├── pack_models_partition.py       # gộp 3 .tflite + header → models.bin
│       └── update_lock.py                 # ★ ghi contracts/models.lock.json
│
├── bench/{host_bench.py, device_client.py, accuracy_on_device.py,
│          live_demo.py,                   # ★ detect → align → spoof → recog, webcam host
│          cam_bridge.py}                  # ★ chạy trên Windows: virtual cam → MJPEG
│       ★ Điểm vào chạy thẳng, KHÔNG phải thư viện. Nằm ngoài src/facepipe/ vì gói cài
│         đặt được không được kéo theo cv2 và http.server của một cái demo.
│
├── scripts/                               # đánh số = thứ tự chạy
│   ├── _resume_loop.sh                    # ★ khong danh so vi khong chay truc tiep:
│   │                                      #   ham dung chung, moi script train source no.
│   │                                      #   Train chet thi tu chay lai tu last.pth cua
│   │                                      #   chinh no, co tran so lan de khong lap vo han
│   ├── 00_fetch_raw.sh          ├── 01_prepare_interim.sh   ├── 02_make_splits.sh
│   │                            #   ★ 01 nhanh antispoof can checkpoint detection
│   │                            #     da train: cat mat bang student, khong bang Bbox (§3)
│   ├── 10_train_teacher_det.sh  ├── 11_train_teacher_spoof.sh
│   ├── 20_kd_det.sh   ├── 21_kd_spoof.sh   ├── 22_kd_recog.sh
│   ├── 30_quantize.sh ├── 40_export.sh     ├── 41_emit_golden.sh
│   └── 50_pack_and_flash.sh
│
├── artifacts/                             # ❌ gitignore
│   │   ★ TRỤC PHÂN CHIA CẤP 1 LÀ NHÁNH MODEL, giống configs/ · data/ · tasks/
│   ├── detection/
│   │   ├── runs/<YYYYMMDD-HHMM>_<gitsha7>_<cfghash6>/     # mỗi lần train = 1 thư mục bất biến
│   │   │   ├── config.resolved.yaml       # config đã merge, không phải file gốc
│   │   │   ├── split.lock                 # sha256 của split đã dùng
│   │   │   ├── env.txt                    # uv pip freeze + CUDA + GPU + commit
│   │   │   ├── ckpt/{best.pth, last.pth}
│   │   │   ├── metrics.json
│   │   │   └── tb/
│   │   ├── teacher/                       # weight teacher tải về — đầu vào, không phải kết quả run
│   │   ├── onnx/{student_fp32.onnx, student_qdq.onnx}
│   │   ├── tf/<tên>/                      # SavedModel, chặng giữa onnx2tf → TFLiteConverter
│   │   │                                  # ↑ sinh lại được, giữ để đổi cấu hình quantize
│   │   │                                  #   mà không phải chạy lại onnx2tf
│   │   ├── tflite/{yunet_fp32.tflite, yunet_int8.tflite}
│   │   ├── golden/                        # vector vàng trước khi copy sang contracts/
│   │   └── reports/{quant_debug.html, layer_sensitivity.csv, op_check.txt}
│   │                                      # ↑ sinh lại được. Số đo giữ lại: docs/measurements/
│   │      Tên trên là của **một** model đã chốt. Khi đang so nhiều checkpoint thì gắn
│   │      thêm hậu tố giờ của run: `student_fp32_0944.onnx`, `minifasnet_int8_0944.tflite`.
│   ├── antispoof/                         # ↑ y hệt khuôn trên
│   ├── recognition/                       # ↑ y hệt khuôn trên
│   └── device/                            # kết quả đo trên board, dùng chung 3 nhánh
│       └── <YYYYMMDD>_<fwsha7>/{arena.csv, latency_per_op.csv, accuracy.json}
│
├── notebooks/                             # ❌ gitignore output, ✅ commit .py qua jupytext
│   └── {01_explore_widerface.ipynb, 02_check_ov5640_stats.ipynb, ...}
│       Notebook CHỈ để khảo sát. Code chạy được phải chuyển vào src/facepipe/
├── .python-version                        # pin bản Python cho uv
└── tests/
    ├── conftest.py                          # fixture dùng chung
    ├── test_core_{config,registry,run_dir,trainer,distiller,isolation}.py
    ├── test_prepare.py                      # bộ chuyển raw → interim
    └── {test_splits.py, test_transforms.py, test_postproc_parity.py}
```

##### Ranh giới `core/` ↔ `tasks/`

**`core/` là hạ tầng train, không phải chỗ chứa model.** Nó không biết khuôn mặt là gì, không biết nhánh nào tồn tại. Cả 3 nhánh `import` cùng lúc **cùng những file đó** — không nhánh nào sở hữu, không nhánh nào thay thế nhánh nào. Xong detection thì code detection vẫn nằm nguyên đó, chạy lại lúc nào cũng được.

| Ở `core/` — viết 1 lần, 3 nhánh cùng dùng | Ở `tasks/<nhánh>/` — mỗi nhánh một bản riêng |
|---|---|
| Vòng lặp train: AMP, EMA, grad-clip, resume | Kiến trúc student |
| Lưu/khôi phục checkpoint, tạo thư mục run | Cách nạp và freeze teacher |
| Nạp + merge YAML, override từ CLI | Hàm loss (localization KD · depth-map KD · RKD) |
| Cố định seed, ghi `env.txt`, `split.lock` | Augment và dataloader riêng nhánh |
| Ghi tensorboard + wandb | Chỉ số đánh giá (WIDER AP · HTER · TAR@FAR) |
| Hook lấy feature map trung gian | Hậu xử lý ★ phải khớp firmware |

**Luật**: `core/` không được `import` bất cứ thứ gì từ `tasks/`, và không được chứa tên nhánh. Thấy `if task == "detection"` trong `core/` là code đặt sai chỗ — đẩy xuống `tasks/detection/`. Đây đúng là luật của `ai_engine/src/core/` ở firmware (§4.5.6): cùng một nguyên tắc, hai ngôn ngữ.

Cần thứ `core/` chưa có: chỉ 1 nhánh cần → để trong `tasks/<nhánh>/`. Từ 2 nhánh trở lên cần và không dính đặc thù nhánh nào → nâng lên `core/`, giữ nguyên giao diện, **không** thêm nhánh `if`.

`compress/` và `export/` cũng là hạ tầng: chúng giữ **thuật toán** (CLE, AdaRound, LSQ, convert). Mỗi nhánh chỉ cấp tham số riêng qua `tasks/<nhánh>/quant.py` — tập calib, danh sách layer giữ float, danh sách op cần kiểm.

##### Ba lệnh chạy song song, không thay thế nhau

```bash
python -m facepipe.tasks.detection.train_kd    --cfg configs/detection/kd.yaml
python -m facepipe.tasks.antispoof.train_kd    --cfg configs/antispoof/kd.yaml
python -m facepipe.tasks.recognition.train_kd  --cfg configs/recognition/kd.yaml
```

Thứ tự ở §8 là thứ tự **bắt tay vào việc**, không phải thứ tự thay thế. Xong giai đoạn 5 thì cả ba nhánh cùng nằm trong repo và `50_pack_and_flash.sh` gộp cả ba `.tflite` vào một `models.bin`.

**Cách "lục lại" sau 6 tháng**: mở `contracts/models.lock.json` → lấy `run_id` → mở đúng thư mục run → có `config.resolved.yaml` (biết hyperparameter), `split.lock` (biết train trên tập nào), `env.txt` (biết môi trường), `ckpt/` (có weight). Không phải đoán, không phải hỏi lại ai.

##### Mọi lần train phải dừng và chạy tiếp được

Fine-tune teacher chạy hàng chục giờ trên một máy laptop dùng chung. Một lần mất
điện, một lần cần máy làm việc khác, một cú đọc đĩa bị rớt — không cái nào được
phép bắt train lại từ epoch 0. **Điểm vào train nào chạy quá một giờ thì bắt buộc
có đường dừng và chạy tiếp.**

| Ràng buộc | Nội dung |
|---|---|
| Nhịp ghi checkpoint | Cuối **mỗi epoch**. Dừng giữa chừng mất nhiều nhất 1 epoch |
| Ghi checkpoint phải nguyên tử | Ghi ra `.tmp` rồi `rename`. Chết lúc đang ghi không được để lại file hỏng |
| Resume phải khôi phục đủ | weight · optimizer · scaler · scheduler · EMA · **RNG state** · epoch · step · best metric · history |
| Truy vết dòng dõi | Run tiếp nằm ở thư mục mới (run_id có dấu thời gian), nên nó **phải ghi lại run_id của run cha** — không thì lịch sử đứt đoạn giữa hai thư mục |

RNG state đi kèm checkpoint là bắt buộc chứ không phải làm cho đẹp: thiếu nó thì
run chạy tiếp bốc mẫu augment khác hẳn run không hề dừng, và hai lần train cùng
seed ra hai kết quả khác nhau — bảng đối chứng §3.7 mất ý nghĩa ngay.

---

### 4.5 `firmware/` — ESP-IDF

#### 4.5.1 Ba nguồn code, ba chỗ khác nhau

| Nguồn | Nằm ở | Git | Khai báo bằng |
|---|---|---|---|
| **ESP Component Registry** (Espressif + cộng đồng) | `managed_components/` | ❌ gitignore, ✅ commit `dependencies.lock` | `idf_component.yml` |
| **Third-party không có trên registry** (SDK hãng, fork) | `third_party/<name>/` | submodule, hoặc vendor kèm `UPSTREAM.md` | `EXTRA_COMPONENT_DIRS` |
| **Tự viết** | `components/` | ✅ commit | tự động |

**`components/` chỉ chứa code mình viết.** Tuyệt đối không copy code Espressif vào đó rồi sửa — làm thế là mất khả năng update mãi mãi.

`main/idf_component.yml`:
```yaml
dependencies:
  idf: ">=5.3"
  espressif/esp32-camera: "^2.0"
  espressif/esp-tflite-micro: "^1.4.0"
  espressif/esp-nn: "^1.3.2"
  espressif/esp_lcd_st7796: "^1.3"
  espressif/esp_lcd_touch_gt911: "^1.1"
  espressif/esp_lvgl_port: "^2.4"
  lvgl/lvgl: "^9.2"
  joltwallet/littlefs: "^1.16"
```
`espressif/esp_lcd_st7796` có trên registry (đã kéo về bản 1.4.0), nên `drv_lcd` gọi nó chứ không tự viết panel driver.

**`esp-nn` khai thẳng dù `esp-tflite-micro` đã kéo nó theo.** Ràng buộc gián tiếp là `>=1.1.1`, mà các bản esp-nn cũ có lỗi trong kernel INT8 — sai số ở đây không làm build fail, nó chỉ làm model trả ra số khác trên board so với trên host, tức là đúng thứ khó lần nhất. Ghim sàn ở bản mới nhất để một lần resolve lại không tụt xuống bản cũ.

```
third_party/
├── vl53l1x_uld/                # ST STSW-IMG009 — không có trên registry
│   ├── CMakeLists.txt          # ta viết, bọc thành component IDF
│   ├── UPSTREAM.md             # ✅ url, phiên bản, ngày lấy, sha256, đã sửa gì
│   ├── patches/*.patch         # ★ nếu buộc phải vá thì để patch, KHÔNG sửa thẳng file
│   └── {src, include}/         # nguyên bản
└── README.md
```

#### 4.5.2 Cây thư mục

```
firmware/
├── CMakeLists.txt                    # project() + EXTRA_COMPONENT_DIRS=third_party
├── sdkconfig.defaults                # chung mọi build
├── sdkconfig.defaults.esp32s3        # riêng target (PSRAM octal 80M, cache 32/64KB)
├── sdkconfig.ci                      # build CI: tắt secure boot, bật assert
├── sdkconfig.prod                    # Flash Encryption + Secure Boot v2
├── partitions.dev.csv                # coredump lớn, không secure boot
├── partitions.prod.csv               # §6.1
├── dependencies.lock                 # ✅ commit — khoá phiên bản managed_components
├── .gitignore                        # build/ sdkconfig sdkconfig.old managed_components/ models/*.tflite
│
├── main/
│   ├── CMakeLists.txt
│   ├── idf_component.yml             # ★ khai báo dependency registry
│   ├── app_main.c            [C]     # khởi tạo tuần tự, không chứa logic
│   ├── app_tasks.{c,h}       [C]     # xTaskCreatePinnedToCore (§5)
│   └── app_wiring.{c,h}      [C]     # ★ nối queue/event giữa các component
│
├── components/                       # ── 100% CODE TỰ VIẾT ──
│   ├── common/            [C]    L0  # kiểu dữ liệu, error code, event id, ring buffer, gen_payload.h
│   ├── bsp_board/         [C]    L1  # khởi tạo bus i2c/spi, quản lý mutex bus, nguồn
│   │   └── include/app_config.h      # ★ MỌI #define chân GPIO — DUY NHẤT 1 FILE.
│   │                                 #   Ở L1 vì L2 trở lên đều cần đọc, mà không
│   │                                 #   component nào được phụ thuộc lên main (§4.5.4)
│   ├── drv_ioexp/         [C]    L2  # PCF8574 + shadow register
│   ├── drv_camera/        [C]    L2
│   ├── drv_lcd/           [C]    L2
│   ├── drv_touch/         [C]    L3
│   ├── drv_tof/           [C]    L3
│   ├── drv_audio/         [C]    L3
│   ├── drv_relay/         [C]    L3  # chỉ bật/tắt chân PCF8574
│   ├── drv_servo/         [C]    L2  # chỉ đẩy xung LEDC 50 Hz
│   ├── sys_storage/       [C]    L2  # NVS + LittleFS + mmap model; sở hữu storage_format.h (§6.2.7)
│   ├── sys_time/          [C]    L2  # SNTP + DS3231
│   ├── ai_engine/         [C++]  L3  # TFLM — src/ tách 3 thư mục theo model (§4.5.6)
│   ├── svc_facedb/        [C++]  L3  # bảng embedding + cosine search + CRUD
│   ├── net_wifi/          [C]    L3
│   ├── net_mqtt/          [C]    L3
│   ├── net_ota/           [C]    L3
│   ├── svc_door/          [C++]  L4  # IDoor + RelayDoor/ServoDoor bọc 2 driver trên
│   ├── svc_vision/        [C++]  L4  # điều phối detect → align → spoof → recog
│   ├── svc_attendance/    [C++]  L5  # state machine, chống trùng, ghi log
│   ├── svc_sync/          [C++]  L5  # hàng đợi offline → MQTT
│   └── ui_kiosk/          [C++]  L6  # LVGL screens
│
├── third_party/
├── assets/                           # ✅ commit — NGUỒN của partition `assets`
│   ├── fonts/{noto_sans_vn_16.c, noto_sans_vn_24.c}
│   ├── icons/  ├── sounds/{ok.wav, denied.wav, spoof.wav}
│   └── build_assets.py               # → build/assets.bin (image SPIFFS)
│
├── models/                           # ❌ gitignore trừ 3 file ✅
│   ├── README.md                     # ✅ lệnh kéo .tflite từ ml/artifacts về
│   ├── models.lock.json              # ✅ copy từ contracts/ lúc build
│   ├── detection/
│   │   ├── yunet_int8.tflite         # artifact của ml/, KHÔNG commit
│   │   └── meta.json                 # ✅ in_h, in_w, arena_hint, sha256, run_id
│   ├── antispoof/{minifasnet_int8.tflite, meta.json}
│   └── recognition/{mobilefacenet_int8.tflite, meta.json}
│
├── test_apps/                        # test TÍCH HỢP toàn hệ (unit test nằm trong component)
│   ├── parity/                       # đọc contracts/golden/, so sánh postproc C vs Python
│   ├── bench_ai/                     # đo arena_used_bytes + latency/op
│   ├── bench_mem/                    # đo heap đỉnh, watermark stack
│   └── soak/                         # chạy 24h, theo dõi rò heap
│
└── scripts/{flash_models.sh, check_pinmap.py}   # riêng firmware; script ngang khối ở /tools
```

#### 4.5.3 Bố cục bên trong một component

```
components/svc_facedb/
├── CMakeLists.txt          # REQUIRES / PRIV_REQUIRES — xem bảng 4.5.4
├── include/
│   └── svc_facedb.h        # ★ CÔNG KHAI. extern "C", chỉ POD + handle mờ
├── priv_include/
│   └── facedb_internal.hpp # nội bộ, component khác KHÔNG thấy
├── src/{facedb.cpp, embedding_index.cpp, persist.cpp}
├── test_apps/              # ★ chuẩn ESP-IDF: test app nằm TRONG component
│   └── facedb/{main/test_facedb.c, CMakeLists.txt, pytest_facedb.py}
├── Kconfig                 # tuỳ chọn hiện trong menuconfig (vd. FACEDB_MAX_PERSON)
└── README.md               # 1 trang: làm gì, phụ thuộc gì, đo gì, giới hạn gì
```

Quy tắc header:
- `include/` → khai vào `INCLUDE_DIRS` = công khai. `priv_include/` → `PRIV_INCLUDE_DIRS` = riêng.
- Header công khai của component **C++ chỉ được chứa cú pháp C**: POD struct, handle mờ (`typedef struct svc_facedb_s* svc_facedb_t`), bọc `extern "C"`. Không `std::`, không class, không template.
- Tên file header = tên component → nhìn `#include "svc_vision.h"` là biết ngay nó ở đâu.

#### 4.5.4 Bảng tầng và phụ thuộc

| L | Component | Ngôn ngữ | `REQUIRES` (chỉ được đi XUỐNG) |
|---|---|---|---|
| L0 | `common` | C | — (chỉ IDF core) |
| L1 | `bsp_board` | C | `common` + `driver`, `esp_driver_gpio/i2c/spi/ledc` |
| L2 | `drv_ioexp` | C | `common`, `bsp_board` |
| L2 | `drv_camera` | C | `common`, `bsp_board`, `espressif__esp32-camera` |
| L2 | `drv_lcd` | C | `common`, `bsp_board`, `esp_lcd` |
| L2 | `drv_servo` | C | `common`, `bsp_board` (LEDC) |
| L3 | `drv_touch` | C | `common`, `bsp_board`, `drv_ioexp`, `esp_lcd_touch_gt911` |
| L3 | `drv_tof` | C | `common`, `bsp_board`, `drv_ioexp`, `vl53l1x_uld` |
| L3 | `drv_audio` | C | `common`, `bsp_board`, `drv_ioexp`, `esp_driver_i2s` |
| L3 | `drv_relay` | C | `common`, `drv_ioexp` |
| L2 | `sys_storage` | C | `common`, `nvs_flash`, `spi_flash`, `esp_partition`, `littlefs` |
| L2 | `sys_time` | C | `common`, `lwip`, `bsp_board` |
| L3 | `ai_engine` | C++ | `common`, `sys_storage`, `esp-tflite-micro` |
| L3 | `svc_facedb` | C++ | `common`, `sys_storage` |
| L3 | `net_wifi` / `net_mqtt` / `net_ota` | C | `common`, `sys_storage`, `esp_wifi` / `mqtt` / `esp_https_ota` |
| L4 | `svc_door` | C++ | `common`, `drv_relay`, `drv_servo` |
| L4 | `svc_vision` | C++ | `common`, `ai_engine`, `svc_facedb`, `drv_camera` |
| L5 | `svc_attendance` | C++ | `common`, `svc_vision`, `svc_facedb`, `sys_storage`, `svc_door`, `drv_audio` |
| L5 | `svc_sync` | C++ | `common`, `sys_storage`, `net_mqtt` |
| L6 | `ui_kiosk` | C++ | `common`, `drv_lcd`, `drv_touch`, `lvgl`, `esp_lvgl_port` |
| L7 | `main` | C | tất cả |

**Ba quy tắc bất di bất dịch:**
1. Không component nào được `REQUIRES` lên tầng trên hoặc ngang tầng — **không có ngoại lệ nào**. Driver cùng tầng không gọi nhau; thứ nhiều driver cùng cần thì nằm ở tầng thấp hơn tất cả chúng, như `drv_ioexp` ở L2 dưới bốn driver L3 dùng nó. Hai component ở cùng tầng mà cần nhau nghĩa là một trong hai đặt sai tầng: hạ nó xuống, đừng mở ngoại lệ. Số tầng là **thứ tự toàn phần**, nên đọc số là biết ngay ai được phụ thuộc ai mà không phải tra bảng.
2. `ui_kiosk` **không gọi** `svc_attendance`, và `svc_attendance` **không biết UI tồn tại**. Hai bên gặp nhau qua queue/event khai trong `common/include/app_events.h`, do `main/app_wiring.c` nối. Đây là chỗ dễ đẻ ra vòng phụ thuộc nhất.
3. `tools/check_layers.py` đọc `REQUIRES` trong mọi `CMakeLists.txt`, dựng đồ thị, **fail CI nếu có cạnh đi ngược**. Quy ước không được kiểm tra tự động thì 3 tháng sau sẽ bị vi phạm.

#### 4.5.5 Thiết kế OOP bên trong các component C++

Header công khai là **mặt tiền C** (§4.5.3) để `app_main.c` và các component C gọi được. Toàn bộ OOP nằm sau mặt tiền đó, trong `src/*.cpp` và `priv_include/*.hpp`.

##### a) Ràng buộc C++ trên MCU

```
-std=gnu++17 -fno-exceptions -fno-rtti -fno-threadsafe-statics -fno-use-cxa-atexit
```

| Cấm | Vì sao | Dùng gì thay |
|---|---|---|
| `new` / `delete` **sau khi boot xong** | Phân mảnh heap, 512 KB SRAM không chịu nổi | Dựng 1 lần vào bộ nhớ tĩnh bằng placement new |
| Exception, RTTI, `dynamic_cast` | Phình binary, `throw` không có đường xử lý hợp lý trên MCU | Trả `esp_err_t` |
| `std::string`, `std::vector`, `iostream` | Cấp phát ngầm | Mảng tĩnh + `etl`-style container tự viết trong `common` |
| `std::function` trong đường nóng | Có thể cấp phát heap | Con trỏ hàm + `void* ctx`, hoặc template |
| `virtual` trong vòng lặp tensor/pixel | Chặn inline, mỗi lần gọi thêm 1 lần đọc vtable | Template / hàm free |
| Biến static toàn cục có constructor phức tạp | Static init order fiasco | Đối tượng POD + hàm `init()` gọi tường minh từ `app_main` |

`virtual` **được phép** ở đúng bốn chỗ có nhu cầu thay thế thật: model TFLM, cơ cấu mở cửa, thuật toán so khớp, màn hình UI. Ba model × 1 vtable là chi phí không đáng kể; đổi lại là code test được trên máy host.

##### b) Tiện ích RAII dùng chung (`components/common/include/*.hpp`)

Nằm ở `include/` chứ không phải `priv_include/`: IDF không xuất `priv_include` ra ngoài
component, nên guard đặt ở đó thì đúng những component cần nó lại không thấy. Đây là ngoại
lệ duy nhất với luật "header công khai chỉ POD + `extern "C"`" ở §4.5.3 — chúng là template
C++ thuần header, chỉ component C++ include, và code C không bao giờ chạm tới.

| Lớp | Bọc cái gì | Cứu được lỗi gì |
|---|---|---|
| `FrameGuard` | `camera_fb_t*` | **Quên `esp_camera_fb_return()`** — lỗi kinh điển làm cạn frame pool rồi treo máy sau vài phút |
| `LockGuard` | `xSemaphoreTake/Give` | Return sớm giữa hàm mà quên nhả mutex → deadlock |
| `MmapRegion` | `esp_partition_mmap` / `munmap` | Rò handle mmap khi OTA model |
| `ArenaAllocator` | `heap_caps_aligned_alloc(16,…)` | Cấp phát arena không căn 16 B → ESP-NN chạy chậm âm thầm |
| `Queue<T,N>` | `xQueueCreate` + gửi/nhận có kiểu | Gửi nhầm kiểu vào queue (C thuần không bắt được) |
| `ScopedProfile` | `esp_timer_get_time()` | Đo latency mà quên ghi lại điểm kết thúc |

```cpp
// common/priv_include/frame_guard.hpp
class FrameGuard {
    camera_fb_t* fb_;
public:
    explicit FrameGuard(camera_fb_t* fb) noexcept : fb_(fb) {}
    ~FrameGuard()                     { if (fb_) esp_camera_fb_return(fb_); }
    FrameGuard(const FrameGuard&)            = delete;   // cấm copy → không double-return
    FrameGuard& operator=(const FrameGuard&) = delete;
    FrameGuard(FrameGuard&& o) noexcept : fb_(o.fb_) { o.fb_ = nullptr; }
    camera_fb_t* get() const noexcept { return fb_; }
};
```

Đây là thứ C++ mang lại giá trị lớn nhất trong cả firmware này: đường xử lý ảnh có **5 nhánh thoát sớm** (§3 lớp 5 — không có người / không có mặt / mặt quá nhỏ / spoof fail / không khớp). Viết bằng C thuần thì mỗi nhánh `return` đều phải nhớ trả frame và nhả mutex; sót một chỗ là treo máy sau nửa tiếng chạy.

##### c) `ai_engine` — kế thừa vì ba model khác nhau thật

```
        ┌──────────────────────┐
        │  <<interface>>       │
        │     ITfliteModel     │
        │  init/input/invoke   │
        │  arena_used/name     │
        └──────────┬───────────┘
                   │
        ┌──────────▼───────────┐
        │   TfliteModelBase    │  arena_, interpreter_, profiler_, tensor I/O
        │   (không tạo trực tiếp)│
        └───┬───────┬───────┬──┘
            │       │       │
     DetectModel SpoofModel RecogModel
     op:6        op:9       op:6         ← MicroMutableOpResolver<N> riêng từng lớp
     +decode()   —          +l2norm()
     +nms()
```

Ba lớp con khác nhau ở **danh sách op đăng ký** và **hậu xử lý**, không phải khác cho có. `TfliteModelBase` giữ phần lặp lại: dựng interpreter trên arena được đưa, `AllocateTensors`, đo `arena_used_bytes()`.

```cpp
// priv_include/tflite_model.hpp
class ITfliteModel {
public:
    virtual ~ITfliteModel() = default;
    virtual esp_err_t     init(const tflite::Model* graph, Arena& arena) noexcept = 0;
    virtual TfLiteTensor* input(int index)  noexcept = 0;
    virtual TfLiteTensor* output(int index) noexcept = 0;
    virtual esp_err_t     invoke() noexcept = 0;
    virtual size_t        arena_used() const noexcept = 0;
    virtual const char*   name()       const noexcept = 0;
};
```

**`init` nhận `Arena&` chứ không nhận `(size, caps)`.** Model tự cấp buffer riêng thì mỗi model một `MicroAllocator`, mà §3.10 đòi ngược lại: detect và spoof phải dùng **chung** một allocator mới chồng được tail và dùng chung head. `Arena` sở hữu buffer, model chỉ mượn.

**`input`/`output` có chỉ số.** Anti-spoof đọc hai crop, YuNet trả 9 tensor (3 đầu × 3 stride), nên một `input()` trơ không đủ diễn đạt.

```cpp
// src/detection/detect_model.hpp
class DetectModel final : public TfliteModelBase {
public:
    const char* name() const noexcept override { return "detect"; }
    int decode_and_nms(FaceBox* out, int max_out) noexcept;   // KHÔNG virtual — đường nóng
protected:
    tflite::MicroOpResolver& resolver() noexcept override { return detect_ops(); }
};
```

`resolver()` là **template method**: `core/` dựng interpreter mà không biết nhánh nào đăng ký op gì, đúng luật "`src/core/` không được biết tên bất kỳ model nào" ở §4.5.6. Danh sách op nằm ở `<nhánh>/ops.cpp`.

`decode_and_nms` cố tình **không** virtual: nó nằm trong đường nóng và chỉ có một cách làm.

**Không có mutex nào cho `ai_engine`.** §5.2 chỉ có một `ai_task` gọi pipeline, nên tensor đầu vào của interpreter có đúng một người ghi. Đây là ràng buộc chứ không phải may mắn: gọi `ai_engine_*` từ task thứ hai là hỏng dữ liệu, và phải ghi rõ ở header công khai.

##### d) `svc_vision` — tiêm phụ thuộc, test được trên host

```cpp
class VisionPipeline {
    ITfliteModel& detect_;      // tham chiếu, không sở hữu → thay bằng mock khi test
    ITfliteModel& spoof_;
    ITfliteModel& recog_;
    const IMatcher& matcher_;
    FaceAligner     aligner_;   // thành phần, không kế thừa
    QualityGate     gate_;
public:
    VisionPipeline(ITfliteModel& d, ITfliteModel& s, ITfliteModel& r, const IMatcher& m);
    VisionResult process(const FrameGuard& frame) noexcept;   // chuỗi thoát sớm
};
```

`VisionPipeline` nhận tham chiếu tới interface chứ không tự tạo model. Nhờ vậy `ml/tests` chạy được toàn bộ logic pipeline trên PC với model giả, không cần board. Đây là lý do thực dụng nhất để dùng OOP ở tầng này.

##### e) `svc_door` — chỗ interface trả nợ trực tiếp

Board mang cả hai bộ chấp hành (§2.3.F): servo gạt thanh chắn mở cửa mô hình, relay là ngõ ra dành cho khoá điện với tiếp điểm để hở. Cả hai đều đấu sẵn và đều nghiệm thu được trên phần cứng thật — relay bằng tiếng cạch, đèn kênh và phép đo thông mạch COM–NO — nên trừu tượng ở đây có hai hiện thực thật chứ không phải một chỗ trống chờ. Giữ nguyên quy tắc *driver viết bằng C*, đặt trừu tượng lên tầng service:

```
components/drv_relay/   [C]   ← driver thuần, chỉ biết bật/tắt chân PCF8574
components/drv_servo/   [C]   ← driver thuần, chỉ biết đẩy xung LEDC 50 Hz
components/svc_door/    [C++] ← IDoor + 2 adapter bọc 2 driver trên
```
```cpp
class IDoor {
public:
    virtual ~IDoor() = default;
    virtual esp_err_t open(uint32_t hold_ms) noexcept = 0;
    virtual esp_err_t close() noexcept = 0;
    virtual bool      is_open() const noexcept = 0;
};
class RelayDoor final : public IDoor { /* gọi drv_relay_set() */ };
class ServoDoor final : public IDoor { /* gọi drv_servo_angle() */ };
```

`svc_attendance` chỉ thấy `IDoor&`. Đổi từ relay sang servo là đổi **một dòng** trong `main/app_wiring.c`, chọn bằng `Kconfig`. Không sửa gì trong logic chấm công. Cùng chỗ cắm đó nhận `FakeDoor` để `test_apps` chạy được máy trạng thái chấm công trên host, không cần board.

##### f) `svc_attendance` — máy trạng thái bảng, **cố ý không dùng State pattern**

```cpp
enum class St : uint8_t { Idle, Detecting, Verifying, Granted, Denied, Cooldown };
struct Transition { St from; Ev on; St to; Action act; };
static constexpr Transition kTable[] = { … };   // nằm ở flash, 0 byte RAM
```

State pattern (mỗi trạng thái một lớp virtual) nghe "chuẩn OOP" hơn nhưng ở đây **tệ hơn**: 6 lớp + 6 vtable, chuyển trạng thái thành cấp phát/hủy đối tượng, và không nhìn được toàn bộ sơ đồ trạng thái trong một màn hình. Bảng `constexpr` nằm trong flash, đọc một phát thấy hết, kiểm chứng bằng unit test dễ. Dùng mẫu thiết kế phải có lý do, không phải để cho đủ.

##### g) `svc_facedb` — Strategy cho thuật toán so khớp

```cpp
class IMatcher {
public:
    virtual MatchResult best(const int8_t* emb, float scale) const noexcept = 0;
};
class CosineLinearMatcher final : public IMatcher;   // quét tuyến tính, ≤ 2.000 người
class CosineTopKMatcher   final : public IMatcher;   // dự phòng khi vượt quy mô

class FaceDb {
    EmbeddingTable table_;      // PSRAM, int8 + scale (§6.2.4)
    IPersist&      store_;      // LittleFS — cũng là interface để test bằng RAM fake
    Mutex          mtx_;        // mọi hàm công khai mở đầu bằng LockGuard
};
```

##### h) `ui_kiosk` — kế thừa đúng bài

```cpp
class Screen {
protected:
    lv_obj_t* root_ = nullptr;
public:
    virtual ~Screen() = default;
    virtual void on_enter()                    = 0;
    virtual void on_exit()                     = 0;
    virtual void on_event(const AppEvent& e)   = 0;
    virtual void tick(uint32_t dt_ms)          {}
};
// IdleScreen · ScanScreen · ResultScreen · EnrollScreen · SettingsScreen
class ScreenManager {
    Screen*  screens_[kScreenCount];   // dựng sẵn lúc boot, không tạo/hủy lúc chạy
    Screen*  cur_;
public:
    void go(ScreenId id) noexcept;     // cur_->on_exit(); cur_ = …; cur_->on_enter();
};
```

Năm màn hình cùng vòng đời, thêm màn hình mới không đụng `ScreenManager`. Đây là chỗ virtual đáng giá nhất và cũng rẻ nhất (mỗi lần chuyển màn mới gọi 1 lần).

##### i) Vòng đời đối tượng — dựng một lần, không bao giờ hủy

```cpp
// src/svc_vision.cpp
struct svc_vision_s { VisionPipeline impl; };            // handle mờ bọc đối tượng C++

alignas(svc_vision_s) static uint8_t g_storage[sizeof(svc_vision_s)];
static svc_vision_s* g_inst = nullptr;

extern "C" esp_err_t svc_vision_create(const svc_vision_cfg_t* cfg, svc_vision_t* out) {
    if (g_inst) return ESP_ERR_INVALID_STATE;
    g_inst = new (g_storage) svc_vision_s{ /* … */ };     // placement new, KHÔNG dùng heap
    *out = g_inst;
    return ESP_OK;
}

extern "C" esp_err_t svc_vision_process(svc_vision_t h, camera_fb_t* fb, vision_result_t* out) {
    FrameGuard g{fb};                                     // trả frame tự động ở mọi lối ra
    return to_c(h->impl.process(g), out);
}
```

Mọi đối tượng C++ nằm trong bộ nhớ tĩnh, dựng đúng một lần trong `app_main`, không có destructor nào chạy trong vòng đời thiết bị. RAII vẫn hoạt động đầy đủ cho những thứ **có phạm vi ngắn** (frame, khoá, profile) — đó mới là chỗ cần nó.

##### j) Bảng tổng kết: dùng gì ở đâu

| Component | Lớp chính | Kỹ thuật | Lý do chọn |
|---|---|---|---|
| `common` | `FrameGuard`, `LockGuard`, `Queue<T,N>`, `MmapRegion` | RAII, template | Xoá cả một lớp lỗi rò tài nguyên |
| `ai_engine` | `ITfliteModel` → `TfliteModelBase` → 3 lớp con | Kế thừa + template method | Ba model khác nhau ở op resolver và hậu xử lý |
| `svc_vision` | `VisionPipeline` | Tiêm phụ thuộc qua tham chiếu interface | Test toàn bộ logic trên host, không cần board |
| `svc_facedb` | `FaceDb`, `IMatcher` | Strategy | Đổi thuật toán so khớp khi quy mô tăng |
| `svc_door` | `IDoor`, `RelayDoor`, `ServoDoor` | Adapter bọc driver C | Chốt relay/servo muộn mà không sửa logic |
| `svc_attendance` | `AttendanceFsm` | Bảng `constexpr`, **không** virtual | Nhìn hết sơ đồ trạng thái trong 1 màn hình |
| `svc_sync` | `UplinkQueue`, `IPersist` | Composition | Thay LittleFS bằng RAM fake khi test |
| `ui_kiosk` | `Screen` → 5 lớp con, `ScreenManager` | Kế thừa | Năm màn hình cùng vòng đời |

#### 4.5.6 `ai_engine` — mỗi model một thư mục

Ba model không gộp chung một cục. Danh sách op, hậu xử lý và test của từng model nằm cạnh nhau, sửa nhánh nào chỉ mở một thư mục:

```
components/ai_engine/
├── include/ai_engine.h                    # mặt tiền C duy nhất cho cả 3 model
├── Kconfig                                # kích thước 2 arena, E8-T7 chỉnh lại theo số đo
├── priv_include/{tflite_model.hpp, arena.hpp, model_store.hpp}
├── src/
│   ├── ai_engine.cpp                      # dựng 2 arena, mở model store, nối 3 model
│   ├── core/                              # dùng chung — KHÔNG chứa gì riêng của model nào
│   │   ├── model_base.cpp                 # TfliteModelBase: arena, interpreter, AllocateTensors
│   │   ├── arena.cpp                      # cấp phát 16-byte aligned, internal → PSRAM fallback
│   │   ├── model_store.cpp                # đọc header partition, trả con trỏ mmap từng entry
│   │   └── profiler.cpp                   # MicroProfiler, chỉ bật khi CONFIG_AI_PROFILING
│   ├── detection/
│   │   ├── detect_model.hpp               # lớp + op của nhánh, không ra khỏi thư mục này
│   │   ├── detect_model.cpp               # DetectModel : TfliteModelBase
│   │   ├── ops.cpp                        # MicroMutableOpResolver<6>, đếm trên graph thật
│   │   ├── decode.cpp                     # giải mã anchor — khớp 1:1 ml/tasks/detection/postproc
│   │   └── nms.cpp
│   ├── antispoof/
│   │   ├── spoof_model.hpp                # lớp + op của nhánh, không ra khỏi thư mục này
│   │   ├── spoof_model.cpp
│   │   ├── ops.cpp                        # MicroMutableOpResolver<9>
│   │   └── preproc.cpp                    # crop + resize 81×81
│   └── recognition/
│       ├── recog_model.hpp                # lớp + op của nhánh, không ra khỏi thư mục này
│       ├── recog_model.cpp
│       ├── ops.cpp                        # MicroMutableOpResolver<6>, đếm trên graph thật
│       ├── align.cpp                      # affine warp 5 landmark → 113×113
│       └── l2norm.cpp
└── test_apps/                             # chuẩn ESP-IDF, host-side chạy bằng pytest-embedded
    ├── detection/{main/test_decode.c, CMakeLists.txt, pytest_decode.py}
    ├── antispoof/{main/{test_spoof.c, test_preproc.c}, CMakeLists.txt, pytest_preproc.py}
    └── recognition/{main/test_align.c, CMakeLists.txt, pytest_align.py}
```

**Quy tắc**: `src/core/` không được biết tên bất kỳ model nào. Thứ gì chỉ đúng cho một nhánh thì nằm trong thư mục nhánh đó. Thêm model thứ tư sau này = thêm một thư mục, không sửa `core/`.

`src/ai_engine.cpp` nằm ngoài `core/` chính vì lý do đó: nó là chỗ duy nhất gọi tên cả ba nhánh, để dựng đúng model nào vào arena nào. `core/` chỉ nhận `tflite::Model*` và một `Arena&`, không biết chúng thuộc nhánh gì.

**Hai kích thước arena khai ở `components/ai_engine/Kconfig`**, không gõ vào code: `AI_ARENA_FAST_KB` (SRAM nội, mặc định 175 theo §6.4) và `AI_ARENA_BIG_KB` (PSRAM). Cả hai là 🔬 ước lượng cho tới khi E8-T7 đo `tail` và `head` thật; đặt ở Kconfig để `sdkconfig.bench` chỉnh được mà không sửa nguồn. Xin `arena_fast` ở SRAM nội mà không đủ chỗ thì `Arena` lùi xuống PSRAM và **log cảnh báo** — chạy chậm còn hơn không chạy, nhưng phải thấy được là đã lùi.

Ba trục phân chia này **khớp nhau** ở cả ba nơi — mở cùng một tên thư mục là thấy cùng một nhánh model:

| Nhánh | Python | Firmware | Vector vàng |
|---|---|---|---|
| detection | `ml/src/facepipe/tasks/detection/`<br>`ml/artifacts/detection/` | `ai_engine/src/detection/`<br>`firmware/models/detection/` | `contracts/golden/detection/` |
| antispoof | `…/tasks/antispoof/`<br>`…/artifacts/antispoof/` | `…/src/antispoof/`<br>`…/models/antispoof/` | `…/golden/antispoof/` |
| recognition | `…/tasks/recognition/`<br>`…/artifacts/recognition/` | `…/src/recognition/`<br>`…/models/recognition/` | `…/golden/recognition/` |

#### 4.5.7 Model và asset vào build bằng cách nào

| Loại | Là gì | Vào flash bằng |
|---|---|---|
| `.tflite` | **Artifact của `ml/`**, không phải source | `ml/scripts/50_pack_and_flash.sh` → verify sha256 theo `contracts/models.lock.json` → đọc `firmware/models/<nhánh>/meta.json` → gộp `models.bin` → `parttool.py write_partition --partition-name models_0` |
| Font, icon, WAV | **Source**, commit trong `firmware/assets/` | `assets/build_assets.py` → `assets.bin` → `esptool` ghi partition `assets` |

**Firmware build không nhúng model.** Nhúng thành mảng C thì đổi model phải build lại toàn bộ firmware và mất khả năng OTA riêng model — mà model là thứ đổi nhiều nhất trong dự án này.

#### 4.5.8 Test

| Loại | Nằm ở | Chạy bằng |
|---|---|---|
| Unit từng component | `components/<name>/test_apps/<app>/` | `idf.py -C … build flash` + `pytest_*.py` host-side |
| Parity C ↔ Python | `test_apps/parity/` | đọc `contracts/golden/`, so sánh sai số |
| Đo hiệu năng | `test_apps/bench_ai/`, `bench_mem/` | in ra CSV cho `ml/bench/device_client.py` |
| Soak | `test_apps/soak/` | chạy 24h, theo dõi rò heap |

**Không hàm nghiệm thu nào nằm trong `src/` hay header công khai của component.** Quét bus, dò trở kéo, đi bốn màu, rình ngón tay, đo fps, đẩy khung về máy — tất cả ở `test_apps/` của chính component đó. Để trong driver thì nó thành API công khai vĩnh viễn (`ui_kiosk` gọi được `drv_lcd_selftest()`), và mỗi lần boot phải trả giá cho thứ chỉ dùng lúc cắm dây. `Kconfig` của component vì thế không có cờ bật/tắt nghiệm thu: cái gì chỉ chạy lúc bring-up thì không có mặt trong ảnh sản phẩm, không phải bị tắt đi.

Case cần mắt hoặc ngón tay người gắn thêm tag `[manual]`. `app_main` của test app gọi `unity_run_tests_by_tag("[manual]", true)`, nên vòng tự động bỏ qua chúng, còn người ngồi trước board chọn tay trong menu của IDF test runner.

#### 4.5.9 Ba profile build

`sdkconfig` (file thật) **gitignore**. Chỉ commit các `sdkconfig.defaults*`.

```bash
# dev   — vừa code vừa gỡ lỗi
idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.esp32s3;sdkconfig.dev"  build

# bench — đo số cho E8, phải giống prod về tốc độ nhưng còn profiler
idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.esp32s3;sdkconfig.bench" build

# prod  — bản ship và bản lấy số cuối cho báo cáo
idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.esp32s3;sdkconfig.prod" build
```

⚠️ **Không dùng `-DCMAKE_BUILD_TYPE=Release`.** ESP-IDF không hỗ trợ cách đó để đổi mức tối ưu; phải đi qua `CONFIG_COMPILER_OPTIMIZATION_*`.

##### Mức tối ưu trình biên dịch

| Kconfig | Cờ | Dùng ở |
|---|---|---|
| `CONFIG_COMPILER_OPTIMIZATION_DEBUG` | `-Og` | `dev` — mặc định của IDF, backtrace và biến còn đọc được |
| `CONFIG_COMPILER_OPTIMIZATION_SIZE` | `-Os` | không dùng — flash 16 MB, app 3 MB, size không phải ràng buộc |
| **`CONFIG_COMPILER_OPTIMIZATION_PERF`** | **`-O2`** | **`bench` và `prod`** |
| `CONFIG_COMPILER_OPTIMIZATION_NONE` | `-O0` | không dùng |

`-O2` tăng nhẹ kích thước binary nhưng gần như chắc chắn tăng tốc phần code C xung quanh inference. ⚠️ Nếu code có undefined behavior thì mức tối ưu cao hơn có thể **làm lộ bug vốn không xuất hiện ở `-Og`** — nên `bench` và `prod` phải chạy qua đủ bộ test, đừng chỉ test ở `dev`.

**Kernel conv của ESP-NN là assembly viết tay**, cờ trình biên dịch không đụng tới. `-O2` ăn ở phần C tự viết: `decode`, `nms`, `align`, `l2norm`, `cosine`, quality gate — cộng lại vẫn là phần đáng kể của mỗi lần nhận diện.

##### Bảng cấu hình theo profile

| Kconfig | `dev` | `bench` | `prod` | Vì sao |
|---|---|---|---|---|
| `COMPILER_OPTIMIZATION_*` | `DEBUG` | `PERF` | `PERF` | |
| `COMPILER_OPTIMIZATION_ASSERTION_LEVEL` | full | silent | **silent** | Bỏ chuỗi assert và tên file nguồn khỏi binary |
| `COMPILER_STACK_CHECK_MODE` | `NORM` | `NONE` | `NONE` | Stack canary tốn chu kỳ ở mọi lần gọi hàm |
| `LOG_DEFAULT_LEVEL` | `DEBUG` | `INFO` | `WARN` | |
| `LOG_MAXIMUM_LEVEL` | `VERBOSE` | `INFO` | `WARN` | Biên dịch bỏ hẳn chuỗi log, không chỉ ẩn lúc chạy |
| `HEAP_POISONING` | `LIGHT` | `NONE` | `NONE` | Poisoning làm mọi `malloc` chậm đi |
| `FREERTOS_USE_TRACE_FACILITY` | y | **y** | n | `bench` cần để đo tải từng core |
| `FREERTOS_GENERATE_RUN_TIME_STATS` | n | **y** | n | |
| `AI_PROFILING` (Kconfig riêng) | n | **y** | n | Bật `MicroProfiler` đo latency từng op |
| `ESP_SYSTEM_PANIC` | `GDBSTUB` | `PRINT_REBOOT` | `PRINT_REBOOT` | |
| `SECURE_BOOT` / `SECURE_FLASH_ENC` | n | n | **y** | |

> `bench` cố tình **giống `prod` về tốc độ** (`-O2`, không assert, không poisoning) và chỉ khác ở chỗ còn profiler. Đo trên `dev` rồi báo cáo là số sai — `-Og` chậm hơn đáng kể.

##### Cấu hình chung cho cả ba profile (`sdkconfig.defaults.esp32s3`)

| Kconfig | Giá trị | Vì sao |
|---|---|---|
| `ESP_DEFAULT_CPU_FREQ_MHZ` | 240 | |
| `ESP32S3_INSTRUCTION_CACHE_32KB` + `ICACHE_ASSOCIATED_WAYS_8` | y | Vòng lặp inference phải nằm gọn trong I-cache |
| `ESP32S3_DATA_CACHE_64KB` + `DATA_CACHE_LINE_64B` | y | Trọng số model đọc qua D-cache từ flash mmap |
| `SPIRAM_MODE_OCT` + `SPIRAM_SPEED_80M` | y | `arena_big` nằm ở PSRAM |
| **`ESPTOOLPY_FLASHMODE_QIO` + `ESPTOOLPY_FLASHFREQ_80M`** | y | ★ Trọng số `.tflite` đọc **trực tiếp từ flash qua mmap** (§6.2.2). DIO 40 MHz làm chậm inference thấy rõ — đây là chỗ hay bị bỏ sót nhất |
| `FREERTOS_HZ` | 1000 | Tick 1 ms cho preview mượt |
| `FREERTOS_UNICORE` | **n** | Cần 2 core theo §5.1 |
| `BT_ENABLED` | **n** | Tiết kiệm ~60 KB SRAM nội, dự án không dùng Bluetooth |
| `SPIRAM_FETCH_INSTRUCTIONS` | **n** | ⚠️ Bật là đẩy code sang PSRAM → **chậm đi**. Chỉ dùng khi hết flash, không phải trường hợp này |
| `SPIRAM_RODATA` | **n** | Lý do như trên |

##### Đặt mức tối ưu riêng cho một component

Giữ `-Og` toàn cục lúc dev nhưng vẫn muốn `ai_engine` chạy nhanh để đo thử:

```cmake
# components/ai_engine/CMakeLists.txt
target_compile_options(${COMPONENT_LIB} PRIVATE -O2)
```

Dùng khi cần đo nhanh giữa lúc đang gỡ lỗi. **Không dùng để chốt số cho báo cáo** — số chính thức lấy từ profile `bench`.

---

### 4.6 `backend/` — NestJS + TypeScript

```
backend/
├── Dockerfile                        # multi-stage: build → node:22-alpine
├── .env.example                      # ✅ commit — mọi biến, giá trị giả
├── .env                              # ❌ gitignore — giá trị thật, không bao giờ commit
├── package.json  ├── tsconfig.json  ├── nest-cli.json
├── prisma/{schema.prisma, migrations/, seed.ts}
├── test/{app.e2e-spec.ts, jest-e2e.json}      # e2e mặc định của NestJS
└── src/
    ├── main.ts                       # helmet, CORS (origin Vercel), ValidationPipe, Swagger
    ├── app.module.ts
    ├── config/
    │   ├── env.schema.ts             # ★ zod — NƠI DUY NHẤT đọc process.env (§4.4)
    │   └── configuration.ts          # ConfigModule.forRoot, validate lúc boot
    ├── common/
    │   ├── generated/                # ★ sinh từ contracts/schema — commit, KHÔNG sửa tay
    │   ├── guards/{jwt-auth.guard.ts, roles.guard.ts, device-auth.guard.ts}
    │   ├── cache/{cache.module.ts, cache.service.ts, cache-keys.ts}
    │   ├── decorators/  ├── interceptors/  ├── filters/  └── dto/
    ├── modules/
    │   ├── auth/     └── strategies/{jwt.strategy.ts, jwt-refresh.strategy.ts, device.strategy.ts}
    │   ├── users/    ├── employees/  ├── devices/   ├── enrollment/
    │   ├── attendance/ ├── shifts/   ├── reports/   ├── models/
    │   ├── mqtt/     ├── realtime/   └── audit/
    ├── queue/
    │   ├── queue.module.ts           # BullMQ, dùng chung kết nối Redis với cache
    │   ├── queues.ts                 # ★ tên hàng đợi + kiểu job, khai một chỗ
    │   └── processors/{image, report, notify}.processor.ts
    └── database/{prisma.service.ts, redis.service.ts}
```

**Redis giữ hai vai, một kết nối** — `database/redis.service.ts` sở hữu client, `cache/` và
`queue/` cùng dùng. Hai vai này không được lẫn: hàng đợi mất job là mất việc, cache mất key
chỉ là chậm đi một nhịp.

| Vai | Ai dùng | Mất Redis thì sao |
|---|---|---|
| **Cache** đọc nhiều ghi ít | `common/cache/` | API vẫn chạy, rơi thẳng xuống Postgres |
| **Hàng đợi** BullMQ | `queue/` | Job dừng, API vẫn nhận request |

**Bảng cache — mỗi khoá một TTL, khai ở `cache-keys.ts`**

| Khoá | Nội dung | TTL | Xoá khi |
|---|---|---|---|
| `emp:{id}` | hồ sơ nhân viên | 10 phút | sửa nhân viên |
| `emp:list:{hash}` | trang danh sách đã lọc | 60 giây | thêm/sửa/xoá nhân viên |
| `dev:{id}:status` | online, RSSI, heap | 45 giây | heartbeat tới |
| `report:{type}:{range}` | báo cáo đã tổng hợp | 15 phút | có bản ghi chấm công mới trong khoảng |
| `shift:active` | ca đang hiệu lực | 30 phút | sửa ca |

Cache **chỉ chứa dữ liệu đọc lại được từ Postgres**. Không cache embedding, không cache JWT,
không cache thứ gì mà mất đi là sai nghiệp vụ.

**Bảng hàng đợi BullMQ — khai ở `queues.ts`**

| Queue | Job | Ai đẩy vào | Vì sao không làm đồng bộ |
|---|---|---|---|
| `image` | resize + upload ảnh chấm công lên MinIO | `mqtt/` khi nhận bản ghi | Ảnh vài trăm KB, không để kiosk chờ |
| `report` | tổng hợp báo cáo tháng ra file | `reports/` khi người dùng bấm | Quét vài chục nghìn bản ghi |
| `notify` | gửi mail/webhook khi có sự kiện lạ | `audit/`, `devices/` | Bên thứ ba có thể chậm hoặc chết |
| `ota` | rollout theo lô, theo dõi từng thiết bị | `models/` | Chạy hàng giờ, phải resume được |

Mọi job đặt `attempts` + `backoff` số mũ và `removeOnComplete`. Job `image` và `ota` bắt buộc
**idempotent**: BullMQ giao ít nhất một lần, chạy lại phải ra cùng kết quả.

**Bảng dữ liệu chính (Prisma)**

| Bảng | Cột đáng chú ý |
|---|---|
| `User` | id, email, passwordHash, role(`ADMIN`/`HR`/`VIEWER`), refreshTokenHash |
| `Employee` | id, code, fullName, department, active, embeddingVersion |
| `FaceTemplate` | id, employeeId, embedding(`Bytes` int8[512]), scale(Float), quality, capturedAt |
| `Device` | id, serial, name, location, tokenHash, fwVersion, modelVersion, lastSeenAt, online |
| `AttendanceRecord` | id, localId(unique per device), employeeId, deviceId, ts, direction(`IN`/`OUT`), score, livenessScore, synced, photoUrl |
| `Shift` / `ShiftAssignment` | startTime, endTime, graceMinutes |
| `ModelRelease` | version, sha256, sizeBytes, url, runId, rolloutState |
| `AuditLog` | actorId, action, target, meta(json), ts |

`AttendanceRecord.localId` là khoá chống trùng cho cơ chế at-least-once của kiosk — unique index `(deviceId, localId)`.

**MQTT topic** (định nghĩa gốc ở `contracts/mqtt_topics.yaml`)

| Topic | Chiều | QoS | Nội dung |
|---|---|---|---|
| `kiosk/{deviceId}/up/attendance` | kiosk → server | 1 | bản ghi chấm công, có `localId` |
| `kiosk/{deviceId}/up/heartbeat` | kiosk → server | 0, retained | uptime, RSSI, heap, fw/model version |
| `kiosk/{deviceId}/up/event` | kiosk → server | 1 | spoof, lỗi phần cứng, cửa mở tay |
| `kiosk/{deviceId}/up/status` (LWT) | broker | 1, retained | `offline` khi mất kết nối |
| `kiosk/{deviceId}/down/cmd` | server → kiosk | 1 | mở cửa, reboot, đổi cấu hình |
| `kiosk/{deviceId}/down/enroll` | server → kiosk | 1 | thêm/xoá embedding |
| `kiosk/{deviceId}/down/ota` | server → kiosk | 1 | url + sha256 firmware hoặc model |

**JWT — 2 loại token**

| Loại | Thời hạn | Nơi lưu | Payload |
|---|---|---|---|
| Access (web) | 15 phút | memory ở frontend | sub, role |
| Refresh (web) | 7 ngày | cookie `httpOnly; Secure; SameSite=None` trên domain API | sub, jti (hash lưu DB để revoke) |
| Device token (kiosk) | 90 ngày, xoay vòng | NVS mã hoá trên ESP32 | deviceId, serial |

### 4.7 `frontend/` — Next.js trên Vercel

**Stack**: Next.js 15 (App Router) · TypeScript · TailwindCSS · shadcn/ui · TanStack Query · Zustand · Recharts · socket.io-client

```
frontend/
├── app/
│   ├── layout.tsx  ├── globals.css
│   ├── (auth)/login/page.tsx
│   └── (dashboard)/
│       ├── layout.tsx                # sidebar + guard
│       ├── overview/page.tsx         # thẻ số liệu + biểu đồ + luồng sự kiện realtime
│       ├── employees/{page.tsx, [id]/page.tsx, new/page.tsx}
│       ├── attendance/{page.tsx, [id]/page.tsx}
│       ├── devices/{page.tsx, [id]/page.tsx}      # online, OTA, log
│       ├── shifts/page.tsx  ├── reports/page.tsx  └── settings/page.tsx
├── public/{favicon.ico, logo.svg}
├── components/{ui/, charts/, tables/, forms/}
├── lib/
│   ├── env.ts                        # ★ zod — NƠI DUY NHẤT đọc process.env (§4.4)
│   ├── api.ts                        # axios + interceptor tự refresh khi 401
│   └── ws.ts  └── auth.ts
├── hooks/  ├── store/
├── types/
│   └── generated/                    # ★ sinh từ contracts/schema — commit, KHÔNG sửa tay
├── .env.example                      # ✅ commit — mọi biến, giá trị giả
├── .env.local                        # ❌ gitignore — giá trị thật
├── middleware.ts
└── next.config.ts
```

**Biến môi trường của frontend là công khai.** Mọi thứ có tiền tố `NEXT_PUBLIC_` đi thẳng vào
bundle mà trình duyệt tải về. Không bao giờ đặt secret ở đó — không JWT ký, không khoá MinIO,
không mật khẩu broker. Frontend chỉ cần đúng hai biến:

| Biến | Ví dụ | Công khai được không |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.example.com` | Được, chỉ là địa chỉ |
| `NEXT_PUBLIC_WS_URL` | `wss://api.example.com` | Được |

Thứ cần bí mật thì gọi vòng qua Route Handler chạy trên server của Next, không nhúng vào client.

### 4.8 `deploy/` — Docker trên VPS

```
deploy/
├── docker-compose.yml  ├── docker-compose.prod.yml  ├── .env.example
├── traefik/{traefik.yml, dynamic.yml}     # TLS tự động Let's Encrypt
├── mosquitto/{mosquitto.conf, acl, passwd}
└── postgres/init.sql
```

CI **không** nằm ở đây — workflow ở `/.github/workflows/`, vì GitHub Actions chỉ đọc đúng chỗ đó.

| Service | Image | Cổng | Ghi chú |
|---|---|---|---|
| `traefik` | traefik:v3 | 80, 443, 8883 | TLS tự động, reverse proxy, TCP passthrough cho MQTTS |
| `api` | build từ `backend/` | 3000 (nội bộ) | NestJS |
| `postgres` | postgres:16-alpine | 5432 (nội bộ) | volume `pgdata` |
| `redis` | redis:7-alpine | 6379 (nội bộ) | BullMQ |
| `mosquitto` | eclipse-mosquitto:2 | 8883 | user/pass riêng từng device + ACL |
| `minio` (tùy chọn) | minio/minio | 9000 | ảnh chấm công |
| `backup` | postgres + cron | — | dump hằng đêm |

Frontend **không nằm trong Docker** — deploy thẳng lên Vercel, trỏ `NEXT_PUBLIC_API_URL=https://api.<domain>`.

`ci/contracts.yml` là workflow quan trọng nhất: chạy lại generator từ `contracts/schema/`, fail nếu code sinh ra khác code đã commit. Đây là thứ chặn 3 khối trôi khỏi nhau.

---

### 4.9 Cấm hardcode — mỗi hằng số có đúng một nguồn

Cùng một con số nằm ở hai chỗ thì sớm muộn hai chỗ sẽ lệch, và bên sai luôn là bên không ai
nhớ tới. Bảng dưới là nơi duy nhất được phép khai từng loại hằng số.

| Loại hằng số | Nguồn duy nhất | Cách phần còn lại lấy về |
|---|---|---|
| Chân GPIO | `firmware/components/bsp_board/include/app_config.h` + §2 | `#include "app_config.h"` |
| Kích thước, offset bản ghi trên flash | `sys_storage/include/storage_format.h` + §6.2 | include, có `static_assert` |
| Trường payload MQTT | `contracts/schema/*.json` | sinh code, §4.2 |
| Tên topic, QoS, retained | `contracts/mqtt_topics.yaml` | đọc file, không gõ chuỗi topic |
| File model đang deploy, sha256 | `contracts/models.lock.json` | đọc file |
| Đường dẫn dataset | `ml/configs/common/paths.yaml` | nạp config |
| Siêu tham số train, `input_hw` | `ml/configs/<nhánh>/*.yaml` | nạp config |
| Ngân sách phần cứng, ngưỡng arena | `ml/configs/common/hardware.yaml` | nạp config |
| URL, host, port, secret, chuỗi kết nối | biến môi trường, khai ở `.env.example` | `config/env.schema.ts` · `lib/env.ts` |
| Tên khoá cache, TTL | `backend/src/common/cache/cache-keys.ts` | import |
| Tên hàng đợi, kiểu job | `backend/src/queue/queues.ts` | import |
| Ngưỡng nghiệp vụ (**tin cậy phát hiện mặt**, khớp mặt, liveness, chống trùng) | NVS trên kiosk, `SET_CONFIG` từ server | đọc cấu hình lúc chạy |

**Ba luật đi kèm:**

1. **`process.env` chỉ được đọc ở đúng một file mỗi khối** — `config/env.schema.ts` ở backend,
   `lib/env.ts` ở frontend. Nơi khác cần biến thì nhận qua tham số hoặc `ConfigService`. Đọc
   rải rác thì không ai biết ứng dụng thật sự cần những biến gì để chạy.
2. **Biến môi trường phải validate lúc boot, không phải lúc dùng.** Thiếu biến thì chết ngay
   lúc khởi động với thông báo rõ, thay vì `undefined` chui vào chuỗi kết nối rồi lỗi sau ba
   tiếng.
3. **`.env` không bao giờ commit; `.env.example` bắt buộc commit** và phải liệt kê **đủ mọi
   biến** với giá trị giả. Thêm một biến mà quên cập nhật `.env.example` là làm hỏng bước dựng
   môi trường của người tiếp theo.

Số đo được (latency, arena, accuracy) **không phải hằng số** — chúng nằm ở `docs/measurements/`
và ở `metrics.json` của từng run, không viết thẳng vào code.

---

## 5. Bảng task FreeRTOS + chia core + IPC

### 5.1 Nguyên tắc chia core

| Core | Giao cho | Vì sao |
|---|---|---|
| **Core 1 (APP_CPU)** | **CHỈ `ai_task`** | Một lần `Invoke()` chiếm CPU liên tục 100–400 ms. Để chung với LVGL thì UI giật, để chung Wi-Fi thì rớt gói. Độc chiếm 1 core là cách duy nhất giữ UI mượt trong lúc AI chạy |
| **Core 0 (PRO_CPU)** | Wi-Fi/lwIP (hệ thống) + camera + LVGL + touch + audio + ToF + MQTT + sync | Toàn bộ là việc ngắn, phần lớn do DMA/ISR gánh; CPU chỉ điều phối |

> 🔬 Nếu đo thấy core 0 quá tải (LVGL rớt dưới 20 fps): chuyển `mqtt_task` + `sync_task` sang core 1 với priority **thấp hơn** `ai_task` — chúng chỉ chạy khi AI nghỉ.

### 5.2 Bảng task

| Task | Component | Core | Prio | Stack | Kích hoạt | Nhiệm vụ |
|---|---|---|---|---|---|---|
| `cam_task` | `drv_camera` | 0 | 7 | 4 KB | mỗi frame (~15 fps) | `esp_camera_fb_get()` → đẩy con trỏ vào `q_frame_ai` (overwrite) + `q_frame_preview` |
| `tof_task` | `drv_tof` | 0 | 6 | 3 KB | ngắt GPIO3 / poll 100 ms | Đọc khoảng cách → phát `EVT_PRESENCE_ON/OFF`, đánh thức hệ thống |
| `audio_task` | `drv_audio` | 0 | 6 | 4 KB | chờ `q_audio` | Đọc WAV từ LittleFS → `i2s_channel_write` |
| `touch_task` | `drv_touch` | 0 | 5 | 3 KB | ngắt GPIO14 | Đọc GT911 → `q_touch` |
| **`ai_task`** | `vision_pipeline` | **1** | 5 | 8 KB | chờ `q_frame_ai` | quality gate → detect → align → spoof → recog → `q_result` |
| `ui_task` | `ui` | 0 | 4 | 8 KB (+ LVGL heap ở PSRAM) | tick 20 ms | `lv_timer_handler()`, vẽ preview, xử lý `q_touch`, đọc `eg_system` |
| `attend_task` | `attendance` | 0 | 4 | 4 KB | chờ `q_result` | State machine, chống trùng, ghi LittleFS, mở cửa, đẩy `q_audio` + `q_uplink` |
| `mqtt_task` | `net_mqtt` | 0 | 3 | 6 KB | esp-mqtt tự tạo | pub/sub, TLS |
| `ota_task` | `net_ota` | 0 | 3 | 8 KB | khi có lệnh `down/ota` | Tải firmware / models, verify sha256, ghi partition |
| `sync_task` | `sync_service` | 0 | 2 | 5 KB | 5 s hoặc khi `q_uplink` có dữ liệu | Đẩy bản ghi offline lên MQTT, chờ ack, xoá khỏi hàng đợi |
| `wifi` / `lwip` | hệ thống IDF | 0 | 18–23 | — | — | Do IDF quản lý, không tự tạo |

> **Quy tắc priority**: mọi task ứng dụng phải < 18 để không chèn Wi-Fi stack. Task có deadline cứng (cam, tof, audio) đặt cao hơn task chỉ cần "mượt mắt" (ui) và task nền (sync).

### 5.3 Bảng Queue / Mutex / Semaphore / EventGroup

| Đối tượng | Kiểu | Kích thước | Gửi | Nhận | Vì sao đặt ở đây |
|---|---|---|---|---|---|
| `q_frame_ai` | Queue, **depth 1**, `camera_fb_t*` | 1 × 4 B | `cam_task` | `ai_task` | Depth 1 + `xQueueOverwrite`: **luôn xử lý frame mới nhất**, frame cũ trả về pool ngay → không dồn RAM, không trễ tích luỹ |
| `q_frame_preview` | Queue, depth 2, `camera_fb_t*` | 2 × 4 B | `cam_task` | `ui_task` | Preview cho phép trễ 1 frame |
| `q_result` | Queue, depth 4, `face_result_t` | 4 × ~72 B | `ai_task` | `attend_task` | Tách hẳn tính toán khỏi nghiệp vụ |
| `q_touch` | Queue, depth 8, `touch_evt_t` | 8 × 8 B | `touch_task` | `ui_task` | Không mất thao tác vuốt nhanh |
| `q_audio` | Queue, depth 4, `sound_id_t` | 4 × 4 B | `attend_task`, `ui_task` | `audio_task` | Phát âm không được chặn nghiệp vụ |
| `q_uplink` | Queue, depth 16, `attendance_rec_t` | 16 × ~96 B | `attend_task` | `sync_task` | Đầy thì ghi thẳng LittleFS, không mất bản ghi |
| **`m_i2c`** | Mutex | — | GT911, VL53L1X, PCF8574, DS3231 | — | **Bắt buộc** — 4 thiết bị 1 bus, 3 task khác nhau truy cập |
| **`m_spi_lcd`** | Mutex | — | `ui_task`, `ota_task` (màn hình tiến trình) | — | 1 bus SPI, tránh xé khung hình |
| **`m_facedb`** | Mutex | — | `ai_task` (đọc), `mqtt_task` (ghi khi enroll) | — | Bảng embedding bị sửa giữa lúc đang so khớp = kết quả sai |
| **`m_littlefs`** | Mutex | — | `attend_task`, `sync_task`, `ota_task`, `audio_task` | — | LittleFS không thread-safe mặc định |
| `s_frame_ready` | Binary semaphore | — | ISR camera | `cam_task` | ISR chỉ `xSemaphoreGiveFromISR`, xử lý ở task |
| `s_tof_int` | Binary semaphore | — | ISR GPIO3 | `tof_task` | như trên |
| `eg_system` | EventGroup | 4 B | mọi task | `ui_task`, `sync_task` | Bit: `WIFI_OK` `MQTT_OK` `TIME_OK` `DB_LOADED` `AI_READY` `OTA_RUNNING`. Thay cho 6 biến cờ rời rạc |

**Quy tắc ISR (bắt buộc)**
- ISR **chỉ** gọi `xQueueSendFromISR` / `xSemaphoreGiveFromISR` + `portYIELD_FROM_ISR()`. Không log, không I2C, không malloc.
- ISR gắn `ESP_INTR_FLAG_IRAM` và hàm phải `IRAM_ATTR` nếu bật flash-suspend hoặc OTA đang ghi flash.
- Mutex **không dùng được** trong ISR — cần khoá thì dùng `portMUX_TYPE` + `portENTER_CRITICAL_ISR`.

**Quy tắc chống deadlock**
Thứ tự lấy khoá cố định trên toàn dự án: `m_facedb` → `m_littlefs` → `m_i2c` → `m_spi_lcd`. Không bao giờ lấy ngược. Mọi `xSemaphoreTake` đều có timeout, không dùng `portMAX_DELAY` cho mutex.

---

## 6. Bộ nhớ và định dạng lưu trữ

### 6.1 Phân vùng Flash 16 MB (`partitions.prod.csv`)

```csv
# Name,     Type, SubType,  Offset,    Size,      Flags
nvs,        data, nvs,      0x9000,    0x6000,
otadata,    data, ota,      0xF000,    0x2000,
phy_init,   data, phy,      0x11000,   0x1000,
nvs_keys,   data, nvs_keys, 0x12000,   0x1000,   encrypted   # khoá mã hoá NVS
ota_0,      app,  ota_0,    0x20000,   0x200000,        # 2 MB  firmware A
ota_1,      app,  ota_1,    0x220000,  0x200000,        # 2 MB  firmware B
models_0,   data, 0x40,     0x420000,  0x300000,        # 3 MB  3 model .tflite (slot A)
models_1,   data, 0x41,     0x720000,  0x300000,        # 3 MB  slot B — OTA model có rollback
assets,     data, spiffs,   0xA20000,  0x180000,        # 1.5 MB font, icon, âm thanh WAV
storage,    data, littlefs, 0xBA0000,  0x400000,        # 4 MB  face DB + log chấm công offline
coredump,   data, coredump, 0xFA0000,  0x10000,
# còn trống: 0xFB0000 → 0x1000000 (~320 KB) dự phòng
```

**Vì sao model rộng hơn firmware.** Ba model INT8 export xong đo được 2,46 MB (§1.1 ước tính 1,80 MB, hụt ở cả ba nhánh), còn ảnh firmware thật chỉ 567 KB — dùng 18% một slot OTA 3 MB. Nên mỗi slot OTA hạ xuống 2 MB, vẫn dư 3,6 lần, và mỗi slot model lên 3 MB. Cách chia này giữ nguyên offset của `assets`, `storage` và `coredump`, nên đổi bảng không xoá dữ liệu LittleFS đã ghi trên máy đang chạy.

Đây là **nới chỗ, không phải lời giải**: 2,46 MB vẫn phải giảm, xem `docs/measurements/latency.md` §3 — cùng những thay đổi kiến trúc kéo latency xuống cũng kéo kích thước xuống.

| Phân vùng | Chứa gì | Đọc bằng |
|---|---|---|
| `nvs` | Wi-Fi credential, device JWT, cấu hình, số serial — bố cục namespace ở §6.2.1 | `nvs_flash` |
| `nvs_keys` | Khoá AES để mã hoá `nvs`. Chỉ có tác dụng khi bật Flash Encryption | `nvs_flash_secure_init` |
| `models_0` / `models_1` | Header (magic, version, offset, sha256) + 3 file `.tflite` INT8 (2,46 MB đo thật) | `esp_partition_mmap` → `const void*`, **0 byte RAM** |
| `assets` | Font tiếng Việt, icon LVGL, file WAV thông báo | SPIFFS read-only |
| `storage` | `db/faces.bin` (embedding), `log/attend.NNN` (append-only), `cfg/`, `tmp/` — bố cục ở §6.2.3 | LittleFS (chống mất điện tốt hơn SPIFFS) |

### 6.2 Bố cục dữ liệu trên thiết bị

Phân vùng cho biết *chỗ nào rộng bao nhiêu*; phần này định nghĩa *bên trong mỗi chỗ có gì*. Không chốt trước các bảng dưới thì `sys_storage` sẽ bị viết chắp vá và mất dữ liệu khi cúp điện.

> **Luật truy cập bộ nhớ bền**: chỉ `sys_storage` được gọi `lfs_*`, `nvs_*`, `esp_partition_*`. Mọi component khác đi qua API công khai của nó. Vi phạm luật này là cách nhanh nhất để có hai nơi cùng ghi một file mà không ai giữ `m_littlefs`.

#### 6.2.1 NVS — cấu hình và bí mật

Bật **NVS encryption** (khoá nằm trong partition `nvs_keys`, bảo vệ bằng Flash Encryption).

| Namespace | Key | Kiểu | Ghi chú |
|---|---|---|---|
| `wifi` | `ssid`, `pass` | str / blob | ghi khi provisioning |
| `device` | `serial`, `jwt`, `jwt_exp`, `mqtt_host`, `mqtt_port`, `mqtt_user`, `mqtt_pass` | str / u32 | token xoay vòng khi còn 7 ngày |
| `model` | `active_slot` (u8: 0/1), `version` (str), `sha256` (blob 32B) | | chọn `models_0` hay `models_1` |
| `sys` | `boot_count` (u32), `last_ota_result` (u8), `fw_valid` (u8) | | `boot_count` dùng sinh `local_id` |
| `ui` | `brightness` (u8), `volume` (u8), `lang` (str) | | không nhạy cảm, cho phép sửa từ màn hình cài đặt |

**Không để dữ liệu sinh trắc trong NVS.** NVS là key-value nhỏ, ghi nhiều sẽ mòn; embedding nằm ở LittleFS.

#### 6.2.2 Partition `models_0` / `models_1` — định dạng ảnh model

```
offset 0x0000  header 256 B
   +0x00  magic       'MDLS'            (4B)
   +0x04  format_ver  u32               (4B)
   +0x08  count       u32  ≤ 3          (4B)
   +0x0C  built_at    u32  epoch giây   (4B)
   +0x10  entry[0..2] mỗi entry 64 B:
             name[16]      "detect" | "spoof" | "recog"
             offset  u32   tính từ đầu partition
             size    u32
             sha256  [32]
             in_h u16, in_w u16
             arena_hint u32              # arena đã đo (byte); 0 = chưa đo, xem E8-T7
   +0xD0  reserved                       (44B)
   +0xFC  crc32 của 0x00..0xFB           (4B)

offset 0x0100  detect.tflite
offset ...     spoof.tflite   (căn 16 B — ESP-NN cần)
offset ...     recog.tflite   (căn 16 B)
```

`sys_storage_models_open()` mmap toàn bộ partition một lần và kiểm crc header; `sys_storage_model_find()` tra theo `name` rồi trả `base + entry[i].offset` cho `ai_engine`. Tra theo tên chứ không theo vị trí, nên `count` nhỏ hơn 3 vẫn hợp lệ: khi một nhánh chưa có model, ảnh chỉ chứa những nhánh đã có và các entry còn lại để 0. **Verify sha256 chỉ chạy ngay sau OTA**, không chạy mỗi lần boot — băm 1.7 MB tốn ~200 ms mỗi lần khởi động mà không đổi lại được gì.

Ảnh do `ml/src/facepipe/export/pack_models_partition.py` gộp: nó đọc `contracts/models.lock.json` để biết nhánh nào đang deploy, đối chiếu sha256 và `meta.json` của từng nhánh, rồi ghi header + ba khối `.tflite`. `ml/scripts/50_pack_and_flash.sh` gọi nó và ghi kết quả xuống `models_0` bằng `parttool.py`.

**A/B model**: `nvs:model/active_slot` quyết định dùng partition nào. OTA ghi vào slot *không* active → verify sha256 → đổi `active_slot` → reboot. Nếu boot sau đó lỗi (`ai_engine_init` fail) thì `app_main` trả `active_slot` về giá trị cũ và reboot lại. Rollback model độc lập với rollback firmware.

#### 6.2.3 LittleFS (partition `storage`, 4 MB) — bố cục file

```
/lfs
├── db/
│   ├── faces.bin          # bảng embedding, bản ghi cố định 552 B
│   ├── faces.tmp          # chỉ tồn tại giữa chừng khi ghi 2 pha
│   └── faces.bak          # bản ngay trước, để cứu khi faces.bin hỏng
├── log/
│   ├── attend.000         # append-only, xoay vòng khi > 256 KB
│   ├── attend.001
│   └── cursor.bin         # đã đồng bộ tới file nào, offset nào
├── cfg/
│   └── ui.json            # cấu hình không nhạy cảm, sửa được từ màn hình
└── tmp/                   # ảnh crop tạm cho enroll — XOÁ SẠCH mỗi lần boot
```

Chọn LittleFS chứ không SPIFFS vì LittleFS có copy-on-write + `rename` nguyên tử, chịu được mất điện giữa lúc ghi. SPIFFS không.

#### 6.2.4 `db/faces.bin` — header 32 B + bản ghi 552 B

**Header file (32 B, ở đầu file)** — có `format_ver` để sau này còn migrate được:

| Offset | Kích thước | Trường |
|---|---|---|
| 0 | 4 | `magic` = `'FDB1'` |
| 4 | 2 | `format_ver` u16 |
| 6 | 2 | `record_size` u16 = 552 |
| 8 | 4 | `record_count` u32 (kể cả bản ghi đã xoá mềm) |
| 12 | 8 | `updated_at` i64 epoch ms |
| 20 | 8 | `reserved` |
| 28 | 4 | `crc32` của byte 0..27 |

**Bản ghi (552 B mỗi cái)**

| Offset | Kích thước | Trường | Ghi chú |
|---|---|---|---|
| 0 | 4 | `magic` = `'FACE'` | bắt lệch offset |
| 4 | 4 | `employee_id` u32 | |
| 8 | 2 | `template_idx` u16 | 1 người nhiều template (chính diện, đeo kính, thiếu sáng) |
| 10 | 1 | `quality` u8 | 0–255, dùng để chọn template tốt hơn khi trùng |
| 11 | 1 | `flags` | bit0 active, bit1 deleted (xoá mềm) |
| 12 | 4 | `scale` f32 | hệ số dequant cho embedding int8 |
| 16 | 512 | `embedding` int8[512] | |
| 528 | 8 | `updated_at` i64 | epoch ms |
| 536 | 12 | `reserved` | chừa chỗ để thêm trường mà không phá format |
| 548 | 4 | `crc32` | băm byte 0..547 |

500 người × 2 template = 1.000 bản ghi = **552 KB**, thoải mái trong 4 MB.

Lưu **int8 + scale** chứ không float32: giảm 4 lần dung lượng và 4 lần RAM cache, mất < 0.3% accuracy khi so cosine. Bảng nạp nguyên vào PSRAM lúc boot; `faces.bin` chỉ là bản bền.

Xoá nhân viên = đặt `flags.deleted`, **không dồn file**. Nén thật chỉ chạy khi tỉ lệ bản ghi chết > 30%, làm bằng ghi 2 pha.

#### 6.2.5 `log/attend.NNN` — header 32 B + bản ghi 48 B, chỉ ghi thêm

Header file **giống hệt khuôn của `faces.bin`** (magic `'ALG1'`, `record_size` = 48), ghi một lần lúc tạo file. Dùng chung khuôn để `sys_storage` chỉ cần một hàm đọc/ghi header.

**Bản ghi (48 B mỗi cái)**

| Offset | Kích thước | Trường |
|---|---|---|
| 0 | 4 | `magic` = `'ATTD'` |
| 4 | 8 | `local_id` u64 = `(boot_count << 32) \| seq` |
| 12 | 4 | `employee_id` u32 |
| 16 | 8 | `ts` i64 epoch ms |
| 24 | 1 | `direction` (0 = IN, 1 = OUT) |
| 25 | 2 | `match_score` Q8.8 |
| 27 | 2 | `liveness_score` Q8.8 |
| 29 | 1 | `flags` (bit0 đã mở cửa, bit1 thu lúc mất mạng, bit2 giờ chưa đồng bộ NTP) |
| 30 | 2 | `model_version` u16 |
| 32 | 12 | `reserved` |
| 44 | 4 | `crc32` |

4 MB / 48 B ≈ **87.000 bản ghi** — thừa cho vài tháng mất mạng liên tục.

`local_id` sinh từ `boot_count` (NVS) ghép với số thứ tự trong phiên, nên **không bao giờ trùng kể cả sau mất điện**, và server dùng đúng trường này làm khoá chống trùng (`unique(deviceId, localId)`).

#### 6.2.6 Quy tắc ghi — chống mất điện

| Việc | Cách ghi | Mất điện giữa chừng thì sao |
|---|---|---|
| Sửa `faces.bin` | Ghi `faces.tmp` → `lfs_file_sync` → rename `faces.bin`→`faces.bak` → rename `faces.tmp`→`faces.bin` | `faces.bin` hoặc còn nguyên bản cũ, hoặc đã là bản mới. Không bao giờ nửa vời. Boot sau đọc `faces.bin`; CRC sai thì rơi về `faces.bak` |
| Thêm bản ghi chấm công | `lfs_file_write` + **`lfs_file_sync` ngay sau mỗi bản ghi** | Bản ghi cuối CRC sai → bị bỏ lúc đọc lại. Các bản ghi trước còn nguyên |
| Cập nhật `cursor.bin` | Ghi **SAU KHI** broker trả ack QoS 1 | Gửi lại bản ghi đã gửi → server khử trùng bằng `local_id`. Đây là at-least-once, đúng ý đồ — thà trùng còn hơn mất |
| Xoay vòng log | `attend.NNN` > 256 KB → tạo `attend.NNN+1`. Xoá file cũ chỉ khi `cursor` đã vượt hết file đó | Không mất bản ghi chưa sync |
| `tmp/` | Xoá sạch trong `sys_storage_init()` | Không cần quan tâm |

`lfs_file_sync` sau mỗi bản ghi 48 B là đánh đổi có chủ đích: chậm hơn (~10–20 ms/lần ghi) nhưng bản ghi chấm công không được phép mất. Tần suất ghi thấp (vài chục lần/ngày) nên không ảnh hưởng gì.

**Tuổi thọ flash**: 87.000 lần ghi × 48 B, LittleFS có wear-leveling, phân vùng 4 MB → không phải lo trong vòng đời thiết bị. Ngược lại, **không được** ghi `heartbeat` hay log debug xuống LittleFS mỗi giây — đó mới là thứ giết flash.

#### 6.2.7 Struct định nghĩa ở đâu

Mọi layout nhị phân trong §6.2 tồn tại ở **đúng một file**:

```
firmware/components/sys_storage/include/storage_format.h
```

File này là bản dịch 1:1 của §6.2.2, §6.2.4, §6.2.5 sang C, và **bắt buộc có `static_assert`** để trình biên dịch chốt lại con số, không để nó chỉ là bảng trên giấy:

```c
#pragma once
#include <assert.h>
#include <stdint.h>

#define STORAGE_FACES_MAGIC   0x31424446u   // 'FDB1'
#define STORAGE_FACES_VER     1u
#define STORAGE_EMBED_DIM     512

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t employee_id;
    uint16_t template_idx;
    uint8_t  quality;
    uint8_t  flags;
    float    scale;                       // dequant cho embedding int8
    int8_t   embedding[STORAGE_EMBED_DIM];
    int64_t  updated_at_ms;
    uint8_t  reserved[12];
    uint32_t crc32;
} face_record_t;

static_assert(sizeof(face_record_t) == 552, "face_record_t must match KEHOACH 6.2.4");
static_assert(offsetof(face_record_t, embedding) == 16, "embedding offset drifted");
```

Ba hệ quả bắt buộc:

- `svc_facedb` và `svc_attendance` **include file này**, không tự khai lại struct.
- Đổi layout thì tăng `format_ver` **và** sửa §6.2 trong cùng một commit — giống luật GPIO ở §2.
- `ml/bench/device_client.py` khi cần đọc dump từ board thì sinh format string từ chính file này, không gõ tay `struct.unpack`.

#### 6.2.8 Partition `assets` (SPIFFS, read-only)

```
/assets
├── font/{noto_vn_16.bin, noto_vn_24.bin}
├── img/{logo.bin, icon_ok.bin, icon_deny.bin}    # định dạng LVGL binary
└── snd/{ok.wav, denied.wav, spoof.wav, enroll.wav}   # 16 kHz, 16-bit, mono
```

Mount **read-only**, không bao giờ ghi lúc chạy → dùng SPIFFS là đủ, nhẹ hơn LittleFS. Cập nhật bằng cách ghi đè cả partition qua OTA.

### 6.3 Bảng dữ liệu — nằm ở đâu và vì sao

| Dữ liệu | Kích thước | Vùng | Cách cấp phát | Vì sao |
|---|---|---|---|---|
| Camera FB preview ×2 (320×240 RGB565) | 2 × 150 KB | **PSRAM** | `camera_config.fb_location = CAMERA_FB_IN_PSRAM`, `fb_count = 2` | Quá lớn cho SRAM |
| Camera FB cho AI (640×480 RGB565, chỉ khi cần crop nét) | 600 KB | **PSRAM** | như trên | |
| LCD frame buffer 320×480 RGB565 | 300 KB | **PSRAM** | `heap_caps_malloc(..., MALLOC_CAP_SPIRAM)` | |
| LCD bounce buffer (2 × 20 dòng) | 2 × 19.2 KB | **SRAM (DMA)** | `MALLOC_CAP_DMA \| MALLOC_CAP_INTERNAL` | SPI DMA đọc trực tiếp từ PSRAM bị giới hạn → bắt buộc bounce qua RAM nội |
| **Arena detect** | 🔬 ước ~120 KB @160×120 | **SRAM nếu vừa** | `heap_caps_aligned_alloc(16, n, MALLOC_CAP_INTERNAL)` | Nhanh nhất, chạy nhiều nhất |
| **Arena anti-spoof** | 338 KB đo thật @80×80, 🔬 lại sau khi sang 81 | **SRAM** | như trên | Nhỏ, dễ nhét |
| **Arena recognition** | 904 KB đo thật @113×113 | **PSRAM** | `MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT`, align 16 | Nặng nhất, chạy ít nhất (chỉ khi spoof pass) → chấp nhận chậm |
| Trọng số 3 model `.tflite` | ~1.7 MB | **Flash mmap** | `esp_partition_mmap` | Không tốn RAM |
| Ảnh crop 113×113×3 int8 (recog input) | 38.3 KB | **SRAM** | static buffer | Vào thẳng `Invoke()` |
| Ảnh crop 81×81×3 int8 (spoof input) | 19.7 KB | **SRAM** | static buffer | |
| Bảng embedding (500 người × 512 chiều) | 1 MB nếu float32 — **256 KB nếu int8** | **PSRAM** (cache) + `storage` (bản gốc) | `MALLOC_CAP_SPIRAM` | Cosine search quét toàn bảng → phải ở RAM. **Khuyến nghị int8 + scale**, mất < 0.3% accuracy |
| Log chấm công offline | tới 4 MB | **Flash LittleFS** | append-only | Chịu được mất điện |
| Cert TLS + device JWT | ~4 KB | **NVS mã hoá** | `nvs_flash` + NVS encryption | |
| LVGL heap | 48 KB | **PSRAM** | `LV_MEM_CUSTOM = 1` → `heap_caps_malloc` | LVGL không cần tốc độ RAM nội |
| Wi-Fi + lwIP buffer | ~55 KB | **SRAM (bắt buộc)** | IDF tự quản | Không thể để PSRAM |
| Stack 10 task | ~53 KB | **SRAM (bắt buộc)** | FreeRTOS | |

### 6.4 Ngân sách SRAM 512 KB

| Mục | Ước tính |
|---|---|
| `.data` + `.bss` firmware (LVGL, TFLM, driver) | ~70 KB |
| Wi-Fi + lwIP (BT tắt) | ~55 KB |
| Stack 10 task | ~53 KB |
| LCD bounce + DMA descriptor | ~42 KB |
| Buffer ảnh crop (spoof + recog) | ~57 KB |
| Heap dự phòng (malloc lặt vặt, TLS handshake ~30 KB) | ~60 KB |
| **Còn lại cho arena** | **≈ 175 KB** |

**Hệ quả**: ~175 KB vừa đủ cho `arena_fast` (detect + anti-spoof dùng chung, tính theo công thức §3.10), `arena_big` của recognition bắt buộc xuống PSRAM. 🔬 Đo ở E8; nếu `arena_fast` không vừa thì hạ `input_hw` của detect xuống 128×96 và train lại nhánh đó.

Bảng trên là ngân sách **tổng**, mà thứ chặn `arena_fast` lại là dải liền mạch (§3.10). Số đo hiện có ở `docs/measurements/arena.md` là của cấu hình chưa có Wi-Fi và LVGL, nên phải đo lại ở E8-T9 khi đã đủ thành phần.

---

## 7. Backend, Frontend, Deploy

### 7.1 Luồng dữ liệu tổng thể

```
┌──────────────────────── KIOSK (ESP32-S3) ────────────────────────┐
│ VL53L1X ─wake─► OV5640 ─► [quality gate] ─► YuNet INT8            │
│                                    │  box + 5 landmark            │
│                                    ▼                              │
│                            affine align 113×113                   │
│                                    ▼                              │
│                        MiniFASNetV2-SE INT8 (81×81)               │
│                            live? ──No──► LCD "Giả mạo" + log      │
│                                    ▼ Yes                          │
│                        MobileFaceNet INT8 → embedding 512-D       │
│                                    ▼                              │
│                     cosine vs face_db  →  id + score              │
│                                    ▼                              │
│              attendance state machine (chống trùng N phút)        │
│                    ├─► LCD kết quả  ├─► loa ├─► IDoor: relay/servo│
│                    └─► LittleFS (append) ──► q_uplink             │
└───────────────────────────────┬───────────────────────────────────┘
                                │ MQTTS 8883 (QoS1, LWT)
                                ▼
┌──────────────── VPS — Docker Compose ────────────────┐
│ traefik ─┬─► NestJS API ─┬─► PostgreSQL              │
│          │               ├─► Redis + BullMQ          │
│          │               └─► MinIO (ảnh)             │
│          └─► mosquitto (MQTTS, ACL theo deviceId)    │
└──────────────────────┬────────────────────────────────┘
                       │ HTTPS + WebSocket
                       ▼
              Next.js trên Vercel (dashboard)
```

### 7.2 Bảo mật — checklist

| Hạng mục | Cách làm |
|---|---|
| Kiosk ↔ broker | MQTTS 8883, cert CA nhúng trong firmware, client cert hoặc user/pass riêng từng device + ACL chỉ cho topic `kiosk/{chính nó}/#` |
| Device token | JWT 90 ngày lưu **NVS encrypted**, xoay vòng tự động khi còn 7 ngày |
| Web ↔ API | Access JWT 15 phút (memory) + refresh httpOnly cookie 7 ngày, có bảng revoke |
| Flash | Bật **Flash Encryption** + **Secure Boot v2** ở bản production |
| OTA | Verify sha256 + chữ ký; rollback tự động nếu boot lỗi (`esp_ota_mark_app_valid_cancel_rollback`) |
| Dữ liệu sinh trắc | Chỉ lưu **embedding**, không lưu ảnh gốc trên kiosk. Ảnh chấm công lưu server có TTL |
| Rate limit | `@nestjs/throttler` cho `/auth/login` |

---

## 8. Thứ tự thực hiện

Backlog đầy đủ ở **`docs/TASKS.md`**: 14 epic, hơn 120 task, mỗi task có điều kiện "xong khi" đo được và task chặn nó.

Đường đi lớn: nền repo → `ml/core` → dữ liệu → **detection** → recognition → anti-spoof → firmware nền → nạp và đo trên board → vòng tối ưu nếu cần → UI và chấm công → backend → frontend → bảo mật và OTA → báo cáo.

**Detection làm trước trong ba nhánh.** Hai lý do: nó là cổng của cả pipeline (không có mặt thì hai nhánh sau không chạy), và landmark của nó quyết định cách align ảnh đưa vào recognition. Train recognition trước rồi mới có detector thật thì ảnh align lúc train khác ảnh align lúc chạy — sai lệch train/serve, và là loại lỗi rất khó truy.

Firmware nền chạy song song với ba nhánh model, không phải đợi.

---

## Nguồn tham khảo

**Model**: [YOLO26 docs](https://docs.ultralytics.com/models/yolo26) · [YOLO26 paper](https://arxiv.org/abs/2606.03748) · [YuNet paper](https://link.springer.com/article/10.1007/s11633-023-1423-y) · [libfacedetection.train](https://github.com/ShiqiYu/libfacedetection.train) · [OpenCV Zoo YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) · [CDCN](https://github.com/ZitongYu/CDCN) · [Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing) · [InsightFace model_zoo](https://github.com/deepinsight/insightface/tree/master/model_zoo) · [arcface_torch](https://github.com/deepinsight/insightface/tree/master/recognition/arcface_torch) · [MobileFaceNet paper](https://arxiv.org/abs/1804.07573)

**Dữ liệu — nguồn thật đang dùng** (trang chủ của dataset ở §1.2): [WIDER FACE](https://huggingface.co/datasets/wider_face) · [RetinaFace 5-landmark](https://github.com/deepinsight/insightface/tree/master/detection/retinaface) · [CelebA-Spoof](https://huggingface.co/datasets/Ar4ikov/celebA_spoof) · [NUAA](https://huggingface.co/datasets/akahana/anti-spoofing-nuaaaa) · [UniqueData live](https://huggingface.co/datasets/UniqueData/anti-spoofing_Real) · [UniqueData replay](https://huggingface.co/datasets/UniqueData/anti-spoofing_replay) · [AxonData masks](https://huggingface.co/datasets/AxonData/face-anti-spoofing-dataset) · [MS1MV3](https://huggingface.co/datasets/gaunernst/ms1mv3-recordio) · [Glint360K](https://huggingface.co/datasets/gaunernst/glint360k-wds-gz) · [benchmark nhận diện](https://huggingface.co/datasets/gaunernst/face-recognition-eval)

**Nền tảng**: [esp-tflite-micro](https://components.espressif.com/components/espressif/esp-tflite-micro) · [ESP-NN](https://github.com/espressif/esp-nn) · [TFLite Micro memory management](https://github.com/tensorflow/tflite-micro/blob/main/tensorflow/lite/micro/docs/memory_management.md) · [esp32-camera](https://github.com/espressif/esp32-camera) · [ESP-IDF partition table](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/partition-tables.html) · [Pinout board GOOUUU ESP32-S3-CAM](https://github.com/profharris/GOOUUU_ESP32-S3-CAM)
