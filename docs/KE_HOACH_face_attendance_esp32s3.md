# Máy chấm công nhận diện khuôn mặt trên ESP32-S3 — Kế hoạch triển khai

> 🔬 = số liệu phải đo trên board thật, không được lấy từ tài liệu.

---

## Mục lục

- [1. Ba model + link + dữ liệu train](#1-ba-model--link--dữ-liệu-train)
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

## 1. Ba model + link + dữ liệu train

### 1.1 Bảng model

| Nhánh | Model | Link code / weight | Thông số | License |
|---|---|---|---|---|
| **Detect** | **YuNet (yunet_n)** | Train: [ShiqiYu/libfacedetection.train](https://github.com/ShiqiYu/libfacedetection.train) · ONNX + INT8 tham chiếu: [opencv_zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | **75.856 params**; WIDER FACE val Easy/Med/Hard **0.884 / 0.866 / 0.750** đo ở **độ phân giải gốc**, không phải ở 160×120 của dự án này (§3 lớp 2); ra box **+ 5 landmark** | **MIT** |
| **Anti-spoof** | **MiniFASNetV2-SE, một backbone** trên crop mặt 1,0× | [minivision-ai/Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing) — kiến trúc ở `src/model_lib/MiniFASNet.py` | 🔬 **≈0.26M params** (một backbone + head), ≈0.044 GFLOPs @81×81 | Research-only ⚠️ |
| **Recognition** | **MobileFaceNet (MBF)** | Cùng repo `arcface_torch`, backbone `mbf`, config `configs/*_mbf` | **1.20M params** (đo trên bản trong repo), 4.58MB FP32 → **~1.2MB INT8**, embedding 512-D | Research-only ⚠️ (code MIT, weight/data non-commercial) |

**Hai ràng buộc thiết kế quyết định bộ 3 này:**
> **Landmark chỉ có ở `train`.** Bộ `retinaface_gt_v1.1` không gán landmark cho `val`, nên
> tập đo NMSE landmark phải cắt ra từ chính `train` và không giao với phần đem train. Đo
> landmark trên `val` gốc là đo trên nhãn không tồn tại. Box thì `val` vẫn đủ, AP vẫn đo bình thường.

- Detect **bắt buộc phải ra 5 landmark**, nếu không thì không align được mặt trước khi vào MobileFaceNet, accuracy nhận diện rớt mạnh. YuNet ra sẵn 5 điểm.
- Anti-spoof là **một backbone trên crop mặt 1,0×**. Bản tham chiếu minivision dùng hai
  backbone (1,0× và 2,7×) rồi ghép, và kế hoạch đã đi theo cho tới 11/09. Đo trên 111 khung
  camera (`measurements/antispoof` §22) thì nhánh 2,7× **phân loại căn phòng thay cho khuôn
  mặt**: CelebA-Spoof để mặt thật trong ảnh sự kiện studio và mặt giả trong phòng thường,
  nên nhánh ngữ cảnh học đúng cái đó và phủ quyết mặt thật đứng trước cửa gỗ — 0,98 khi
  chỉ nhìn mặt, 0,20 khi thấy cả nền, và ghép mặt sang nền khác là đổi kết luận theo cả
  hai chiều. Bỏ nhánh wide thì model chỉ còn đọc được kết cấu da và moiré, đúng thứ định
  nghĩa bài toán, và suy luận còn **một lượt** mỗi mặt. Giá phải trả là mất cách bắt mép
  giấy hay viền màn hình nằm ngoài mặt: một phép đo cũ cho thấy bịt nhánh wide đẩy điểm
  một tập ảnh thẻ từ 0,0035 lên 0,3195 (vẫn dưới ngưỡng), nên **APCER là điều kiện nghiệm
  thu bắt buộc** của nhánh này, ngang hàng BPCER.

**Ngân sách `models_0` — đếm trên tham số thật, không phải ước lượng:**

| Nhánh | Params | ≈ INT8 |
|---|---|---|
| Detect (YuNet) | 75.631 | 76 KB |
| Anti-spoof (MiniFASNetV2-SE, một backbone) | 262.746 | **424 KB** đo trên board 12/09 |
| Recognition (MobileFaceNet, embedding 512-D) | 1.199.488 | 720 KB đo trên board |
| **Tổng** | 1.537.865 | **1.302 KB trong 2 MB** (§6.1), gồm cả detect 158 KB |

**Đã export và đo trên board 12/09**: ba file `.tflite` INT8 chiếm 1.302 KB trong partition
`models_0` 2 MB, còn dư 746 KB. Cột KB là kích thước file thật, gồm cả overhead flatbuffer,
nên nó lớn hơn cột tham số ở nhánh anti-spoof (per-channel scale và bias int32 của 42 conv).

### 1.2 Dữ liệu train — từng model

Cột **Nguồn thật** là chỗ dữ liệu được lấy về, không phải trang chủ của dataset. Nhiều bộ
gốc nằm sau Google Drive hoặc sau thoả thuận ký tay; nơi nào có mirror công khai thì dùng
mirror, và ghi rõ mirror nào để lần sau lấy lại được đúng bản đó.

**Nhánh detect**

| Dữ liệu | Nguồn thật | Kích thước | Vai trò |
|---|---|---|---|
| WIDER FACE ảnh | HF `wider_face` | train 1.37 GB / 12.880 ảnh · val 346 MB / 3.226 ảnh · split 3.4 MB | ảnh train và val |
| Bộ chấm điểm WIDER | `eval_tools.zip` của nhóm tác giả | 8.4 MB | **định nghĩa Easy/Medium/Hard** — không có nó thì mọi ngưỡng AP trong tài liệu này vô nghĩa |
| Nhãn 5 landmark | `retinaface_gt_v1.1.zip`, Google Drive của insightface | 4.49 MB | nhãn box + landmark |

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
| CelebA-Spoof | HF `Ar4ikov/celebA_spoof` (**parquet**, không phải layout gốc) | 67.1 GB | train MiniFASNet |
| NUAA Imposter | HF `akahana/anti-spoofing-nuaaaa` | 376 MB | test khác miền — ảnh in |
| UniqueData live + replay | HF `UniqueData/anti-spoofing_Real` + `_replay` | 542 MB + 702 MB, nhưng chỉ **30 người thật** (selfie + video) và **30 clip phát lại** — vài trăm khung, không đủ để train | test khác miền — màn hình phát lại, có cặp live đối chứng |
| AxonData face-anti-spoofing | HF `AxonData/face-anti-spoofing-dataset` | 4.94 GB | test khác miền — video, có **mặt nạ latex 3D** |
| LCC-FASD | Bản Kaggle [`faber24/lcc-fasd`](https://www.kaggle.com/datasets/faber24/lcc-fasd), script `00_fetch_raw.sh` tải bằng token Kaggle khai trong `ml/.env`, không form; [bài báo gốc](https://csit.am/2019/proceedings/PRIP/PRIP3.pdf) (ID R&D 2019) không vào được — **đã tải 11/09/2026** | 5,19 GB, 18.827 PNG: training 1.223 thật / 7.076 giả, development 405 / 2.543, evaluation 314 / 7.266; bố cục `LCC_FASD/LCC_FASD_{training,development,evaluation}/{real,spoof}/` | **hai vai**: split `training` (8.299 ảnh) **trộn vào train** từ arm 11/09, lặp 5 lần để chiếm ≈ 9% pool bên cạnh ≈ 418.000 bản ghi CelebA-Spoof, vì đây là bộ duy nhất có thật và giả **chụp lại bằng điện thoại trong cùng loại phòng thường** — đúng thứ CelebA-Spoof thiếu (§3, cảnh làm đường tắt); split `evaluation` (7.580 ảnh) là test khác miền, không bao giờ train; `development` (2.948 ảnh) đi vào **val** cùng 10 shard CelebA, để ngưỡng khớp trên hai miền chứ không một. **Không phải identity-disjoint**: `training` và `development` trùng 12 người, `evaluation` ẩn danh nên không kiểm được (`DU_LIEU` §4.2b), nên số trên `evaluation` của arm có trộn phải ghi kèm cảnh báo. Ảnh đã được tác giả cắt sẵn quanh mặt, nên crop 1,0× của detector nằm trong ảnh cắt đó |
| SynthASpoof | Google Drive **công khai** (`SynthASpoof.zip`, id ghi trong manifest, script `00_fetch_raw.sh` tải bằng gdown), [GitHub](https://github.com/meilfang/synthaspoof) — **đã tải 11/09/2026** | zip 12,36 GB, 103.797 PNG 256×256 đã cắt mặt: 25.000 thật tổng hợp (`BonaFide`) + 78.797 tấn công (`PAs/`: in 3.800, phát lại Samsung 24.999, iPad 24.998, webcam 25.000) | **hai vai**, tách theo ảnh: **test** lấy 2.000 ảnh trải đều mỗi kênh (10.000, giữ từng kênh riêng để đọc APCER theo thiết bị chụp lại); **train** lấy tối đa 10.000 ảnh mỗi kênh trong phần còn lại (≈ 41.800, thật 10.000 / giả 31.800), gộp một nguồn, vào pool từ arm 11/09. Mặt thật là ảnh sinh, nên bộ này không thay được ảnh thật của camera — bài báo gốc cũng train trên nó và test trên bộ thật. CC BY-NC-SA 4.0, chỉ nghiên cứu, không sản phẩm |
| Tập spoof tự thu | tự thu bằng OV5640 | vài chục clip ngắn, phủ **điều kiện** (phòng, giờ, người, vật liệu tấn công) — không cần nhiều | **kiểm chất lượng cuối**, không bao giờ train |

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
| MS1MV3 | HF `gaunernst/ms1mv3-recordio` (`train.rec` + `train.idx` + `property`) | 27.4 GB | train — **mặc định** |
| Glint360K | HF `gaunernst/glint360k-wds-gz` (**webdataset `.tar.gz`**, đã shard sẵn) | 122 GB / 1385 shard | train — khi cần nhiều ID hơn |
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

Toàn bộ chain dính research-only ở ít nhất một mắt xích (dataset nhận diện, dataset anti-spoof). Với đồ án tốt nghiệp là hợp lệ. Nếu thương mại hoá phải thay: Glint360K → dataset có license thương mại; CelebA-Spoof → tự thu. Ghi rõ trong báo cáo. Code của cả ba kiến trúc là MIT hoặc tương đương; ràng buộc nằm ở **dữ liệu và weight tham chiếu**, không ở kiến trúc.

---

## 2. Phần cứng — bảng lắp mạch từng chân

**Board**: ESP32-S3-CAM (GOOUUU / ESP32-S3-WROOM-1 **N16R8**) — 16MB Flash, 8MB **Octal** PSRAM, camera OV5640 hàn sẵn qua đế DVP.
**Pinout camera**: giống `CAMERA_MODEL_ESP32S3_EYE` trong `camera_pins.h`.

**Thứ tự chân trên hai hàng của board**, đọc từ trên xuống với **cạnh USB quay xuống dưới**.
Các bảng §2.1–§2.3 nói chân nào đi đâu; bảng này nói chân nào nằm ở đâu, và board đế cần
đúng nửa sau. Nguồn: sơ đồ silkscreen ở `GOOUUU_ESP32-S3-CAM` (§2.6).

| # | Hàng trái | # | Hàng phải |
|---|---|---|---|
| 1 | `3V3` | 1 | `IO43` |
| 2 | `EN` | 2 | `IO44` |
| 3 | `IO4` | 3 | `IO1` |
| 4 | `IO5` | 4 | `IO2` |
| 5 | `IO6` | 5 | `IO42` |
| 6 | `IO7` | 6 | `IO41` |
| 7 | `IO15` | 7 | `IO40` |
| 8 | `IO16` | 8 | `IO39` |
| 9 | `IO17` | 9 | `IO38` |
| 10 | `IO18` | 10 | `IO37` |
| 11 | `IO8` | 11 | `IO36` |
| 12 | `IO3` | 12 | `IO35` |
| 13 | `IO46` | 13 | `IO0` |
| 14 | `IO9` | 14 | `IO45` |
| 15 | `IO10` | 15 | `IO48` |
| 16 | `IO11` | 16 | `IO47` |
| 17 | `IO12` | 17 | `IO21` |
| 18 | `IO13` | 18 | `IO20` |
| 19 | `IO14` | 19 | `IO19` |
| 20 | `5V0` | 20 | `GND` |

Hai hàng cách nhau **25,4 mm**, bước **2,54 mm**. Board chỉ có **một** chân `GND` và **một**
chân `3V3` ra hàng, nên cả dòng về của board đi qua một chân duy nhất — không có chân mass
thứ hai để chia tải, và cũng không có chân nào để cắm nhầm.

🔬 **Bề ngang module ≈ 28 mm**, tức mép board chạy sát ngoài hai hàng chân chừng 1,3 mm. Chưa
đo bằng thước, chỉ nhìn module. Con số này quyết định chỗ trống hai bên devkit trên board đế,
nên vẽ rộng quá thì mất chỗ thật: bản đầu vẽ 32 mm và con tụ `C4` của màn không còn khe để lọt.
Chiều dài vẫn cố ý vẽ dư vì đầu USB và cụm camera nhô ra.

**Tên chân in ra phía ngoài hai hàng, không in vào giữa.** Khoảng giữa hai hàng chính là chỗ
thân devkit đậy xuống, nên chữ in ở đó chỉ đọc được tới đúng lúc cắm module vào — mà đó là lúc
người ta cần đọc.

Mốc để không lắp ngược: `3V3` và `IO43` là cặp **xa USB nhất**, `5V0` và `GND` là cặp **sát
USB**. Lỗ khoan trên board đế đối xứng nên nhìn board không bao giờ thấy ngược; chỉ lộ lúc
cắm, mà lúc ấy board đã in xong (§2.3I).

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
| Cỡ khung | HVGA 480×320 | đo trên board: cạnh mặt `≈ 47,7 / d` px với `d` mét, nên recognition còn pixel thật tới **0,42 m** (§3 lớp 2). VGA 640×480 nới lên 0,56 m nhưng gấp đôi số pixel đọc, fps tụt dưới sàn 12 của E7-T11 |
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

**Đọc bảng theo đúng chiều**: cột **Chân** là tên in trên **breakout của thiết bị**, cột
**Nối tới** là chân của **ESP32-S3** (hoặc của PCF8574 khi ghi rõ `P<n>`). Hai cột không
cùng một hệ số. Con VL53L1X có chân ngắt được ST đặt tên là **`GPIO1`** — đó là chân *của
sensor*, không phải `GPIO1` của ESP32, mà `GPIO1` của ESP32 là **SDA** (§2.3B). Đấu theo
cách đọc sai đó là nối ngõ ra ngắt vào đường SDA và làm chết cả bus.

#### A. LCD ST7796S 4.0" 320×480 dọc — SPI 4 dây (SPI2_HOST)

Module `KMRTM40045-SPI+CTP V1.0`, silkscreen ghi `4.0" TFT SPI 480*320`. Số điểm ảnh đúng
bằng bảng dưới tính, chỉ khác kích thước vật lý — nên nó không đụng gì tới firmware, mà đụng
tới lỗ bắt vít và vỏ máy. Header chính **14 chân một hàng**, gộp cả LCD lẫn cảm ứng; khe microSD
trên module có hàng chân riêng ở cạnh đối diện và không dùng (`RES` mượn GPIO40 vốn là `SD_DATA`).

**Thứ tự chân trên header**, đọc dọc hàng 14 chân:

```
VCC · GND · CS · RESET · DC · SDI · SCK · LED · SDO · NC · CTP_SDA · CTP_SCL · CTP_INT · CTP_RST
```

**Module có hàng chân thứ hai — 4 chân microSD ở cạnh ngắn đối diện**, đọc từ trái sang phải:

```
SD_CS · SD_MOSI · SD_MISO · SD_SCK
```

**Không nối đi đâu, nhưng board đế vẫn khoan đủ 4 lỗ — `J14`.** Dữ liệu bền nằm ở flash trong
(§6.1), kế hoạch không có microSD, nên bốn lỗ này **không có đường đồng nào**. Chúng làm hai
việc: cho chân SD (nếu module có hàn sẵn) **chui qua** thay vì kênh tấm màn lên, và để sau này
hàn dây vào mà không phải cắt board — đúng vai trò `J13` đang làm cho hàng P của PCF8574 (§2.3I).

Khoan mà không nối là rẻ, còn không khoan thì hết đường: lúc board in xong mới phát hiện module
có chân ở hàng đó thì phải tháo hàng chân ra khỏi module.

Nếu sau này thật sự dùng, ba trong bốn chân là **rẻ**: `SD_MOSI`, `SD_MISO`, `SD_SCK` dùng chung
SPI2 với chính tấm màn (GPIO41 / GPIO43 / GPIO42), chỉ `SD_CS` mới cần một chân riêng — mà §2.4
đã hết chân GPIO thường. Ứng viên duy nhất là **GPIO48**, chân board ghim mức thấp nên chỉ làm
ngõ ra được, mà `CS` đúng là ngõ ra; đổi lại mất đèn WS2812. Đó là thay đổi kiến trúc, đi qua
§1.2 của CLAUDE.md, không phải việc sửa lúc đi dây.

🔬 **Vị trí hàng SD giả định nằm giữa cạnh**, đối xứng với hàng 14 chân ở cạnh kia, và lùi vào
bằng đúng `LCD_HEADER_INSET`. Nó cách hai lỗ vít đầu trên **20 mm** nên không đụng, và có lệch
vài milimét cũng không sao khi chỉ dùng làm chỗ hàn dây. Chỉ khi module **có sẵn chân** ở hàng
đó thì vị trí mới phải đúng — lúc ấy đo thêm khoảng cách từ mép trái tấm màn tới chân `SD_CS`.

Đã đối chiếu với module 12/09. Board đế khoan 14 lỗ đối xứng nên lắp ngược vẫn cắm vừa, và khi
đó `VCC` rơi vào chỗ `CTP_RST` — nguồn 3V3 đổ thẳng vào ngõ ra reset của GT911. Đầu `VCC` là
đầu có chân thứ hai (`GND`) thông mạch 0 Ω với vỏ kim loại khe microSD; đầu kia chân thứ hai là
`CTP_SCL`, có trở treo nên đọc ra vài kΩ. Soi lại bằng phép đo đó mỗi lần thay module.

**Bốn lỗ bắt vít — hàng chân không phải chỗ chịu lực.** Tấm màn cắm xuống `J3` ở **một cạnh**,
cạnh đối diện thả tự do. Kiosk dựng màn đứng, nên trọng lượng tấm màn và mỗi lần người dùng ấn
lên cảm ứng đều dồn vào 14 mối hàn của hàng chân. Mối hàn chân cắm chịu nén tốt và chịu bẩy rất
kém: hỏng theo kiểu nứt chân tóc, lúc đầu chỉ chập chờn một hai chân, và trông y hệt lỗi phần mềm.

| Hạng mục | Chốt |
|---|---|
| Vít | **M3**, board đế khoan **Ø3,2 mm**. Lỗ trên tấm màn đo được **Ø3,5** — đúng cỡ thoát vít M3 |
| Trụ | Trụ đồng cái–cái **M3 × 8 mm** |
| Số lượng | **4**, bốn góc tấm màn |
| Chịu lực | Hai lỗ ở **cạnh tự do** giữ tấm màn; hai lỗ cạnh `J3` chỉ chống xoay |

Trụ **không được cao hơn** 8,5 mm là chiều cao tấm màn ngồi trên đế cắm `J3`. Cao hơn thì tấm
màn tì lên trụ và chân chưa vào hết đế — đúng cái lỗi mà bốn con vít sinh ra để chữa. Thấp hơn
một chút thì ngược lại, vít kéo tấm màn xuống và chân cắm sâu thêm, vô hại vì đế còn dư hành
trình. Nên chọn **8 mm**: 8,5 không phải chiều dài bán sẵn, còn 8 thì có ở mọi hàng ốc vít.

Bắt đế cắm xuống board trước, đặt tấm màn lên, rồi mới siết vít — siết trước là ép chân vào đế
lệch trục.

**Kích thước tấm màn: 107 × 61 mm** (đo 12/09). Nó quyết định luôn chiều cao board đế: 107 mm
cộng chỗ cho hàng chữ tên chân ở **cả hai đầu** là **121 mm** — mỗi đầu phải chừa đủ 4,3 mm cho
một chuỗi như `CTP_SDA` cộng lề mép. Tấm màn vì thế phủ gần trọn chiều cao board, và dải còn
lại dưới mép tấm màn không nhét vừa một con tụ nào. Vì thế tụ `C4` của màn nằm **bên
trái** tấm màn, trong khe giữa devkit và tấm màn, chân dương **thẳng hàng với chân `VCC` của
`J3`** và cách nó **18,4 mm**; nó là tụ trữ chứ không phải tụ lọc cao tần nên quãng đó chấp
nhận được, còn lọc cao tần thì module màn tự mang.

Khe đó rộng **8,76 mm** cho một thân tụ 6,3 mm, tức hở đều **0,98 mm** hai bên — và để có được
chừng đó thì devkit phải dịch sang trái 2 mm. Đường bao của devkit vì thế chỉ còn cách mép trái
board 1,75 mm, nhưng đường bao đó **cố ý vẽ rộng hơn thân thật** (§2.6 không có datasheet cho
board này), nên mép thật của module vẫn cách mép board khoảng 4 mm.

**Kính không nằm giữa PCB, và chỗ dôi ra là chỗ để hàng chân với lỗ vít.** Vùng hiển thị của
tấm 4,0" tỉ lệ 3:2 là **84,5 × 56,4 mm** (suy từ đường chéo, không phải số đo), nên so với PCB
107 × 61:

| Chiều | PCB | Kính | Dôi mỗi bên |
|---|---|---|---|
| Rộng | 61 | 56,4 | **2,3 mm** |
| Dài | 107 | 84,5 | **11,2 mm** |

Hai con số đó ràng buộc thiết kế theo hai hướng ngược nhau. Cạnh dài chỉ dôi **2,3 mm** nên
**không khoan được lỗ vít ở giữa hai cạnh dài** — lỗ Ø3,5 cần nhiều hơn thế. Cạnh ngắn dôi
**11,2 mm**, đủ rộng cho cả hàng chân lẫn hai lỗ vít, và đó là lý do bốn lỗ đặt ở **bốn góc**:
góc là chỗ duy nhất có vật liệu.

Cùng con số đó chặn khoảng lùi của hàng chân ≤ **11,2 mm** — hàng chân phải nằm trong dải dôi,
không thể chui xuống dưới kính.

**Hàng chân nằm ngang hàng với hai lỗ vít đầu dưới**, nhích về phía mép khoảng **1 mm** (nhìn
trên module 12/09). Nhờ đó hai khoảng lùi không còn độc lập: đo lỗ là biết luôn hàng chân, nên
`LCD_HEADER_INSET` suy ra từ `LCD_HOLE_INSET` chứ không khai riêng. `J3` tụt xuống `y = 107,5`
cho mép xa của tấm màn không tràn khỏi mép trên board, và hàng chữ tên chân của nó rơi **ngay
dưới** mép tấm màn — tức là vẫn đọc được sau khi lắp màn, không bị che.

🔬 **Còn đúng một số chưa đo, và nó quyết định bốn lỗ có bắt được vít hay không.** Vít M3 qua
lỗ Ø3,5 của tấm màn rồi qua lỗ Ø3,2 của board đế chỉ xê dịch được **0,35 mm**; lệch 1 mm là không
bắt được. Khai ở đầu
`hardware/gen/gen_pcb.py`, sửa xong sinh lại là bốn lỗ lẫn `J3` tự dịch theo:

| Hằng số | Đang đặt | Nguồn |
|---|---|---|
| `LCD_HOLE_INSET` | 3,5 mm | 🔬 **phải đo**: từ **tâm lỗ** tới mép tấm màn |
| `LCD_HEADER_DROP` | 1,0 mm | Hàng chân thấp hơn hàng lỗ bao nhiêu, nhìn trên module |
| `LCD_HEADER_INSET` | 2,5 mm | Suy ra: `LCD_HOLE_INSET − LCD_HEADER_DROP` |

Đo tới **tâm lỗ**, không đo tới mép lỗ. Và nếu bốn lỗ trên tấm màn **không** đối xứng thì báo
lại: lúc đó phải khai từng lỗ một chứ không suy ra từ một con số lùi vào.

| Chân LCD | GPIO | Vai trò | Lưu ý |
|---|---|---|---|
| VCC | 3V3 | | |
| GND | GND | | |
| SCL / SCK | **GPIO42** | SPI CLK | **80 MHz** — ở 40 MHz một khung 307 KB mất 61 ms, màn hiện hai khoảnh khắc cùng lúc và mặt di chuyển thấy rõ vạch |
| SDA / MOSI | **GPIO41** | SPI MOSI | |
| SDO / MISO | **GPIO43** | Đọc thanh ghi panel | Chỉ dùng cho `GET_SCANLINE` để khoá pha (xem dưới). Đọc **3 MHz**: dưới 2 MHz ESP32 lấy mẫu sai, trên 6,6 MHz vượt chu kỳ đọc 150 ns của datasheet |
| CS | **GPIO47** | Chip select | |
| DC / RS | **GPIO39** | Data / Command | Chân thường. Không đặt trên GPIO45: board LCD hay có pull-up ở DC, mà GPIO45 là strapping VDD_SPI — kéo lên lúc reset là chọn flash 1.8 V và board không boot |
| RES | **GPIO40** | Reset panel | (nguyên là SD_DATA — trống vì không dùng microSD) |
| BLK | **GPIO21** | Backlight | LEDC PWM 5 kHz. Nếu backlight > 40 mA → qua MOSFET N (AO3400) |

**Khoá pha để preview không bị xé hình.** Panel quét lại bộ nhớ ảnh của nó theo nhịp riêng,
không đồng bộ với lúc firmware ghi. Đo trên board: một khung 320×480 RGB565 (307 KB) mất
**31,7 ms** để ghi ở 80 MHz, còn chu kỳ quét mặc định là **17,5 ms** — nên trong lúc ghi,
tia quét lướt qua vùng đang ghi ~1,8 lần và mỗi lần để lại một vết cắt ngang giữa phần khung
mới và phần khung cũ. Mặt người di chuyển thấy rõ.

Điều kiện để hết hẳn: **con trỏ ghi phải chạy trước tia quét trọn cả khung**. Cần hai thứ:

| Điều kiện | Cách đạt |
|---|---|
| Chu kỳ quét **dài hơn** thời gian ghi | `FRMCTR1 (0xB1) = 0x81 0x1F` → **42,98 ms** đo được (23,26 Hz) |
| Bắt đầu ghi ngay trước lúc tia quét về dòng 0 | Đọc `GET_SCANLINE (0x45)` qua `SDO` mỗi 1 ms, thấy bộ đếm vào đoạn **220…241** thì ghi |

Bộ đếm của `0x45` chạy **0…241**, mỗi đơn vị bằng 2 dòng vật lý. Bắt đầu ở đoạn cuối chứ
không đợi đúng lúc cuộn vòng: con trỏ ghi xuất phát từ dòng 0 trong khi tia quét còn đang
quét 44 dòng cuối, nên có đà trước; tia quét cuộn về 0 rồi đuổi theo với tốc độ 90 µs/dòng
so với 66 µs/dòng của con trỏ ghi — ghi nhanh hơn quét **36%**, không bao giờ bị bắt kịp.
Đọc `0x45` không được thì ghi ngay như không có khoá pha: một khung bị xé tốt hơn một preview
đứng hình.

**Đọc thanh ghi qua `esp_lcd` cần một điều `esp_lcd` không nói ra.** Sau mỗi giao dịch của
nó, `esp_lcd_panel_io_spi` **tắt driver ngõ ra của chân DC** (`post_cb` gọi
`gpio_ll_output_disable`) và chỉ bật lại trong `pre_cb` của giao dịch kế. Một lệnh đọc gửi
bằng thiết bị SPI khác trên cùng bus mà chỉ `gpio_set_level(DC, 0)` sẽ **không kéo được
chân xuống** — DC thả nổi lên mức cao theo điện trở kéo của module, panel coi lệnh là dữ liệu
và im lặng. `drv_lcd` vì thế bật lại ngõ ra DC trước mỗi lần đọc, và tự sở hữu chân CS (giao
`cs_gpio_num = NC` cho `esp_lcd`) để nhấp được một khung CS riêng cho lệnh đọc — panel đếm
clock từ cạnh xuống của CS, lệnh đọc không có khung riêng sẽ rơi vào giữa khung pixel.

**Vì sao lấy 23,26 Hz mà không lấy mức nhanh hơn.** Quét cả dải thanh ghi thì `0x81 0x10`
cho 33,18 ms (30,13 Hz), chỉ hơn thời gian ghi 4,8%. Hai lý do bỏ nó: phép đo chu kỳ quét
chỉ chính xác ~15% (cùng một giá trị thanh ghi đo hai lần ra 37,3 ms và 43,0 ms), và §5.1 đã
đo preview chạy song song với AI thì chậm đi **16,6%** — blit sẽ thành ~37 ms khi `ai_task`
chạy, lúc đó mức 30 Hz hết biên còn mức 23,26 Hz vẫn dư 14%.

**Quét 23,26 Hz thì panel nhấp nháy, và cái chữa là VCOM chứ không phải tần số.** Điểm ảnh TFT
được nạp lại thưa hơn nên mọi lệch điện áp chung (VCOM, `0xC5`) hiện ra thành rung sáng; ở 57 Hz
cùng độ lệch đó mắt không thấy. Thư viện `esp_lcd_st7796` cài `0xC5 = 0x18` cho panel chung, và
module này rung với giá trị đó — thấy rõ trên **xám tĩnh 50%**, tức là lỗi của panel, không phải
của camera. Đo 11/09 bằng cách quét `0xC5` trên xám 50% ở 23,26 Hz, mỗi mức 6 s, mắt chấm:
`0x00`–`0x28` rung, **`0x2C`–`0x34` êm**, `0x38`–`0x3C` rung lại. `drv_lcd` cài **`0x30`**, giữa
dải êm để còn biên hai phía cho trôi nhiệt. Trên thang xám 5 dải (đen, 25%, 50%, 75%, trắng) thì
**dải trắng vẫn rung** ở cả `0x2C`, `0x30`, `0x34` với đảo cực 1-dot (`0xB4 = 0x01`, mặc định thư
viện) và cả 2-dot (`0x02`); chuyển sang **column inversion (`0xB4 = 0x00`)** thì trắng êm. `drv_lcd`
cài cả hai. 🔬 Chấm bằng mắt lúc 11/09 khuya dưới đèn học; **nghiệm thu lại ban ngày trên ảnh
camera** trước khi coi là xong. Độ phân giải, số màu và fps của ảnh **không đổi** — 23,26 Hz là nhịp
làm mới của panel, không phải nhịp đổi nội dung (camera quyết định, 14,19 fps).

**Đã thử và loại: giữ 57 Hz gốc bằng cách đổi cửa sổ pha.** Trên giấy còn một cách không phải
quét chậm: bắt đầu ghi **ngay sau khi tia vừa qua đỉnh** thay vì trước lúc về đỉnh. Tia nhanh hơn
con trỏ ghi 1,8× nên chạy trước suốt vòng đầu (hiện toàn khung cũ), quay lại đỉnh ở 17,5 ms và chỉ
đuổi kịp con trỏ ghi ở `T_s·T_w/(T_w−T_s)` = 39,1 ms, sau khi ghi đã xong ở 31,7 ms — điều kiện
chung là `T_w < 2·T_s` (31,7 < 35 ms ✓). Đo 11/09 với cửa sổ bộ đếm 0…24: **khấc quay lại**. Biên
3,3 ms trên giấy không sống được với đường nạp bounce buffer 30 KB (DMA 3,07 ms mỗi buffer, CPU
phải kịp đổ đầy buffer kia), nên mọi lần trễ vài ms là tia đuổi kịp ở đáy màn. Cách này chỉ dùng
lại được nếu vùng preview nhỏ đi (320×360 → `T_w` 23,8 ms, biên 11 ms) — quyết định của `ui_kiosk`
(E10), không phải của driver.

#### B. Bus I2C hệ thống (I2C_NUM_0, 400 kHz)

| Tín hiệu | GPIO | Ghi chú |
|---|---|---|
| SDA | **GPIO1** | Chính là chân QWIIC trên board |
| SCL | **GPIO2** | |
| Pull-up | 4,7 kΩ lên 3V3 | **Đo trên board này**: SCL đã có trở treo của module cảm ứng, SDA không có nên dùng một trở ngoài |

**Mỗi đường đúng một trở treo trên toàn bus**, tháo trở của các board thêm vào sau. Pull-up
nội ~45 kΩ của chip **để tắt** (`enable_internal_pullup = false`): bật lên thì bus chạy được
mà không cần trở ngoài, nhưng 45 kΩ trên điện dung breadboard cho sườn lên chậm, mà GT911 và
VL53L1X cùng chia bus này. Sàn của trở treo ở 3,3 V là ~1 kΩ, suy từ `Vol` 0,4 V ở dòng nhận
3 mA: cắm thêm một module tự mang trở treo thì mỗi đường còn ~2,35 kΩ, vẫn trong khoảng chạy
được; xuống dưới 1,5 kΩ mới phải tháo bớt. Trạng thái từng chân đọc bằng
`bsp_board/test_apps/buses` — app đo riêng từng đường, không suy từ cả cặp.

| Thiết bị | Địa chỉ |
|---|---|
| GT911 (touch) | `0x5D` (mặc định) hoặc `0x14` |
| VL53L1X (ToF) | `0x29` |
| PCF8574 (I/O expander) | `0x20` (A2A1A0 = GND GND GND) |
| DS3231 (RTC) | `0x68` |
| AT24C32 trên module RTC — **không dùng** | `0x57` (bản clone `0x50`) |

**`bsp_board_init()` phải chờ bus trả lời, không được trả về ngay sau khi tạo bus.**
`i2c_new_master_bus()` thành công không có nghĩa bus chở được giao dịch: thiết bị cần thời
gian sau khi ESP32 boot. Đo trên board:

| Mốc | t+ |
|---|---|
| `bsp_board_init()` xong nếu không chờ | **4 ms** |
| PCF8574 `0x20` ACK lần đầu | **5 ms** |
| VL53L1X `0x29` ACK lần đầu | **17 ms** |

Ở t+4 ms **không con nào trả lời**, trong khi SDA và SCL đều đã idle mức 1 — nên đây không
phải thiếu pull-up mà là cuộc đua vài millisecond. Driver nào chạm bus ngay sau
`bsp_board_init()` thì NACK; driver nào chậm vài ms thì chạy, nên lỗi đổi mặt theo từng lần
sửa code và trông như ngẫu nhiên. **Reset chip không tái hiện được** vì ngoại vi vẫn đang có
điện và đã sẵn sàng từ trước — chỉ lần cấp điện đầu mới lộ, tức đúng lúc người dùng cắm máy
lần đầu. Bảng này chỉ có hai thiết bị: mốc của GT911 không dùng được vì phép đo cũ chạy lúc
đầu cắm cảm ứng còn lỏng (§2.3C), và nó cũng không cần — GT911 không nằm trong danh sách chờ.

Chốt: `bsp_board_init()` thăm dò **những thiết bị có địa chỉ cố định lúc cấp nguồn** —
`0x20` và `0x29` — tới khi cả hai ACK, trần **500 ms** (≈29× mốc 17 ms, chỗ chậm nhất trong
hai con được chờ), quá trần thì trả lỗi kèm địa chỉ nào im. GT911 **không** nằm trong danh sách chờ vì địa chỉ của nó
do trình tự reset ở §2.3C quyết định, nên `drv_touch_init()` tự lo con của mình.

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

**Mốc giữ RST: 10 ms, đã nghiệm thu.** Datasheet GT911 đòi RST giữ thấp ≥ **100 µs**;
`APP_TOUCH_RST_HOLD_MS = 10` là biên gấp 100 lần con số đó. Đo trên board bằng probe chạy
**4 kiểu trình tự × 3 tốc độ bus × 6 mốc chờ**, trong đó có kiểu giữ RST thấp đúng 10 ms:
đọc ra `"911"` **72/72 lần**, kèm thanh ghi cấu hình `version 0x61, x_max 320, y_max 480,
5 điểm`. Cạnh **lên** của RST mới là cạnh chịu ảnh hưởng của nguồn đẩy ~100 µA ở PCF8574,
và mốc giữ INT **sau** khi nhả RST (50 ms) đã phủ nó.

Và **INT phải trả về input sau khi chốt địa chỉ**: nó là ngõ ra *của bộ điều khiển*, giữ nó
ở mức thấp từ phía ESP32 là tranh chấp chân.

⚠️ **Đầu cắm lớp cảm ứng trên module LCD phải vào hẳn.** Cắm lỏng thì bộ điều khiển vẫn ACK
ở `0x5D` và vẫn phục vụ *một* giá trị cho thanh ghi mã sản phẩm — nhưng là giá trị sai, và
**ổn định qua hàng chục lần khởi động**, nên nó trông y như một lỗi logic chứ không như một
lỗi tiếp xúc. Đây là lý do `drv_touch_init()` đòi đúng ba byte `"911"` ở `0x8140` thay vì
tin vào việc con chip có ACK: component GT911 của Espressif in mã sản phẩm ra log mà không
kiểm nó.

#### D. ToF VL53L1X

**Thứ tự chân trên header**, đọc từ module: `VIN · GND · SCL · SDA · GPIO1 · XSHUT`.
Một hàng 6 chân. Bảng dưới nói chân nào đi đâu, không nói thứ tự.

| Chân | Nối tới | Ghi chú |
|---|---|---|
| VIN | 3V3 (breakout có LDO nên 3.3–5 V đều được) | |
| GND | GND | |
| SDA / SCL | GPIO1 / GPIO2 | bus chung |
| **`GPIO1` của sensor** = ngõ ra ngắt (một số breakout in là `INT`) | **ESP GPIO3** | Không liên quan gì tới `GPIO1` của ESP32 — chân đó là SDA. ESP GPIO3 nằm trong dải RTC GPIO (0–21) → **dùng làm nguồn đánh thức deep-sleep**. ⚠️ Strapping JTAG-source: để hở lúc boot, VL53L1X chỉ kéo xuống sau khi được cấu hình → an toàn |
| **XSHUT** | **PCF8574 P1** | P1 lên HIGH lúc cấp nguồn nên VL53L1X tự chạy ở địa chỉ mặc định `0x29` — đúng thứ ta cần vì chỉ có một con. P1 chỉ dùng để reset lại lúc chạy |

**Cấu hình đo, suy từ dải làm việc đo được.** Recognition chặn dải ở 0,25–0,42 m (§3 lớp
2), nên ToF chỉ cần với tới nửa mét chứ không phải bốn mét:

| Tham số | Giá trị | Vì sao |
|---|---|---|
| Distance mode | **Short** | Với tới 1,3 m, thừa cho 0,42 m, và là chế độ **chống nhiễu sáng môi trường tốt nhất** — kiosk quay ra phòng có đèn và có thể có nắng |
| Timing budget | **33 ms** | Trọn trong chu kỳ 100 ms của `tof_task` (§5.2), còn dư cho jitter |
| Inter-measurement | **100 ms** | Bằng đúng chu kỳ §5.2 đã khai, nên không có phép đo nào bị bỏ |

Ba con này **suy ra từ bảng chế độ của datasheet**, chưa đo trên board — E7-T7 đo lại độ
lệch thật ở 0,25 / 0,35 / 0,42 m rồi chốt.

**Ngưỡng "có người" không nằm ở đây.** Nó là ngưỡng nghiệp vụ, nên theo §4.9 nó ở **NVS
trên kiosk và đổi được bằng `SET_CONFIG`** — khoá `vision.present_mm` của §6.2.1. `drv_tof`
chỉ trả khoảng cách, không tự quyết định có người hay không; việc biến khoảng cách thành
`EVT_PRESENCE_ON/OFF` là của `tof_task`, và §5.3 khai đường truyền của hai event đó.

#### E. Âm thanh MAX98357A (I²S) + loa 4Ω/3W

**Thứ tự chân trên header**, đọc từ module: `LRC · BCLK · DIN · GAIN · SD · GND · Vin` — một hàng
**7 chân**. Ngõ ra loa **không** nằm trên hàng này: module có domino 2 chân riêng ở mép đối diện,
nên **loa đấu thẳng vào module**, board đế không mang đầu nối loa nào.

| Chân | Nối tới | Ghi chú |
|---|---|---|
| VIN | **5V của rail 1** | Không lấy 3V3 vì mất công suất, và **không lấy chân 5V của board**: chân đó đi từ cáp USB, không tải nổi đỉnh 600 mA của amp — đo 10/09: tiếng nhỏ rồi rè, và đường USB của board rớt 3 lần khi phát to |
| GND | GND | |
| **BCLK** | **GPIO45** | GPIO43 đã giao cho `SDO` của LCD (§2.3A). GPIO45 là strapping VDD_SPI nhưng chỉ lấy mẫu **lúc reset**, mà I2S không đẩy chân lúc reset và chân có pull-down nội — đo trên board: kéo lên 20/20 mức cao, kéo xuống 0/20, tức trống thật |
| **LRC / WS** | **GPIO44** | Nguyên là U0RXD, và **có trở kéo lên thụ động sẵn trên board** — đo 10/09: bật trở kéo xuống nội vẫn đọc mức 1, nhưng chip đẩy được cả hai mức nên I2S vẫn đúng. Hệ quả: **rút dây LRC ra thì amp không im mà nhả tiếng rác to**, vì nó vẫn chốt bit từ DIN nhưng lệch hàng khung nên biên độ nhảy gần đỉnh thang. Nghe được tiếng lúc thiếu dây khung không bao giờ là dấu hiệu tốt |
| **DIN** | **GPIO46** | Strapping này chỉ chọn mức log ROM, không chặn boot. DIN là input trở kháng cao, pull-down nội của chip đã đủ — không cần hàn điện trở |
| **SD (shutdown/mode)** | **PCF8574 P3** | Kéo LOW khi không phát → hết nhiễu xì. Hoặc nối 100 kΩ lên VIN = chế độ mono (L+R)/2 |
| GAIN | để hở | = 9 dB. Nối GND = 12 dB |
| OUT+ / OUT− | Loa | Ngõ ra **cầu (BTL)** — **tuyệt đối không nối OUT− xuống GND** |
| Tụ lọc | 470–1000 µF gần VIN, **chân dài (+) về VIN, chân vạch sọc (−) về GND** | Bắt buộc, nếu không sẽ reset board khi phát to. Cắm ngược cực thì tụ dẫn dòng và kéo sập VIN: amp rè rồi câm hẳn trong khi mọi chân tín hiệu vẫn đúng (đo 10/09). **Tụ đã cắm ngược một lần thì thay tụ mới, không cắm lại**: nội trở tăng vĩnh viễn, và khối ra class-D vẫn băm ~300 kHz kể cả khi đầu vào bằng 0 nên rail thiếu điện tích là rè ngay dù không có tín hiệu. Chân tụ trên breadboard rất dễ lỏng, và **rung của servo che được một chân lỏng** — đo 10/09 mất cả buổi vì chỗ này |

#### F. Chấp hành — servo SG90 + thanh chắn

Board có **một** bộ chấp hành: servo gạt thanh chắn mở cửa mô hình. Không có relay, không có ngõ ra dành sẵn cho khoá điện — lắp khoá sau này là một thay đổi kiến trúc mới, đi qua §1.2 của CLAUDE.md. `svc_door` bọc servo sau `IDoor` (§4.5.5e) để logic chấm công không biết bên dưới là gì và để test trên host cắm được cửa giả vào cùng chỗ.

**Thứ tự chân trên giắc SG90**: `GND (nâu) · VCC (đỏ) · PWM (cam)`. Mass và tín hiệu nằm ở hai
đầu, nên vẽ ngược thứ tự là cắm servo vào thì mass của nó rơi lên chân GPIO38 đang đẩy xung.

| Chân | Nối tới | Ghi chú |
|---|---|---|
| PWM (vàng) | **GPIO38** | Phải là GPIO thật (LEDC hoặc MCPWM, 50 Hz) — **không** qua PCF8574 |
| VCC (đỏ) | **Rail 2 — nguồn 5 V riêng** (§2.5) | SG90 stall ~700 mA và cú sụt áp đó đủ làm ESP32 brownout giữa lúc mở cửa |
| GND (nâu) | GND chung với ESP32 | Bắt buộc chung mass, nếu không xung PWM không có mốc tham chiếu |

Tụ 470 µF sát chân nguồn servo. Xung 50 Hz, độ rộng 500–2400 µs quét hết tầm ~180°. `drv_servo` phát xung từ LEDC timer 1 / kênh 1 (timer 0 / kênh 0 là đèn nền, §2.3A), 14 bit → 1,22 µs mỗi bậc. Lúc khởi động và sau `drv_servo_release()` chân ở mức thấp, không xung: tay servo thả lỏng và motor không ăn dòng. Hai góc cơ khí của thanh chắn khai ở `app_config.h`: **đóng 0°, mở 90°**.

Đo 10/09 bằng cách bật tầng vào của pad và đọc ngược trong lúc LEDC đang lái: 0° / 90° / 180° → **500 / 1450 / 2400 µs**, chu kỳ 20,00 ms, mức nghỉ 0 dù board vốn ghim GPIO38 mức cao (§2.4) — driver ngõ ra của ESP thắng đường kéo đó, nên tín hiệu tới header là thật.

#### G. PCF8574

**Kích thước module: 48 × 16 × 15 mm.** Cao 15 mm nên nó **không lọt xuống dưới tấm màn** (màn
đứng cách board 8,5 mm trên đế cắm), phải đặt ngoài vùng màn.

**Module có hai hàng chân vuông góc nhau, không phải một.** Cạnh dưới (và cạnh trên, nối song song
để nối tiếp nhiều module) là hàng 4 chân `SCL SDA GND VCC`; cạnh phải là hàng 9 chân `P0…P7 INT`.
Board đế vì thế cần **hai đế cắm**, không phải một hàng 16.

`A0/A1/A2` **không phải chân**: chúng là ba bãi hàn chọn địa chỉ trên chính module. Để `0x20` thì
hàn cả ba xuống GND **trên module**, board đế không có đường đồng nào tới đó.

| Chân | Gán cho |
|---|---|
| A0 / A1 / A2 | hàn xuống GND **trên module** → địa chỉ `0x20` |
| SDA / SCL | GPIO1 / GPIO2 |
| INT | không dùng (poll trong `io_task`) |
| **P0** | GT911_RST |
| **P1** | VL53L1X_XSHUT |
| P2 | dự phòng |
| **P3** | MAX98357_SD |
| P4–P7 | dự phòng |

Trạng thái nhận diện hiện trên LCD nên không có LED rời. Mọi chân P đều lên HIGH lúc cấp nguồn (§2.3.C) — chỉ giao cho P những việc mà mức HIGH lúc khởi động là vô hại: RST và XSHUT thả cao là chip được chạy, SD của amp ở cao là amp thức nhưng chưa có dữ liệu I²S, và `drv_audio_init` kéo P3 xuống trước khi bật clock. Cơ cấu mở cửa **không** đi qua PCF8574 vì lý do đó: mức HIGH lúc cấp nguồn trên một chân mở cửa là cửa mở.

#### H. RTC DS3231

**Module không nằm trên board đế.** Nó cắm dựng, thân đứng ra khỏi mặt board, nên board chỉ cần
6 lỗ chứ không phải chừa vùng 19 × 42 mm nào.

**Thứ tự chân**, đọc từ module ZS-042 (42 × 19 mm): hàng 6 chân là
`32K · SQW · SCL · SDA · VCC · GND`; cạnh đối diện có thêm hàng 4 chân `SCL SDA VCC GND`
nối song song để nối tiếp nhiều thiết bị. Board đế dùng hàng 6.

| Chân | Nối tới | Ghi chú |
|---|---|---|
| VCC | **3V3** | **Không nuôi 5 V**: module có trở treo lên chính VCC của nó, nuôi 5 V là kéo SDA/SCL lên 5 V, đúng hai chân của ESP32-S3 và GT911 |
| GND | GND | |
| SDA | GPIO1 | bus chung |
| SCL | GPIO2 | bus chung |
| SQW / 32K | không nối | Đánh thức deep-sleep đã có ngắt VL53L1X ở GPIO3 (§2.3D) |

Không tốn thêm chân GPIO nào, chỉ thêm một địa chỉ trên bus I2C đang có, nên `m_i2c` (§5.3)
đã đếm sẵn nó là thiết bị thứ tư. Module bán kèm một EEPROM AT24C32 ở `0x57`: **không dùng**,
vì chỉ `sys_storage` được giữ dữ liệu bền và trong kế hoạch không có EEPROM ngoài.

⚠️ **Pin trên module.** Loại ZS-042 phổ biến có mạch sạc cho pin LIR2032. Cắm pin CR2032
không sạc lại vào đó thì phải bỏ điện trở sạc trước, không thì pin phồng. Soi bằng mắt khi
hàng về, trước khi cấp nguồn lần đầu.

#### I. Hàn hàng chân cho module cắm xuống board đế

Luật chung cho cả năm module, vì sai một lần là hỏng một module:

**Mọi hàng chân của một module phải chĩa cùng một phía, và phía đó là xuống board đế.** Module
nằm ngửa, mặt linh kiện hướng lên, đọc được chữ sau khi lắp, và thứ tự chân khớp đúng silkscreen.
Hàn ngược lên mặt linh kiện thì phải lật úp module mới cắm được, và khi đó **thứ tự chân soi
gương** — VCC vào chỗ SCL. Lỗ khoan đối xứng nên nhìn board không bao giờ thấy sai, chỉ lộ lúc
cắm module vào, mà lúc ấy board đã in xong.

**Cắm hàng chân xuống đế trên board trước, rồi mới úp module lên hàn.** PCF8574 có hai hàng vuông
góc cách nhau 48 mm; hàn rời từng hàng thì lệch một hai độ là hai hàng không còn khớp hai đế.
Để đế trên board làm khuôn thì nó tự thẳng.

**Ngoại lệ duy nhất: PCF8574.** Hai hàng chân của nó chĩa hai phía ngược nhau, nên chỉ một hàng
cắm xuống được. **Hàng 4 chân nguồn hàn chĩa xuống, cắm vào đế `J5`.** Hàng P giữ nguyên chĩa
lên: dây cắm vào chân P ở đầu này, đầu kia tuốt trần **hàn xuống hàng lỗ `J13`** đặt cạnh module.

`J13` có đủ **9 lỗ** dù chỉ ba sợi được hàn (`P0 P1 P3`) — sáu lỗ còn lại để sau này thêm tín
hiệu mà không phải cắt board.

Hàng chân nào không dùng thì **để trống, đừng hàn** — hàng 4 chân I2C thứ hai của PCF8574 chỉ
để nối tiếp thiết bị khác, mà board đế đã có đế riêng cho từng thiết bị rồi.

**Tên chân in lụa phải nằm ngoài thân module, không nằm dưới nó.** Chỗ duy nhất cần đọc tên
chân là lúc cắm module vào và lúc dò lỗi — mà đó đúng là lúc thân module đậy lên vùng của nó.
Chữ in trong vùng ấy đọc được cho tới đúng giây phút nó trở nên cần thiết, rồi biến mất.

Luật khi vẽ: chữ chạy **vuông góc với hàng chân**, và mọc ra **phía mép gần nhất của khung
module**, không phải theo một hướng cố định. Hệ quả là mỗi con một hướng — `J5` hất lên vì thân
PCF8574 dài 48 mm đổ xuống dưới nó, `J3` hất xuống vì tấm màn cao 107 mm đổ lên trên, `J7` hất
sang trái. Chiều cao board (121 mm) và khe giữa tấm màn với khung con amp đều là hệ quả của luật
này chứ không phải chọn trước. `tools/check_pcb.py` bắt lại: chữ nào rơi vào khung module thì fail.

**Ba khe quanh tấm màn để bằng nhau: 7,3 mm.** Tấm màn cách devkit, cách khung PCF8574 và cách
khung MAX98357A đúng một khoảng. Con số 7,3 không chọn cho đẹp mà do **thân tụ `C4` chặn**: nó
6,3 mm và nằm trong khe bên trái, nên khe không hẹp hơn được. Cân bằng bằng cách đẩy tấm màn
sang trái 1,46 mm và cả cụm bên phải sang phải 1,85 mm — chia đôi đơn thuần thì ra 6,38 mm và
con tụ chỉ còn hở 0,04 mm mỗi bên.

**Board đế có lỗ bắt của riêng nó — `H5`…`H9`, năm lỗ M3.** Bốn lỗ `H1`…`H4` giữ *tấm màn vào
board*, không giữ *board vào cái gì*. Thiếu chúng thì cả cụm màn cộng board treo lơ lửng trong
vỏ, mà hai con domino lại là chỗ người ta vặn vít siết dây vào — lực đó phải có chỗ truyền xuống.

Không đủ bốn góc: góc trên trái đã có con ToF đứng, góc dưới phải đã có hai con domino. Hai lỗ
đó trượt dọc mép thay vì nằm đúng góc. Vẫn cùng cỡ **M3 Ø3,2** với lỗ bắt màn, nên cả board chỉ
dùng một cỡ vít.

**Khung thân của mọi module ở hàng trên bắt đầu cùng một đường: mép trên tấm màn, y = 7.** Trước
đó VLX cao hơn 2 mm và PCF8574 cao hơn 1 mm — không phải quyết định nào cả, chỉ là số gõ vào lúc
xếp thô. Ba khung lệch nhau vài milimét thì nhìn ra ngay là board chưa được căn, và cái nhìn đó
đúng: chưa ai căn thật. Devkit tụt xuống theo VLX để cột trái giữ nguyên khoảng cách.

**Đế cắm phải nằm chính giữa khung của module nó đỡ.** Lệch thì module ngồi hẫng một bên, và
trên board đế nó hiện ra thành cái khung nét đứt không cân với hàng lỗ bên trong. Căn theo
**trục mà hàng chân chạy** — hàng ngang căn theo chiều ngang khung, hàng dọc căn theo chiều dọc.
`tools/check_pcb.py` bắt lệch quá 0,3 mm.

Luật đó áp cho **cả tên linh kiện** (`J3`, `J5`, …), không riêng tên chân — chữ `J5` nằm dưới
thân con PCF8574 thì cũng vô dụng y như chữ `SCL` nằm đó. Tên linh kiện đặt ở **đầu hàng chân**,
lùi ra cùng phía với tên chân. Riêng bốn lỗ vít màn thì **ẩn hẳn chữ `H1`…`H4`**: một lỗ khoan
Ø3,2 tự nó đã nói nó là lỗ vít, còn chỗ in thì nằm gọn dưới tấm màn.

### 2.4 Chân trống sau khi lắp hết

| GPIO | Trạng thái |
|---|---|
| GPIO45 | **đã giao cho `BCLK` của loa** (§2.3E) — chân GPIO thường cuối cùng của board |
| GPIO48 | LED RGB WS2812 onboard — dùng làm đèn báo trạng thái hệ thống |
| GPIO0 | nút BOOT onboard — dùng làm nút "factory reset" (giữ 5 s) |

**Hết chân GPIO thường.** Cần thêm đường điều khiển chậm thì lấy ở PCF8574 — còn P2 và P4–P7.
Board đế **không mang đầu nối nào cho mấy chân đó**: hàng P trên module vẫn hở, nên sợi dây mới
hàn thẳng từ module tới nơi cần, không đi vòng qua board.

**Ba chân sau không dùng được làm ngõ vào trên board này**, đo bằng cách bật điện trở kéo
lên rồi kéo xuống với **không cắm gì cả** và xem chân có đi theo không:

| Chân | Kéo lên | Kéo xuống | Kết luận |
|---|---|---|---|
| GPIO38 | 20/20 cao | **20/20 cao** | board ghim mức cao — vẫn làm ngõ ra được: LEDC kéo pad về 0 (§2.3F) |
| GPIO48 | **0/20 cao** | 0/20 | board ghim mức thấp |
| GPIO0 | 20/20 cao | 20/20 cao | điện trở kéo lên của nút BOOT ghim cao |

Nên câu "cần đường nhanh thì lấy GPIO48" **chỉ đúng cho ngõ ra**. Muốn thêm một ngõ vào thì
phải lấy lại từ một chân đang dùng, và **phải đo mức nền của chân đó trước khi cắm gì vào** —
chân bị ghim mức cho ra số liệu rất ổn định mà không chứa thông tin nào về thiết bị bên kia.

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
| **Tổng** | ~375 mA | **~1.34 A** |

**Rail 2 — 5 V / ≥ 1 A, cơ cấu chấp hành**

| Tải | Dòng điển hình | Dòng đỉnh |
|---|---|---|
| SG90 | 150 mA | **700 mA** (kẹt) |

Tách rail 1 khỏi rail 2 vì hai đỉnh trùng nhau: kiosk phát tiếng báo đúng lúc mở cửa. Chung một rail thì 1,34 A của đỉnh amp cộng 0,7 A của servo đủ kéo sụt áp và reset ESP32.

**Rail 2 không được là sạc dự phòng.** Sạc dự phòng tự ngắt ngõ ra khi tải dưới ngưỡng vài chục mA, mà servo đứng yên gần như không ăn dòng — đo 10/09 trên bàn: servo "chết" dù xung ở GPIO38 đúng từng micro giây, chỉ vì sạc đã tắt từ lúc nào. Kiosk thật dùng adapter 5 V thường; trên bàn thử thì phải giữ tải liên tục (servo quét, hoặc tải giả) cho sạc không ngủ.

Tụ: 1000 µF gần jack 5 V, 470 µF gần MAX98357A, 470 µF gần chân nguồn servo, 100 µF gần LCD.

Con 100 µF của màn phải là loại **thân Ø5 mm**, không phải Ø6,3. Khe nó nằm rộng 7,30 mm (§2.3A) nên thân 6,3 chỉ hở 0,25 mm mỗi bên, còn 5 mm hở 0,90. Bước chân hai loại đều 2,50 mm nên **lỗ khoan giống hệt nhau** — mua nhầm loại to vẫn cắm vừa, chỉ là sát.

#### Đường mass — quyết định lúc đi dây, không phải lúc vẽ sơ đồ

Sơ đồ nguyên lý chỉ khai được rằng mọi chân GND **cùng một nút**. Đồng thì có điện trở, nên
700 mA của servo chạy qua một đoạn đồng sẽ tạo ra một hiệu điện thế trên chính đoạn đó; thiết
bị nào lấy mass qua đoạn ấy sẽ thấy mass của mình nhấp nhô theo servo. Với MAX98357A thì cái
nhấp nhô đó được khuếch đại ra loa. Năm luật dưới đây có hiệu lực ở bước đi dây PCB.

| # | Luật | Hỏng thế nào nếu bỏ |
|---|---|---|
| 1 | Hai mass gặp nhau tại **đúng một điểm**, giữa `J10.GND` và `J11.GND`, sát hai domino | Gặp hai chỗ là thành vòng; dòng servo chia một phần chạy qua đồng của rail 1 |
| 2 | Mỗi tải nặng về **thẳng** domino của nó: servo → `J11.GND`, amp → `J10.GND` | Đi vòng qua nhau là dùng chung đoạn đồng, tức dùng chung cả nhiễu |
| 3 | Tụ 470 µF đặt **sát chân** amp và sát chân servo, không sát domino | Cú 600 mA của amp phải chạy dọc dây về nguồn thay vì lấy ngay tại chỗ (§2.3E) |
| 4 | Vòng nguồn–mass của amp phải **ngắn và khép kín**, tránh xa bus I2C | Khối ra class-D băm ~300 kHz **kể cả khi đầu vào bằng 0** (§2.3E), đủ để vào SDA/SCL |
| 5 | Hai dây loa đi thành **một cặp**, xoắn vào nhau, tránh bus I2C | Ngõ ra là cầu: cả hai dây đều dao động, không dây nào là mass (§2.3E) |

Luật 5 là luật **đi dây trong vỏ máy**, không phải luật PCB: loa đấu thẳng vào domino của
chính module MAX98357A, nên `OUT+` và `OUT−` không có net nào trên board đế và board đế
không mang đầu nối loa (§2.3E). `OUT−` **không bao giờ** nối xuống GND — kể cả khi bắt vít
loa vào khung máy.

**Hai domino đặt sát nhau hết mức đường bao cho phép**, nên luật 1 gần đúng nghĩa đen: `J10.GND` và `J11.GND` cách nhau **11,5 mm**. Bước bốn con ốc ra **5 / 6,5 / 5 mm** — không đều được vì đường bao hai domino chạm nhau ở 6,5, ép sát hơn là hai khung chồng lên nhau. Tụ `C1` đặt **lệch hẳn về `J10`**, hai chân nằm đúng trên hai chân của nó. Nó mang net `+5V_R1`, không dính gì tới `+5V_R2` của `J11` — kê nó cân giữa hai domino là vẽ ra một quan hệ điện không có thật, và kéo dài đoạn đồng tới đúng cái domino cần nó. Rail 2 không có tụ trữ ở domino: 470 µF của nó nằm sát chân servo theo luật 3.

### 2.6 Datasheet

Bảng này là **nguồn** của danh sách; bản PDF tải về nằm ở `hardware/datasheets/` và không vào git
(§4.1). `hardware/datasheets/INDEX.md` nối tên file với đúng dòng dưới đây kèm sha256, để tải lại
được đúng bản đã dùng — hãng có sửa datasheet mà không đổi URL.

| Linh kiện | Datasheet |
|---|---|
| **Board ESP32-S3-CAM (GOOUUU) — thứ tự chân hai hàng** | https://github.com/profharris/GOOUUU_ESP32-S3-CAM |
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
| DS3231 (RTC) | https://www.analog.com/media/en/technical-documentation/data-sheets/DS3231.pdf |
| SG90 (servo) | http://www.ee.ic.ac.uk/pcheung/teaching/DE1_EE/stores/sg90_datasheet.pdf |

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
| Width multiplier thay vì pruning | Scale kênh 0.75× / 0.5× rồi train lại từ đầu — ổn định hơn prune sau | cả 3 |

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

| | Tốc độ | CLE (§3.7) | Dải activation |
|---|---|---|---|
| `PReLU` | **chậm**: op riêng, không có kernel esp-nn | ✅ thuần nhất dương | không chặn |
| `ReLU` | 0 | ✅ thuần nhất dương | không chặn trên |
| `ReLU6` | 0 | ❌ trần cố định phá tính thuần nhất | chặn ở 6 |

Mặc định là `ReLU6` vì dải bị chặn giúp INT8; nhưng nhánh nào cần CLE thì `ReLU` là lựa chọn duy nhất không mất tốc độ. Khai bằng `model.params.activation` ở config nhánh, để so được bằng số thay vì tranh luận. **`PReLU` thì không được dùng ở bất kỳ nhánh nào** — nó tốn 42,3% thời gian của cả pipeline, đo ở `docs/measurements/latency.md`.

Từng nhánh chọn gì:

| Nhánh | Activation | Vì sao |
|---|---|---|
| detection | `ReLU6` viết cứng trong `blocks.py` | Không chạy CLE, dải chặn có lợi cho INT8 |
| anti-spoof | `ReLU` qua config | **Không chạy CLE** — đo 12/09 cho thấy nó làm EER sau INT8 tăng 53% (`measurements/antispoof` §32). `ReLU` vẫn giữ vì nó không tốn gì so với `ReLU6` và để ngỏ đường bật lại CLE nếu kiến trúc đổi. `HardSigmoid` của khối SE vẫn là `ReLU6(x+3)/6`, đó là công thức của cổng chứ không phải activation của conv |
| recognition | `ReLU` qua config | Chạy CLE — `ReLU6` chỉ giữ được 15/48 cặp conv, `ReLU` giữ đủ 48/48 |

### Lớp 2 — Huấn luyện

**Ba model train từ khởi tạo ngẫu nhiên trên nhãn thật, không có teacher.** Quyết định đó
và cái giá của nó nằm ở `docs/adr/0002-bo-knowledge-distillation.md`.

| Kỹ thuật | Chi tiết |
|---|---|
| **Task loss của từng nhánh** | Detect: cls + box + landmark trên prior dương. Anti-spoof: BCE hai lớp trên cặp crop. Recognition: ArcFace trên nhãn danh tính |
| **Quantization-friendly training** | Weight decay trên weight conv, clip activation, triệt outlier → phân bố hẹp, INT8 mất ít |
| **Augment mô phỏng OV5640** | Nhiễu Poisson-Gaussian, nén lại JPEG chất lượng 30–95, sai lệch cân bằng trắng, vignette, motion blur, ánh sáng ngược, phơi sáng. Mỗi nhóm một cổng `p=0,5`. Dải nén và phơi sáng từ `measurements/antispoof` §3, §9, §12; **dải nhiễu từ §24**: khung RGB565 thô ở gain 4× trần đo ra σ ≈ 3 trên thang 8 bit ở độ phân giải cảm biến, còn **σ 2,2–2,9 sau khi trung bình vùng về 81 px** như board làm, gần như không phụ thuộc mức sáng; nên `PHOTON_RANGE (8000, 16000)` và `READ_SIGMA_RANGE (1,5; 3,0)`, cho σ 1,7–3,2 ở mức 30 và 2,4–4,0 ở mức 230; dải cũ `(60, 600)` sinh σ 7–23, nặng hơn camera một bậc |
| **Anti-spoof: augment cắt crop** | Với `p = 0,15` cắt crop mặt về một tỉ lệ trong `[0.7, 1.0]` rồi dựng lại, **rút cùng một phân bố cho cả hai lớp**. Bắt buộc, xem mục dưới |

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
(median 2,9 px) lệch hẳn phân bố lúc chạy — kiosk nhìn **một** mặt ở 0,25–0,42 m, đo được
**38–57 px** ở đầu vào detect. Đây là lệch train/serve về kích thước, không phải chuyện
thiếu epoch.

**Công thức chốt, mọi ngưỡng lấy từ đo:**

| Tham số | Giá trị | Căn cứ |
|---|---|---|
| `crop_scale` | `[0.3, 1.0]` | Cắt vùng ngẫu nhiên rồi phóng về đầu vào. Median lên 13,6 px, p75 21 px, p90 34,8 px — chồng lên dải của kiosk |
| `min_face_px` | `8` | Đúng một ô lưới stride-8. Lọc **sau** khi crop, tại đúng độ phân giải đầu vào |
| `LEVEL_RANGES` | `(0,16) (16,48) (48,∞)` | Chia 61,1% / 33,6% / 5,3% trên phân bố sau augment |

Lọc sau crop chứ không lọc khỏi dataset: cùng một khuôn mặt được học khi rơi vào crop gần
và bỏ qua khi ảnh cắt xa. Lọc vĩnh viễn là dạy model rằng chỗ đó là nền.

Cái giá phải trả nằm ở §4.4.1: detect giờ **có** augment phóng to, nên nó phải đọc ảnh
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
320×240, so với 224 KB mà `arena_fast` được cấp ở SRAM nội (§3.8) — trong đó detect đã
dùng 189,6 KB đo thật. Detect chạy mỗi frame nên đẩy sang PSRAM là mất 22 ms mỗi frame.

**Miền phục vụ được định nghĩa bằng chính pipeline, không phải chọn cho dễ.** Camera đưa
khung **480×320** cho cả ba nhánh (§2.1). detect nhận toàn khung qua `letterbox_params()`
— hệ số `min(160/480, 120/320) = 0,3333`, đệm 6 px trên và dưới — còn spoof và recog
**cắt từ khung gốc ở tỉ lệ 1:1**. Hai kiểu lấy pixel khác nhau: detect thu nhỏ nên không
bao giờ thiếu, hai nhánh kia đòi pixel phải có sẵn.

Ràng buộc chặn là recognition: nó warp ra ô **113×113**, nên mặt phải rộng **≥ 113 px
trong khung camera**, tức **38 px ở đầu vào detect**. Dưới ngưỡng đó crop phải phóng to,
mà nội suy không thêm thông tin — nó thêm vệt mờ trơn, đúng thứ anti-spoof đọc thành kết
cấu. Bắt được cũng không dùng được ở khâu sau. Đó là biên, và nó là cổng.

**Cạnh mặt theo khoảng cách, đo trên board** (`docs/measurements/detection/measurements.md`):
`side ≈ 47,7 / d` px với `d` tính bằng mét. Suy ra ba mốc:

| Ngưỡng | Cần | Khoảng cách tối đa |
|---|---|---|
| **recog 113×113** | 113 px | **0,42 m** ← chặn cả pipeline |
| spoof 81×81 | 81 px | 0,59 m |
| detect bắt được ở conf 0,5 | ~56 px | 🔬 0,85 m |

**Dải làm việc chốt: 0,25–0,42 m.** Đầu xa do recognition chặn. Đầu gần không do model
nào chặn — mặt chỉ chiếm 87% cạnh ngắn khung hình ở 🔬 0,17 m, chỗ ngữ cảnh wide của
anti-spoof biến mất — nên 0,25 m là biên có dự phòng, đặt theo ToF chứ không theo model.

Hệ số `47,7` dựng từ hai khung ở 0,5 m và 0,95 m, mà **khoảng cách đo bằng mắt**, nên nó
mang sai số ±15%: dải recog thực nằm trong 0,36–0,48 m. Đo lại bằng thước là chốt cứng
được (E9-T24).

| Mốc | Ngưỡng | Đo bằng |
|---|---|---|
| Student FP32 | **AP ≥ 0,90** trên mặt ≥ 38 px | `eval.py`, cột `ge38px` |
| Student INT8 | sụt **< 1%** so với FP32 (§3.7) | `eval.py`, cột `ge38px` |
| Vận hành | recall **≥ 0,90** và **≤ 0,15** khung thừa mỗi ảnh, trên ảnh một mặt cỡ kiosk | `eval.py` |

Mặt dưới 38 px không tính đúng cũng không tính sai — dùng đúng luật ignore của kit, giống
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

#### Một view: crop mặt 1,0×, ô vuông trượt cho lọt khung

Anti-spoof đọc **một** crop: ô vuông cạnh bằng cạnh dài của hộp mặt, đặt quanh tâm mặt,
**trượt** vào trong khung khi tâm mặt sát mép, và **thu lại** khi hộp mặt lớn hơn cạnh ngắn
khung hình. Không kéo giãn, không đệm. Ba lý do đo được (`measurements/antispoof` §12.5):
cắt theo biên rồi kéo về vuông làm méo mặt (ở cự ly gần hộp mất 74% diện tích, tỉ lệ cạnh
1,78); đệm phản chiếu là bịa nội dung, và model đọc nội dung bịa quanh mặt thành dấu tấn
công; trượt thay cho ép đặt giữa đưa 8 khung mặt lớn lệch tâm từ 2/8 lên 4/8 qua ngưỡng
0,90 và khung tệ nhất từ 0,0004 lên 0,9860. Mặt chiếm trên 87% cạnh ngắn khung thì crop bị
thu — đó là biên của nhánh và là việc của cảm biến khoảng cách (§2.3D), không phải của model.

**Vì sao không còn view ngữ cảnh 2,7×.** Nó được thiết kế để bắt mép giấy và viền màn hình
nằm ngoài mặt, và trong CelebA-Spoof nó bắt được — vì trong bộ đó mặt thật là ảnh sự kiện
studio còn mặt giả là người cầm ảnh trong phòng thường, nên "phòng thường" tự nó đã là nhãn.
Đo trên 111 khung camera thật (`measurements/antispoof` §22): mặt thật đứng trước cửa gỗ
được chấm 0,20 khi thấy cả nền và **0,98 khi chỉ nhìn mặt**; ghép mặt đó lên nền tường
trắng thì lên 0,80, ghép mặt đang qua 0,97 lên nền cửa gỗ thì rớt 0,22. Quét tỉ lệ ngữ cảnh
1,0–2,7× không có mốc nào giữ được cả năm nhóm mặt thật; hoán nền lúc train cũng không kéo
được cơ chế đó đi. Nhánh ngữ cảnh vì thế là nguồn của đường tắt, không phải của tín hiệu,
và kiosk đứng trong đúng loại phòng mà nó gọi là tấn công.

Ba ràng buộc đi kèm:

- **Prep, eval và firmware dựng crop bằng một luật.** `fitted_box` bên `ml/` và `fitted()`
  trong `ai_engine/src/antispoof/preproc.cpp` là cùng một phép; lệch hai bên là model đọc ở
  kiosk một hình học khác thứ nó được train.
- **Tỉ lệ thật đạt được ghi vào từng record** (`wide_scale` trong shard, giờ đọc là tỉ lệ ô
  vuông còn dựng được so với hộp mặt), vì không có nó thì không kiểm được vùng cắt cụt mà
  mục dưới nói tới.
- **Đổi cách dựng thì shard hết giá trị**: sinh lại shard rồi train lại là bắt buộc.

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

**Chốt: shard dựng bằng hộp của nhánh detect, không dùng cột chú thích.** `xdomain_crop.py`
đã theo đúng luật này cho NUAA và Axon; tập train chính phải theo cùng. Ảnh nào detector
không thấy mặt thì bỏ, vì kiosk cũng sẽ không thấy — đo được 0,28% số ảnh, và tỉ lệ hai lớp
gần như không đổi (1,884 → 1,877), nên phép bỏ này không kéo theo lệch cân bằng nhãn.

**Hệ quả về thứ tự chạy:** `01_prepare_interim.sh` nhánh antispoof từ đây cần một checkpoint
detection đã train xong, nên nó không còn chạy được trên một bản clone trắng. Số thứ tự của
script vẫn là thứ tự chạy cho từng nhánh, nhưng riêng antispoof thì `20_train_det.sh` phải
xong trước. Đường dẫn checkpoint khai ở `configs/common/paths.yaml`
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

#### Tỉ lệ crop tương quan với nhãn, nên phải cắt ngẫu nhiên cho cả hai lớp

Trong CelebA-Spoof, ảnh tấn công bị giơ xa hơn mặt người, nên tỉ lệ ô vuông còn dựng được
**tương quan thẳng với nhãn**. Đếm trên 3.000 bản ghi train:

| Tỉ lệ ô vuông so với hộp mặt | Số mẫu | Mặt thật | Tấn công |
|---|---|---|---|
| **< 1,0** — crop ngắn hơn hộp mặt | 309 | **0** | **309** |
| ≥ 1,0 | 2.691 | 835 | 1.856 |

Dưới 1,0 là **dự đoán hoàn hảo**: không một mặt thật nào rơi vào đó. Model học đúng thứ
được dạy — *cắt cụt ⇒ tấn công* — và đường tắt ấy nổ mỗi lần người dùng lại gần, vì khi mặt
lớn hơn cạnh ngắn khung thì crop mặt cũng bị thu đúng như thế.

Phép augment này chỉ **thu nhỏ** crop có sẵn — không có cách nào bịa thêm phần khung hình
mà ảnh gốc không chứa. Nó vì thế **một chiều**, và một phép một chiều **bắt buộc phải có
cổng xác suất**: không có cổng thì mọi mẫu đều bị đẩy về một phía và tập train thôi không
còn chứa điều kiện lúc suy luận (đo ở `measurements/antispoof` §15).

**Chốt: mỗi mẫu có xác suất `p = 0,15` được cắt crop mặt về một tỉ lệ trong `[0.7, 1.0]`;
85% còn lại giữ nguyên.** Rút từ cùng một phân bố cho cả live lẫn spoof — đó là toàn bộ mục
đích, vì khi hai lớp cùng gặp vùng cắt cụt thì tỉ lệ hết mang thông tin về nhãn. Cận dưới
0,7 là vùng mặt thật ở cự ly gần thật sự rơi vào: 🔬 tám khung điện thoại đo được 0,70–0,98,
và đuôi dưới của chính tập train chạm 0,74.

Ba điều kiện để phép augment này có nghĩa:

- **Chỉ áp lúc train.** Val và test giữ nguyên tỉ lệ thật.
- **Ghi tỉ lệ đã rút vào batch**, không phải tỉ lệ gốc của record.
- Ràng buộc "không kéo giãn, không đệm" ở mục trên không được phép lách qua đường augment.

#### Nhánh tight phải học phơi sáng, nếu không nó đọc độ sáng thay cho kết cấu

Nhánh tight đọc crop 1,0× và phải tách mặt thật khỏi bản in bằng **kết cấu bề mặt**: lỗ
chân lông, độ bóng của da, vân moiré của màn hình. Kết cấu là đại lượng cục bộ, không phụ
thuộc mức sáng chung của khung.

Đo trên checkpoint chưa có augment quang học, làm tối và bẹt tương phản chính những
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
Rút một hệ số phơi sáng và một hệ số tương phản, áp cho crop mặt. Dải phải trùm được vùng đã đo ra lỗi, tức xuống tới 0,55 phơi
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

Đo trên 44 khung mặt thật đang được chấm 0,9995, phá dần từng kiểu rồi chấm lại:

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
đặt ngẫu nhiên trong hộp mặt. Cổng
xác suất là bắt buộc, cùng lý do đã ghi ở mục tỉ lệ crop: phép này một chiều, không cổng
thì mọi mẫu đều bị che và tập train rời khỏi điều kiện vận hành. Rút cùng phân bố cho cả
hai lớp là bắt buộc, nếu không thì "bị che" trở thành đường tắt dự đoán nhãn.

Nghiệm thu phép augment này bằng **APCER**, không chỉ BPCER. Nó nới điều kiện chấp nhận nên
rủi ro cố hữu là cho tấn công lọt; một bản vá kéo BPCER xuống mà đẩy APCER lên là bản vá
hỏng.

#### Tổng liều augment phải đo, không cộng dồn

Mỗi phép augment ở trên có một khoảng cách đo được mà nó nhắm vào, và số đo cho từng phép
đứng riêng. Nhưng chúng **chồng lên nhau** trong cùng một mẫu, và tổng liều đó chưa từng đo.
Với các cổng hiện tại (`measurements/antispoof` §23): xác suất một mẫu tới model **nguyên
vẹn** là **5,2%**, trung bình mỗi mẫu chịu **2,25 phép**, và **40,3%** số mẫu chịu từ ba phép
trở lên. "Nén lại q30 + nghiêng 15° + che 40% mặt" trên cùng một crop có còn giống ảnh kiosk
hay không, chưa bảng nào trả lời.

Bốn luật:

1. **Không thêm phép nào chưa có khoảng cách đo được** giữa tập train và khung kiosk mà nó
   nhắm vào. Phép nhắm vào một đường tắt *của dataset* (như hoán nền, đã bỏ) là dấu hiệu dữ
   liệu hoặc kiến trúc sai chỗ — sửa ở đó, không sửa bằng augment.
2. **Đổi bất kỳ cổng nào thì ghi lại bộ ba** (P nguyên vẹn, kỳ vọng số phép, P ≥ 3) vào
   `measurements/antispoof`, tính từ `config.resolved.yaml` của run.
3. **Đối chứng tổng liều trước khi thêm**: một arm chỉ giữ nhóm mô phỏng đường ảnh OV5640,
   một arm đủ phép, cùng seed cùng lịch (§4.2), so trên bộ khung camera. Arm ít phép không
   kém thì phần dư là gánh nặng, cắt.
4. Dữ liệu kiểm chứng phải rộng hơn 5 clip trước khi đọc bảng đối chứng đó: mỗi điều kiện
   chụp là **một** điểm dữ liệu, không phải 12.

### Lớp 3 — Nén cấu trúc

| Kỹ thuật | Ghi chú |
|---|---|
| **Structured pruning** (channel/filter, tiêu chí BN-γ hoặc L1-norm) | **Chỉ dùng loại này.** Unstructured/sparse pruning **vô nghĩa trên MCU** — không có kernel sparse |
| Iterative prune → fine-tune | Cắt ≤ 20% kênh mỗi vòng, fine-tune lại, lặp |
| Khi nào bỏ qua | Cả 3 model đã rất nhỏ; nếu đo thấy accuracy tụt > 1% khi cắt 10% kênh thì **bỏ hẳn bước này** |
| Layer fusion (Conv+BN+ReLU) | **Bắt buộc** trước khi quantize — TFLite Converter làm tự động, phải mở visualizer xác nhận |

### Lớp 4 — Lượng tử hoá

**Mức chi tiết (granularity)**

| Mức | Nội dung | Quyết định |
|---|---|---|
| Per-tensor weight | 1 scale cho cả layer | ❌ Không dùng — cả 3 model đầy depthwise conv, range giữa các kênh lệch rất lớn |
| **Per-channel (per-axis) weight** | Mỗi output channel 1 scale | ✅ **Bắt buộc**, TFLite hỗ trợ sẵn, không cần code thêm |
| Activation | Luôn per-tensor (phân bố đổi theo runtime, không cố định như weight) | Không có lựa chọn khác trên TFLite |
| INT16 activation × INT8 weight | TFLite có chế độ này | ❌ Không dùng — kernel INT16 của ESP-NN hạn chế, mất phần lớn tăng tốc |

**Kỹ thuật bổ trợ**

| Kỹ thuật | Vì sao cần |
|---|---|
| **Cross-Layer Equalization (CLE)** | Cân bằng range **weight** giữa các layer liền kề bằng phép scale tương đương, làm trước PTQ, không cần train lại. **Không mặc định bật: phải đo từng nhánh.** Nó chỉ cân weight, trong khi TFLite lượng tử hoá **activation theo per-tensor**; trên MiniFASNetV2-SE phép cân ấy đẩy dải activation của lớp `expand` lên 3,1× và kéo lớp `project` xuống 0,28×, làm nhánh residual bị làm tròn mất và EER tăng **53%** dù hàm FP32 không đổi (`measurements/antispoof` §32) |
| **Bias correction / bias absorption** | Bù sai số trung bình do quantize gây ra ở bias — miễn phí, luôn nên làm |
| **Chọn thuật toán calibration** | `min-max` (nhạy outlier) vs **`percentile 99.9%`** vs `MSE` vs `KL/entropy` — thử cả 4, chọn theo accuracy. 300–500 ảnh calib là đủ |

### Lớp 5 — Runtime ESP32-S3

| Kỹ thuật | Chi tiết |
|---|---|
| **Arena ở RAM nội, không PSRAM** | ESP-NN đo person_detection trên S3: **2300 ms → 54 ms** khi bật ESP-NN + arena ở RAM nội. Arena ở PSRAM chậm hơn nhiều lần. 🔬 Đo cả 2 |
| **Align 16 byte** | `heap_caps_aligned_alloc(16, size, MALLOC_CAP_INTERNAL)` — SIMD của LX7 yêu cầu |
| **Quy tắc arena** | Xem §3.8 — không phải `max(3)` cũng không phải tổng của 3. Công thức đúng: **Σ tail + max(head)** khi 3 interpreter dùng chung một `MicroAllocator` |
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

### 3.7 Thang lượng tử hoá

**Đúng hai mốc.** Không có mốc nào cần train lại.

| ID | Cấu hình | Vai trò |
|---|---|---|
| **Q0** | FP32 | Trần. Mọi con số dưới đây tính theo % so với Q0 |
| **Q1** | **PTQ**: per-channel weight + fold BN + **bias correction**; **CLE chỉ bật khi đo được là có lợi trên chính nhánh đó** | Mốc đem ship |

**Vì sao chỉ có Q1.** Cả bốn thành phần của nó **không cần train lại, không cần nhãn,
chạy trong vài phút**, và đều nhắm đúng điểm yếu của depthwise conv — thứ chiếm phần lớn cả
ba model. Những mốc đắt hơn (QAT, LSQ, mixed-precision theo layer, AdaRound, BRECQ) đều
đòi train lại hoặc giữ layer float; layer float rơi vào kernel C tham chiếu của TFLM thì
chậm gấp 10–40 lần, đánh mất đúng thứ mà lượng tử hoá mua được. Với ngân sách của đồ án
này, đổi lấy chúng là không đáng.

**Bốn thuật toán calibration** (min-max · percentile · MSE · entropy) là **sweep nội bộ khi
dựng Q1**, không phải mốc riêng. Đổi thuật toán calib chỉ là chạy lại converter, tính bằng
phút. Chọn cái thắng, ghi cả bốn số vào `docs/measurements/<nhánh>/calib_sweep.md`.

Mỗi dòng ghi đủ **5 cột** vào `docs/measurements/<nhánh>/quant_ladder.md`:

| Q | Accuracy (chỉ số của nhánh) | Δ so với Q0 | Kích thước `.tflite` | 🔬 head arena | 🔬 latency trên board |
|---|---|---|---|---|---|

**Quy tắc chọn**: Q1 phải thoả cả ba ngưỡng — accuracy sụt < 1% so với Q0, arena vừa chỗ đã
định ở §3.7, latency đạt ngân sách. Không thoả thì đường đi tiếp là **thu nhỏ hoặc đổi kiến
trúc rồi train lại**, không phải leo thang lượng tử hoá.

**So bằng accuracy sau INT8 trên tập `test_device`**, không phải accuracy FP32 trên val.
Cái chạy trên board mới là cái tính.

---

### 3.8 Arena dùng chung — công thức đúng

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

**Hệ quả cho dự án này**, sau khi đo thật (`docs/measurements/arena.md`): chốt **hai arena**, chia theo **tần suất chạy**, và **cả hai nằm ở PSRAM** cho tới khi model đủ nhỏ:

| Arena | Ở đâu | Dùng cho | Kích thước |
|---|---|---|---|
| `arena_fast` | **PSRAM**, align 16 B; `AI_ARENA_FAST_INTERNAL` đổi sang SRAM nội | **detect một mình**, `MicroAllocator` riêng | `tail_det + head_det` = **189.628 B** đo thật |
| `arena_big` | **PSRAM**, align 16 B | **anti-spoof + recognition**, dùng chung 1 `MicroAllocator` | `Σ tail + max(head)` = **422.764 B** đo thật 12/09 với spoof một backbone (spoof chiếm 210 KB, recog nâng lên 412 KB); bản hai backbone từng chiếm 823.148 B |

Vẫn là hai arena dù cùng ở PSRAM: `arena_big` gộp được vì spoof và recog chạy nối nhau **sau khi** detect xong, nên `head` của chúng chồng lên nhau an toàn. detect chạy mỗi frame, không chia `head` với ai.

Ba số đo dẫn tới cách chia này:

1. **SRAM chỉ mua được 4–10%.** Đưa toàn bộ activation của detect và spoof về SRAM nội chỉ cắt 1,9% của cả chuỗi. Băng thông PSRAM không phải nút thắt, phép tính trong kernel mới là.
2. **detect chạy mỗi frame, hai nhánh kia chạy mỗi lần có người.** Nên 10% của detect là 10% liên tục, còn 4% của spoof chỉ xuất hiện lúc có mặt. Chỗ SRAM đắt thì đưa cho thằng chạy nhiều nhất.
3. **spoof + recog gộp lại không vừa SRAM bằng cách nào cả.** Ép chúng vào `arena_fast` thì cả hai cùng trượt, và `arena_fast` phải phình tới mức không còn chỗ cho Wi-Fi lẫn stack task.

**Nhưng detect vẫn không được SRAM nội, vì hệ không trả nổi 224 KB.** Điểm 2 nói detect xứng đáng nhất, và nó vẫn đúng; thứ chặn lại là ngân sách §6.4:

| | `arena_fast` ở SRAM nội | `arena_fast` ở PSRAM |
|---|---|---|
| detect | 209,1 ms | 232,4 ms (**+23,3 ms**) |
| RAM nội trống sau khi nạp cả ba | 111 KB | **335 KB** |
| §6.4 còn phải chi | 267 KB | 267 KB |
| **Cân đối** | **−156 KB** | **+68 KB** |

Trong 267 KB đó có 42 KB bounce buffer LCD **bắt buộc `MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL`** — không có đường đẩy sang PSRAM. Nên đây không phải chọn nhanh hay chậm mà là chọn chạy được hay không: **23,3 ms mỗi frame đổi lấy 224 KB**, và 23,3 ms đó chỉ là 1,3% của một lượt chấm công 1.758 ms.

`AI_ARENA_FAST_INTERNAL` giữ đường quay lại: model nhỏ đi tới mức 267 KB kia vừa chỗ thì bật `y` là detect về SRAM nội, không sửa một dòng code nào.

Ba con số `tail` và ba con số `head` phải đo thật ở E8, không suy ra từ `arena_used_bytes()` tổng.

**Không tách `head` và `tail`.** `MicroAllocator::Create` có bản nhận hai buffer rời, cho phép để `head` (activation) ở SRAM nội và `tail` (metadata) ở PSRAM. Đo rồi: cách đó thu về **1,9%** cả chuỗi trong khi vẫn ăn 158–229 KB SRAM nội, tức vẫn không lọt ngân sách §6.4 mà lãi thì bằng một phần ba của việc đặt cả arena vào SRAM. Nó là phương án ở giữa và **thua cả hai đầu**, nên `Arena` chỉ có một đường cấp phát duy nhất. Số đo ở `docs/measurements/latency.md`.

**Kích thước arena đến từ ảnh model, Kconfig là trần trên.** Mỗi entry của ảnh
`models_0` mang `arena_hint` — **số byte của arena mà model đó chạy trong**, đo ở
E8-T7 (§6.2.2). `ai_engine` đọc nó khi khác 0 và cấp đúng chừng ấy;
`AI_ARENA_FAST_KB` và `AI_ARENA_BIG_KB` chỉ còn là **cận trên**, và `arena_hint`
vượt trần thì `Arena` từ chối kèm log chứ không cấp thiếu rồi chết ở
`AllocateTensors`. Lý do là đổi model không được kéo theo `menuconfig` + build
lại: hai bản khác kích thước phải nạp được vào cùng một firmware, nếu không thì
A/B model ở §6.2.2 chỉ đúng trên giấy. `arena_hint` bằng 0 nghĩa là chưa đo —
khi đó dùng trần Kconfig như cũ.

**Nhánh dùng chung arena thì mỗi entry mang tổng của nhóm, firmware lấy `max`.**
`arena_hint` là **một số cho mỗi model**, mà spoof và recog **chung một**
`MicroAllocator`: 476.188 B của chúng là `Σ tail + max(head)` của **cặp**, không
tồn tại hai số cộng lại ra nó. Nên quy ước là mỗi entry trong nhóm ghi **cùng
một** con — tổng của nhóm — và `ai_engine` cấp cho mỗi arena:

```
arena_bytes = max(arena_hint của các nhánh dùng arena đó)
```

`max` của những số bằng nhau là chính nó, nên nhóm đủ nhánh thì ra đúng số đã đo.
Ảnh thiếu một nhánh của nhóm (§6.2.2 cho phép `count < 3`) thì `max` trả con của
nhánh còn lại, tức **cấp thừa** — vô hại ở PSRAM, trong khi cấp thiếu là chết ở
`AllocateTensors`. Chọn `max` thay vì thêm field `arena_group` vì field mới bắt
tăng `format_ver` và sửa `storage_format.h` mà không mua thêm gì: nhóm nào chung
arena đã là hằng số của kiến trúc, khai ở chính `ai_engine` (§4.5.5c).

**`arena_hint` ghi số `used` đo được, firmware làm tròn lên KB.**
`arena_used_bytes()` là **chặn dưới, không phải kích thước đủ**: TFLM cấp `tail`
từ đỉnh xuống và `head` từ đáy lên, nên đệm căn lề phụ thuộc chính địa chỉ và
kích thước của arena. Đo trên board: cấp cho detect **đúng** 189.628 B — con số
nó tự báo đã dùng — thì `AllocateTensors` **từ chối**, cấp 189.632 B thì chạy,
trong khi `arena_big` ở đúng `used` 476.188 B lại chạy được. Phần thiếu vừa nhỏ
vừa không đoán trước được, nên chỗ bù nằm ở `ai_engine`: nó làm tròn lên bội số
1 KB **sau** khi lấy `max`, rồi mới so với trần Kconfig. Đặt phần bù ở firmware
chứ không ở `update_lock` vì người ghi lock chỉ có số `used`, còn chỉ firmware
biết bộ cấp phát của mình cần đệm.

**`ai_engine_init()` phải chạy trước mọi driver** — ràng buộc còn nguyên kể cả khi arena ở PSRAM, vì `AI_ARENA_FAST_INTERNAL` có thể bật lại. Ràng buộc thật không phải tổng RAM nội còn trống mà là **một dải liền mạch**: `heap_caps_aligned_alloc` không ghép được nhiều mảnh rời. Đo trên board (`docs/measurements/arena.md`): xin sau `drv_camera_init()` thì còn 192 KB trống nhưng mảnh to nhất chỉ 143 KB, arena **lùi xuống PSRAM**; xin ngay sau `sys_storage_init()` thì còn 293 KB với mảnh liền đủ rộng. Arena là chỗ duy nhất trong hệ xin một dải lớn như vậy, nên nó xin đầu tiên.

### Pipeline train

```
[1] Kiến trúc (activation theo bảng §3 lớp 1, kênh bội 8, kiểm tra op TFLM)
         │  random init — KHÔNG load .pth có sẵn
         ▼
[2] Train trên nhãn thật (task loss của nhánh, augment mô phỏng OV5640)
         │
         ▼
[3] Q0 — FP32  ──🔬 đo accuracy gốc, đây là trần để so
         │
         ▼
[4] Fold Conv+BN → Bias correction   (CLE chỉ khi nhánh đo được là có lợi, §3.7)
         │
         ▼
[5] Q1 — PTQ per-channel (calib 300 ảnh OV5640)
         │
    🔬 sụt accuracy < 1% so với Q0?
         │
         ├──Không──→ thu nhỏ hoặc đổi kiến trúc, quay về [1]
         ▼ Có
[6] INT8 → ONNX → onnx2tf → .tflite
                     ▼
[7] tflite_op_check.py — mọi op có trong MicroMutableOpResolver chưa?
                     ▼
[8] Gộp 3 .tflite thành 1 image cho partition `models_0` → flash
                     ▼
[9] 🔬 Trên board: arena_used_bytes, latency/op, RAM đỉnh, accuracy ảnh thật
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
├── ml/            Python — train, quantize, export
├── firmware/      ESP-IDF — C + C++
├── hardware/      KiCad + datasheet — mạch thật mà firmware chạy trên đó
│   ├── README.md                    # mở bằng KiCad bản nào, đọc gì trước
│   ├── gen/{gen_sch.py, gen_pcb.py, gen_fp.py}  # ✅ SINH RA kicad/ và lib/ — nguồn thật
│   ├── kicad/{kiosk.kicad_pro, .kicad_sch, .kicad_pcb, fp-lib-table, sym-lib-table}  # ✅ text
│   ├── lib/{symbols/, footprints/}  # ✅ sinh từ gen/; kéo về thì kèm UPSTREAM.md
│   ├── export/                      # ✅ PDF/PNG cho báo cáo, đóng dấu git sha của §2
│   ├── datasheets/                  # ❌ gitignore PDF — chỉ giữ INDEX.md
│   └── vendor/                      # ❌ gitignore — sơ đồ module hãng, giữ UPSTREAM.md
├── backend/       NestJS
├── frontend/      Next.js → Vercel
├── deploy/        Docker Compose, traefik — CHỈ hạ tầng chạy, KHÔNG chứa CI
├── tools/         Script ngang khối: gen_from_schema · check_comments · check_layers
│                   · check_schematic · check_pcb
└── docs/
    ├── KE_HOACH_face_attendance_esp32s3.md      # kiến trúc — nguồn sự thật
    ├── TASKS.md                                 # backlog
    ├── DU_LIEU.md                               # dữ liệu đã tải và xử lí — số đo trên đĩa
    ├── FREERTOS.md                              # sổ kiểm lỗi đồng thời, soát lại mỗi khi thêm task
    ├── adr/{0001-yunet-thay-ulfg.md, ...}       # quyết định kiến trúc, mỗi cái 1 file
    ├── measurements/{arena.md, latency.md, power.md, parity.md}  # số 🔬 đo được trên board
    └── thesis/                                  # bản báo cáo ĐATN
```

| File gốc | Vai trò |
|---|---|
| `.editorconfig` | Thống nhất indent/EOL cho 4 ngôn ngữ. Không có thì diff đầy nhiễu whitespace |
| `.gitattributes` | `* text=auto eol=lf`, `*.tflite binary`, `*/generated/* linguist-generated` |
| `.pre-commit-config.yaml` | Chạy `check_comments` · `ruff` · `clang-format` · `prettier` trước khi commit |
| `Makefile` | Điểm vào duy nhất: `make gen` · `make lint` · `make train-det` · `make flash` |

Ba khối `ml` / `firmware` / `backend+frontend` **không bao giờ copy định nghĩa của nhau**. Payload MQTT, danh sách model đang deploy, vector kiểm thử — tất cả nằm ở `contracts/`, mỗi bên sinh code từ đó. Đây là thứ giữ monorepo không rữa sau vài tháng.

**`hardware/` commit cái gì.** File KiCad là source dạng s-expression nên vào git và diff được.
PDF datasheet thì không: bản quyền thuộc nhà sản xuất, mà git không bao giờ quên một blob đã trót
commit. Thay vào đó `datasheets/INDEX.md` giữ **danh tính** của từng file — tên file ↔ URL ở §2.6 ↔
sha256 — đúng khuôn `contracts/models.lock.json` giữ sha256 còn `.tflite` thì gitignore. Sơ đồ module
kéo từ hãng đi theo luật `third_party/` (CLAUDE.md §2.10): không sửa, ghi nguồn vào `vendor/UPSTREAM.md`.

**Sơ đồ nguyên lý là ảnh chụp của §2, không phải nguồn thứ ba.** Chân GPIO vẫn khai ở đúng hai chỗ —
`app_config.h` và §2 (CLAUDE.md §1.3). Mỗi bản trong `export/` đóng dấu git sha của §2 lúc vẽ; lệch
nhau thì **§2 đúng**, sơ đồ vẽ lại, không bao giờ ngược lại.

**`hardware/gen/` là nguồn, `hardware/kicad/` là sản phẩm.** Ba script sinh ra toàn bộ file KiCad
từ bảng chân của §2: `gen_sch.py` → sơ đồ + thư viện symbol, `gen_pcb.py` → PCB, `gen_fp.py` →
footprint devkit tự vẽ. Bảng dữ liệu trong `gen_sch.py` chép thứ tự chân từng module theo §2.3, nên
sửa một chân là sửa ở §2 trước, rồi ở script, rồi sinh lại — không bao giờ sửa tay file `.kicad_*`.
File sinh ra **vẫn commit** (chúng là thứ mở được bằng KiCad và là thứ đem đi đặt in), nhưng sửa tay
chúng thì lần sinh sau mất sạch. Sinh lại phải **cho ra file y hệt**: uuid đặt theo tên linh kiện
chứ không lấy ngẫu nhiên, nếu không mỗi lần chạy là diff hai nghìn dòng và không ai soát được gì.

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
│   ├── detection/{decode/, nms/}         #   case_000.gold, case_001.gold, ... trong mỗi thư mục
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

`golden/` giải bài toán "hậu xử lý Python phải khớp 1:1 với C": mỗi nhánh có `postproc/emit_golden.py` xuất tensor đầu vào cộng kết quả mong đợi, `firmware/test_apps/parity` đọc **chính file đó** và so sánh trên board. Lệch ở decode anchor / NMS / affine warp lộ ra ngay, không phải mò lúc tích hợp.

**Định dạng là `.gold`, một khối nhị phân phẳng little-endian, không phải `.npz`.** `.npz` là file zip: đọc nó trên MCU cần một trình phân tích zip cộng npy dài hơn chính phép kiểm, mà không kiểm thêm được gì. Khuôn: magic `GOLD`, `version` u32, `count` u32, rồi mỗi tensor một bản ghi — tên 32 B nul-đệm, `dtype` u32 (0 `f32`, 1 `i8`, 2 `i32`, 3 `u8`, 4 `u16` — khung camera là RGB565), `ndim` u32, `dims` 4×u32, `nbytes` u32, dữ liệu đệm lên bội 4 B. `ml/export/emit_golden.py` giữ **đúng khuôn này** — hàm ghi và hàm đọc — còn ba `postproc/emit_golden.py` chỉ dựng ca kiểm của nhánh mình; một khuôn một chỗ, ba nhánh vẫn độc lập theo §4.5.

`test_apps/parity` nướng cả cây `contracts/golden/` vào partition `storage` bằng `littlefs_create_partition_image(... FLASH_IN_PROJECT)`, nên board mở chúng qua `/lfs` như file thường và không cần đường truyền riêng nào.

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
| Detection | 11.618 ảnh | **394 MB** | file lẻ **đã thu nhỏ cạnh dài 320** | `fast_drive` |
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

Mọi run của cùng một nhánh phải dùng **cùng một** tập đã thu nhỏ, nếu không thì hai run không so được với nhau.

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
model đáng lẽ được thấy. Nhánh detect có scale augment, nên **giữ ảnh
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
│   ├── detection/widerface_shards/{train, val}/  # ★ shard cho detect, resize san 160x120
│   ├── antispoof/celeba_spoof_crops/{train, valid, test}/shard_*.tar
│   │                                             #   1 record = tight.jpg + wide.jpg + json
│   │                                             #   ★ hop mat cat bang nhanh detect,
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
│   ├── antispoof/v1_upstream/{train_ids.txt, val_ids.txt, test_ids.txt, SPLIT.md}   # phần CelebA-Spoof, không đổi
│   ├── antispoof/v2_upstream_lcc_synth/{lcc_{train,val,test}_ids.txt, synth_{train,test}_ids.txt, SPLIT.md}
│   │                                             #   hai bộ trộn thêm từ 11/09 (§1.2); tên ảnh chọn đúng luật của xdomain_crop.py
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
consumed_by: [detection]
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
│   ├── detection/{yunet.yaml, quant.yaml}
│   ├── antispoof/  (2 file cùng tên)
│   └── recognition/(2 file cùng tên)
│
├── src/facepipe/
│   ├── core/                              # ── HẠ TẦNG TRAIN: 3 nhánh cùng import ──
│   │   │   KHÔNG chứa tên nhánh nào. Không import ngược từ tasks/.
│   │   ├── registry.py                    # @register("yunet") → gọi model bằng tên trong YAML
│   │   ├── config.py                      # pydantic schema + merge YAML + override CLI
│   │   │                                  #   ★ load_run_config() doc lai config da dong
│   │   │                                  #     bang cua mot run cu: run la bat bien nen
│   │   │                                  #     no co the chua muc ma schema da bo
│   │   ├── trainer.py                     # vòng train chung: AMP, EMA, grad-clip, ckpt, resume
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
│   │   │   Cùng khuôn: README · model/ · losses/ · postproc/
│   │   │              · data.py · quant.py · train.py · eval.py
│   │   │   ★ = file phải khớp 1:1 với bản C ở firmware, kiểm bằng contracts/golden/
│   │   │
│   │   ├── detection/
│   │   │   ├── README.md                  # kiến trúc gì, metric gì, lệnh chạy
│   │   │   ├── model/
│   │   │   │   ├── yunet.py               # backbone + neck
│   │   │   │   ├── head.py                # 3 đầu ra: cls / bbox / 5 landmark
│   │   │   │   ├── anchors.py             # ★ sinh prior box, khớp anchors trong decode.cpp
│   │   │   │   └── blocks.py              # conv-bn-relu6, depthwise sep, kênh bội 8
│   │   │   ├── losses/
│   │   │   │   └── task_loss.py           # focal + IoU + landmark L1 trên nhãn thật
│   │   │   ├── postproc/
│   │   │   │   ├── decode.py              # ★ ai_engine/src/detection/decode.cpp
│   │   │   │   ├── nms.py                 # ★ ai_engine/src/detection/nms.cpp
│   │   │   │   └── emit_golden.py         # → contracts/golden/detection/{decode,nms}/
│   │   │   ├── data.py                    # dataloader + augment riêng nhánh
│   │   │   ├── quant.py                   # tập calib riêng nhánh
│   │   │   ├── train.py                   # điểm vào duy nhất để train nhánh này
│   │   │   └── eval.py                    # WIDER AP + NMSE landmark trên ảnh OV5640
│   │   │
│   │   ├── antispoof/
│   │   │   ├── README.md
│   │   │   ├── model/
│   │   │   │   ├── minifasnet_v2_se.py
│   │   │   │   └── blocks.py              # ConvBnAct(relu); SE gate HardSigmoid ReLU6(x+3)/6
│   │   │   ├── losses/
│   │   │   │   └── task_loss.py           # BCE live/spoof
│   │   │   ├── postproc/
│   │   │   │   ├── preproc.py             # ★ ai_engine/src/antispoof/preproc.cpp
│   │   │   │   └── emit_golden.py         # → contracts/golden/antispoof/preproc/
│   │   │   ├── data.py                    # patch crop 1.0×/2.7×, augment in ảnh + màn hình
│   │   │   ├── quant.py
│   │   │   ├── train.py
│   │   │   └── eval.py                    # ACER, HTER cross-dataset, ROC tập tự thu
│   │   │
│   │   └── recognition/
│   │       ├── README.md
│   │       ├── model/
│   │       │   ├── mobilefacenet.py
│   │       │   └── blocks.py              # ConvBnAct(relu), giữ CLE 48/48 cặp conv
│   │       ├── losses/
│   │       │   └── arcface.py             # margin loss trên nhãn thật
│   │       ├── postproc/
│   │       │   ├── align.py               # ★ ai_engine/src/recognition/align.cpp
│   │       │   ├── l2norm.py              # ★ ai_engine/src/recognition/l2norm.cpp
│   │       │   ├── cosine.py              # ★ svc_facedb/src/embedding_index.cpp
│   │       │   └── emit_golden.py         # → contracts/golden/recognition/{align,l2norm,cosine}/
│   │       ├── data.py                    # webdataset Glint360K + sampler theo ID
│   │       ├── quant.py
│   │       ├── train.py
│   │       └── eval.py                    # LFW/CFP-FP/AgeDB + TAR@FAR tập nhân viên
│   │
│   ├── compress/
│   │   └── quant/{fold_bn.py, cle.py, bias_correction.py, ptq_tflite.py}
│   │
│   └── export/
│       ├── to_onnx.py  ├── onnx_to_tf.py  ├── tf_to_tflite_int8.py
│       ├── tflite_op_check.py             # đối chiếu op ↔ danh sách ESP-NN/TFLM
│       ├── emit_golden.py                 # ★ khuôn .gold: hàm ghi và hàm đọc, ba nhánh dùng chung
│       ├── pack_models_partition.py       # gộp 3 .tflite + header → models.bin
│       └── update_lock.py                 # ★ ghi contracts/models.lock.json
│
├── bench/{host_bench.py, device_client.py, accuracy_on_device.py,
│          live_demo.py,                   # ★ detect → align → spoof → recog, webcam host
│          cam_bridge.py}                  # ★ chạy trên Windows: virtual cam → MJPEG
│       ★ Điểm vào chạy thẳng, KHÔNG phải thư viện. Nằm ngoài src/facepipe/ vì gói cài
│         đặt được không được kéo theo cv2 và http.server của một cái demo.
│         cv2 khai ở extra `bench` của pyproject: `uv sync --extra bench`.
│
├── scripts/                               # đánh số = thứ tự chạy
│   ├── _resume_loop.sh                    # ★ khong danh so vi khong chay truc tiep:
│   │                                      #   ham dung chung, moi script train source no.
│   │                                      #   Train chet thi tu chay lai tu last.pth cua
│   │                                      #   chinh no, co tran so lan de khong lap vo han
│   ├── 00_fetch_raw.sh          ├── 01_prepare_interim.sh   ├── 02_make_splits.sh
│   │                            #   ★ 01 nhanh antispoof can checkpoint detection
│   │                            #     da train: cat mat bang detect, khong bang Bbox (§3)
│   ├── 20_train_det.sh ├── 21_train_spoof.sh ├── 22_train_recog.sh
│   ├── 30_quantize.sh ├── 40_export.sh     ├── 41_emit_golden.sh
│   ├── 50_pack_and_flash.sh
│   └── trainctl.sh              # ★ start | pause | resume | check cho mot nhanh.
│                                #   Khong phai mot chang cua pipeline nen khong
│                                #   co so, giong _resume_loop.sh
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
│   │   ├── onnx/{model_fp32.onnx, model_qdq.onnx}
│   │   ├── tf/<tên>/                      # SavedModel, chặng giữa onnx2tf → TFLiteConverter
│   │   │                                  # ↑ sinh lại được, giữ để đổi cấu hình quantize
│   │   │                                  #   mà không phải chạy lại onnx2tf
│   │   ├── tflite/{yunet_fp32.tflite, yunet_int8.tflite}
│   │   └── reports/op_check.txt
│   │                                      # ↑ sinh lại được. Số đo giữ lại: docs/measurements/
│   │      Tên trên là của **một** model đã chốt. Khi đang so nhiều checkpoint thì gắn
│   │      thêm hậu tố giờ của run: `model_fp32_0944.onnx`, `minifasnet_int8_0944.tflite`.
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
    ├── test_core_{config,registry,run_dir,trainer,isolation}.py
    ├── test_prepare.py                      # bộ chuyển raw → interim
    └── {test_splits.py, test_transforms.py, test_postproc_parity.py}
```

##### Ranh giới `core/` ↔ `tasks/`

**`core/` là hạ tầng train, không phải chỗ chứa model.** Nó không biết khuôn mặt là gì, không biết nhánh nào tồn tại. Cả 3 nhánh `import` cùng lúc **cùng những file đó** — không nhánh nào sở hữu, không nhánh nào thay thế nhánh nào. Xong detection thì code detection vẫn nằm nguyên đó, chạy lại lúc nào cũng được.

| Ở `core/` — viết 1 lần, 3 nhánh cùng dùng | Ở `tasks/<nhánh>/` — mỗi nhánh một bản riêng |
|---|---|
| Vòng lặp train: AMP, EMA, grad-clip, resume | Kiến trúc từng nhánh |
| Lưu/khôi phục checkpoint, tạo thư mục run | Dataloader và augment riêng nhánh |
| Nạp + merge YAML, override từ CLI | Hàm loss của nhánh (focal+IoU · BCE · ArcFace) |
| Cố định seed, ghi `env.txt`, `split.lock` | Augment và dataloader riêng nhánh |
| Ghi tensorboard + wandb | Chỉ số đánh giá (WIDER AP · HTER · TAR@FAR) |
| | Hậu xử lý ★ phải khớp firmware |

**Luật**: `core/` không được `import` bất cứ thứ gì từ `tasks/`, và không được chứa tên nhánh. Thấy `if task == "detection"` trong `core/` là code đặt sai chỗ — đẩy xuống `tasks/detection/`. Đây đúng là luật của `ai_engine/src/core/` ở firmware (§4.5.6): cùng một nguyên tắc, hai ngôn ngữ.

Cần thứ `core/` chưa có: chỉ 1 nhánh cần → để trong `tasks/<nhánh>/`. Từ 2 nhánh trở lên cần và không dính đặc thù nhánh nào → nâng lên `core/`, giữ nguyên giao diện, **không** thêm nhánh `if`.

`compress/` và `export/` cũng là hạ tầng: chúng giữ **thuật toán** (fold BN, CLE, bias correction, convert). Mỗi nhánh chỉ cấp tham số riêng qua `tasks/<nhánh>/quant.py` — tập calib và danh sách op cần kiểm.

##### Ba lệnh chạy song song, không thay thế nhau

```bash
python -m facepipe.tasks.detection.train    --cfg configs/detection/yunet.yaml
python -m facepipe.tasks.antispoof.train    --cfg configs/antispoof/minifasnet.yaml
python -m facepipe.tasks.recognition.train  --cfg configs/recognition/mobilefacenet.yaml
```

Thứ tự ở §8 là thứ tự **bắt tay vào việc**, không phải thứ tự thay thế. Xong giai đoạn 5 thì cả ba nhánh cùng nằm trong repo và `50_pack_and_flash.sh` gộp cả ba `.tflite` vào một `models.bin`.

**Cách "lục lại" sau 6 tháng**: mở `contracts/models.lock.json` → lấy `run_id` → mở đúng thư mục run → có `config.resolved.yaml` (biết hyperparameter), `split.lock` (biết train trên tập nào), `env.txt` (biết môi trường), `ckpt/` (có weight). Không phải đoán, không phải hỏi lại ai.

Đọc một run cũ phải chịu được **mục mà schema đã bỏ**: thư mục run là bất biến, còn
`Config` thì đổi theo kiến trúc. `load_config` giữ `extra="forbid"` để bắt lỗi gõ sai trong
config người viết; `load_run_config` bỏ những mục cấp cao mà `Config` không còn khai, và chỉ
dùng cho `config.resolved.yaml`. Không có nó thì mọi run train trước một lần đổi schema đều
không mở lại được — 46 run mất khả năng export lúc ADR-0002 bỏ `teacher` và `distill`.

##### Mọi lần train phải dừng và chạy tiếp được

Train một nhánh chạy hàng chục giờ trên một máy laptop dùng chung. Một lần mất
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
├── vl53l1x_uld/                # ST STSW-IMG009 — bản dual license, lấy nhánh BSD-3-Clause
│   ├── CMakeLists.txt          # ta viết, bọc thành component IDF tên vl53l1x_uld
│   ├── UPSTREAM.md             # ✅ url, phiên bản, ngày lấy, sha256, đã sửa gì
│   ├── patches/                # ★ buộc phải vá thì để patch, KHÔNG sửa thẳng file
│   ├── core/                   # VL53L1X_api.{c,h} + VL53L1X_calibration.{c,h}, nguyên bản
│   └── platform/               # CHỈ vl53l1_platform.h và vl53l1_types.h, nguyên bản
└── README.md
```

**Tầng platform của ULD là code của mình, nên nó không nằm ở `third_party/`.** ULD khai 9
hàm `extern` cho I2C và delay (`VL53L1_WrByte`, `RdByte`, `WrWord`, `RdWord`, `WrDWord`,
`RdDWord`, `WriteMulti`, `ReadMulti`, `WaitMs`) và ST ship kèm một `vl53l1_platform.c` mẫu.
File mẫu đó **không được vendor**: hiện thực thật phải đi qua `bsp_i2c_bus()` và
`bsp_i2c_lock()` (§5.3) vì bus I2C có bốn thiết bị, nên nó là code mình viết và nằm ở
`components/drv_tof/src/`. Vendor cả file của ST thì trùng ký hiệu lúc link, mà sửa nó tại
chỗ thì vi phạm §2.10. Bỏ đúng một file khỏi bản vendor và ghi vào `UPSTREAM.md` là cách
duy nhất giữ được cả hai luật, nên `patches/` để rỗng.

Cũng vì lý do đó mà **không dùng component trên registry**: cả ba bản có sẵn
(`saleca/vl53l1x_uld_esp_wrapper`, `grrtzm/vl53l1x_library`, `espp/vl53l`) đều tự khởi tạo
bus I2C từ chân GPIO, tức thêm một master thứ hai lên GPIO1/GPIO2 bên cạnh GT911, PCF8574
và chính VL53L1X. Bus dùng chung là ràng buộc của §2.3B, không phải sở thích.

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
│   ├── app_main.c            [C]     # điểm vào: gọi app_boot rồi app_tasks_start
│   ├── app_boot.{c,h}        [C]     # ★ chuỗi khởi tạo, không chứa logic. Tách khỏi
│   │                                 #   app_main.c để `test_apps/soak` dựng đúng
│   │                                 #   chuỗi mà kiosk dựng, không phải bản chép lại
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
│   ├── drv_servo/         [C]    L2  # chỉ đẩy xung LEDC 50 Hz
│   ├── sys_storage/       [C]    L2  # NVS + LittleFS + mmap model; sở hữu storage_format.h (§6.2.7)
│   ├── sys_time/          [C]    L2  # DS3231 là nguồn chính, SNTP hiệu chỉnh; báo nguồn giờ ra, không tự lưu (§6.2.5)
│   ├── ai_engine/         [C++]  L3  # TFLM — src/ tách 3 thư mục theo model (§4.5.6)
│   ├── svc_facedb/        [C++]  L3  # bảng embedding + cosine search + CRUD
│   ├── net_wifi/          [C]    L3
│   ├── net_mqtt/          [C]    L3
│   ├── net_ota/           [C]    L3
│   ├── svc_door/          [C++]  L4  # IDoor + ServoDoor bọc drv_servo, FakeDoor cho test
│   ├── svc_vision/        [C++]  L4  # detect mỗi khung, chuỗi spoof → recog khi mặt ổn định (§4.5.5d)
│   ├── svc_attendance/    [C++]  L5  # state machine, chống trùng, ghi log
│   ├── svc_sync/          [C++]  L5  # hàng đợi offline → MQTT
│   └── ui_kiosk/          [C++]  L6  # LVGL screens + bộ bám hộp preview (§4.5.5h)
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
└── scripts/                           # rỗng, xem dưới; script ngang khối ở /tools
```

**`scripts/` rỗng là có chủ ý.** Nạp `models_0` đã có `ml/scripts/50_pack_and_flash.sh` (§6.3):
bước gộp ảnh cần `contracts/models.lock.json`, sha256 từng nhánh và venv của `ml/`, nên một bản
bên firmware chỉ có thể gọi vòng sang `ml/` hoặc là bản sao thứ hai của cùng logic.

Một `check_pinmap.py` đối chiếu `app_config.h` với §2 thì **hoãn**, không bỏ. §2 ghi chân bằng ba
kiểu bảng khác nhau cộng văn xuôi, nên bộ phân tích sẽ báo oan mỗi lần sửa câu chữ — mà check báo
oan thì sau vài lần sẽ bị bỏ qua, tức tệ hơn không có. Khi chân bắt đầu đổi lại thì thứ đáng viết
là phép kiểm rẻ hơn hẳn: commit nào sửa dòng `_GPIO` của `app_config.h` phải sửa cả §2 trong cùng
commit (CLAUDE.md §1.3), đọc `git diff --cached --name-only` là đủ, không cần đọc hiểu bảng nào.

#### 4.5.3 Bố cục bên trong một component

```
components/svc_facedb/
├── CMakeLists.txt          # REQUIRES / PRIV_REQUIRES — xem bảng 4.5.4
├── include/
│   └── svc_facedb.h        # ★ CÔNG KHAI. extern "C", chỉ POD + handle mờ
├── priv_include/
│   └── facedb_internal.hpp # nội bộ, component khác KHÔNG thấy
├── src/{facedb.cpp, embedding_index.cpp, persist.cpp, dot_s8_esp32s3.S}
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
| L2 | `sys_storage` | C | `common`, `nvs_flash`, `spi_flash`, `esp_partition`, `littlefs` |
| L2 | `sys_time` | C | `common`, `lwip`, `bsp_board` |
| L3 | `ai_engine` | C++ | `common`, `sys_storage`, `esp-tflite-micro` |
| L3 | `svc_facedb` | C++ | `common`, `sys_storage` |
| L3 | `net_wifi` / `net_mqtt` / `net_ota` | C | `common`, `sys_storage`, `esp_wifi` / `mqtt` / `esp_https_ota` |
| L4 | `svc_door` | C++ | `common`, `bsp_board`, `drv_servo`, `esp_timer` |
| L4 | `svc_vision` | C++ | `common`, `ai_engine`, `svc_facedb`, `drv_camera` |
| L5 | `svc_attendance` | C++ | `common`, `svc_vision`, `svc_facedb`, `sys_storage`, `sys_time`, `svc_door`, `drv_audio` |
| L5 | `svc_sync` | C++ | `common`, `sys_storage`, `net_mqtt` |
| L6 | `ui_kiosk` | C++ | `common`, `drv_lcd`, `drv_touch`, `lvgl`, `esp_lvgl_port` |
| L7 | `main` | C | tất cả |

**Ba quy tắc bất di bất dịch:**
1. Không component nào được `REQUIRES` lên tầng trên hoặc ngang tầng — **không có ngoại lệ nào**. Driver cùng tầng không gọi nhau; thứ nhiều driver cùng cần thì nằm ở tầng thấp hơn tất cả chúng, như `drv_ioexp` ở L2 dưới bốn driver L3 dùng nó. Hai component ở cùng tầng mà cần nhau nghĩa là một trong hai đặt sai tầng: hạ nó xuống, đừng mở ngoại lệ. Số tầng là **thứ tự toàn phần**, nên đọc số là biết ngay ai được phụ thuộc ai mà không phải tra bảng.
2. `ui_kiosk` **không gọi** `svc_attendance`, và `svc_attendance` **không biết UI tồn tại**. Hai bên gặp nhau qua queue/event khai trong `common/include/app_events.h`, do `main/app_wiring.c` nối. Đây là chỗ dễ đẻ ra vòng phụ thuộc nhất.
3. `tools/check_layers.py` đọc `REQUIRES` trong mọi `CMakeLists.txt`, dựng đồ thị, **fail CI nếu có cạnh đi ngược**. Quy ước không được kiểm tra tự động thì 3 tháng sau sẽ bị vi phạm.

#### 4.5.5 Thiết kế OOP bên trong các component C++

Header công khai là **mặt tiền C** (§4.5.3) để `app_main.c` và các component C gọi được. Toàn bộ OOP nằm sau mặt tiền đó, trong `src/*.cpp` và `priv_include/*.hpp`.


**Hai cái bẫy `trainctl.sh` sinh ra để đóng.** Cả hai đã xảy ra thật:

`pgrep -f` và `pkill -f` so mẫu với **toàn bộ dòng lệnh**, kể cả dòng lệnh của chính shell
đang gõ nó. Gõ `pkill -f facepipe.tasks.recognition.train` vào terminal thì mẫu khớp chính
cái shell đó và nó tự giết mình — train vẫn chạy, terminal thì chết. `trainctl.sh` liệt kê
cây tổ tiên của chính nó rồi loại ra trước khi gửi tín hiệu.

Resume phải nêu lại **đủ mọi tham số `model.params`**, không chỉ đường dẫn checkpoint. Model
được dựng từ config rồi mới nạp `state_dict`, nên thiếu một tham số là dựng sai kiến trúc và
`load_state_dict` báo `size mismatch`. `trainctl.sh resume` đọc lại chúng từ
`config.resolved.yaml` của chính run đó, nên không phụ thuộc vào việc người gọi có nhớ hay không.
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
| `Queue<T,N>` | `xQueueCreate` + gửi/nhận có kiểu | Gửi nhầm kiểu vào queue (C thuần không bắt được) |

Ba lớp này bọc tài nguyên mà **nhiều component cùng chạm tới**, nên chúng ở `common`.
Tài nguyên chỉ một component sở hữu thì guard nằm luôn trong component đó: `Arena` bọc
`heap_caps_aligned_alloc(16,…)` và `MicroProfiler` bọc phép đo tick đều là của riêng
`ai_engine` (§4.5.6), còn mmap partition là của riêng `sys_storage` (§4.1 của `CLAUDE.md`
cấm component khác gọi `esp_partition_*`). Kéo chúng lên `common` chỉ tạo thêm một chỗ
phải đồng bộ, không cứu được lỗi nào.

```cpp
// common/include/frame_guard.hpp
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
        │  init/input/output   │
        │  invoke/name         │
        └──────────┬───────────┘
                   │
        ┌──────────▼───────────┐
        │   TfliteModelBase    │  interpreter_, profiler_, tensor I/O
        │   (không tạo trực tiếp)│
        └───┬───────┬───────┬──┘
            │       │       │
     DetectModel SpoofModel RecogModel
     op:6        op:7       op:4         ← MicroMutableOpResolver<N> riêng từng lớp
     +decode()   +score()   +l2norm()
     +nms()
```

Ba lớp con khác nhau ở **danh sách op đăng ký** và **hậu xử lý**, không phải khác cho có. `TfliteModelBase` giữ phần lặp lại: dựng interpreter trên arena được đưa và `AllocateTensors`.

```cpp
// priv_include/tflite_model.hpp
class ITfliteModel {
public:
    virtual ~ITfliteModel() = default;
    virtual esp_err_t     init(const tflite::Model* graph, Arena& arena) noexcept = 0;
    virtual TfLiteTensor* input(int index)  noexcept = 0;
    virtual TfLiteTensor* output(int index) noexcept = 0;
    virtual esp_err_t     invoke() noexcept = 0;
    virtual const char*   name()       const noexcept = 0;
};
```

**Interface không có `arena_used()`.** Khi hai model dùng chung một `MicroAllocator`, `interpreter->arena_used_bytes()` trả về mức dùng của **cả allocator**, giống hệt nhau ở cả hai — một con số trông như của riêng model nhưng không phải. Mức dùng thật của từng arena đọc ở `Arena::used()`, và `ai_engine_arena_stats()` đưa nó ra ngoài.

**`init` nhận `Arena&` chứ không nhận `(size, caps)`.** Model tự cấp buffer riêng thì mỗi model một `MicroAllocator`, mà §3.8 đòi ngược lại: **anti-spoof và recognition** phải dùng **chung** một allocator mới chồng được tail và dùng chung head. `Arena` sở hữu buffer, model chỉ mượn. detect có `arena_fast` một mình, nhưng vẫn nhận `Arena&` — cùng một giao diện cho cả ba nhánh, và cách chia lại arena không phải sửa chữ ký.

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

##### d) `svc_vision` — tuần tự, tiêm phụ thuộc, test được không cần model

`svc_vision` không nhìn thấy lớp C++ của `ai_engine` (chúng nằm trong `priv_include`, §4.5.3), nên nó tự khai bốn interface nhỏ của mình và bọc API C của `ai_engine` và `svc_facedb` bằng bốn adapter:

```cpp
class IDetector { virtual size_t detect(const ai_engine_frame_t&, float min_score, ai_engine_face_t* out, size_t cap) = 0; };
class ILiveness { virtual bool available() const = 0;
                  virtual esp_err_t score(const ai_engine_frame_t&, const float box[4], float* live) = 0; };
class IEmbedder { virtual esp_err_t embed(const ai_engine_frame_t&, const float landmarks[10], int8_t* out, size_t cap, float* scale) = 0; };
class IMatcher  { virtual esp_err_t best(const int8_t* emb, float scale, uint32_t* id, float* score) = 0; };

class VisionPipeline {
public:
    VisionPipeline(IDetector&, ILiveness&, IEmbedder&, IMatcher&) noexcept;
    void configure(const svc_vision_thresholds_t&) noexcept;
    svc_vision_result_t step(const ai_engine_frame_t& frame) noexcept;   // MỘT khung: detect, và cả chuỗi khi mặt đã ổn định
    void reset() noexcept;
};
```

**Tuần tự, thoát sớm, đúng §3 lớp 5.** Mỗi `step()` chạy detect trên khung mới nhất. Khi mặt chính đã ổn định qua 2 lần detect (IoU ≥ 0,5) thì **cùng bước đó** chạy tiếp spoof → recog → tra `svc_facedb` trên chính khung đang giữ, và trả kết quả ngay: mặt xuất hiện → kết quả sau ≈ 0,6 + 0,93 ≈ **1,5 s**, mức thấp nhất mà ba model cho phép. Trong 0,93 s đó detect không chạy — đó là giá của một core cho AI, và giá được trả ở **đường preview** chứ không ở đường model: hộp mặt trên màn hình do một bộ bám rẻ trên core 0 kéo theo khuôn mặt ở nhịp khung hình giữa hai lần detect (§4.5.5h, E10-T1), nên mắt không thấy hộp khựng mà kết quả không chậm thêm. Hai cách đã cân và bỏ: xen kẽ detect giữa spoof và recog làm kết quả chậm thêm 0,6 s; đưa spoof/recog sang core 0 ăn CPU rỗi của Wi-Fi/LCD và thuế bus PSRAM cho cả hai bên.

**Bám một mặt chính, có quán tính.** Mặt chính là **mặt đang bám** nếu trong lần detect này còn hộp trùng nó (IoU ≥ 0,5); chỉ khi mất dấu mới lấy hộp lớn nhất làm track mới. Nhờ vậy người thứ hai to hơn bước vào không cướp lượt của người đang được xác thực, và hai người ngang cỡ đứng cạnh nhau không làm track nhảy qua lại. Người thứ hai được chấm khi người thứ nhất rời khung (hoặc lùi xa tới mức mất dấu): track mới ổn định sau 2 detect rồi xác thực, tức ~1,5 s sau khi anh ta thành mặt chính. Cùng một track thì sau `MATCH` không xác thực lại; sau `SPOOF`/`UNKNOWN` thử lại sau 6 lần detect (~2 s). Mặt dưới `face_min_px` (113 px, ràng buộc của recog ở §3) chỉ báo `FACE_SMALL`, không chạy gì thêm. **Tiền kiểm hình học của §3 "Chốt 1" đứng ngay sau cổng ấy**: ô vuông 1,0× mà `fitted_box` sẽ dựng quanh mặt phải nằm trọn trong khung, không đạt thì báo `FACE_OUT_OF_FRAME` và dừng, **không** chấm sống/giả. Điều kiện nêu bằng chính ô vuông chứ không bằng một lề rời: ô bị kẹp mới là thứ kéo viền vào crop, và nêu như vậy thì không đẻ thêm ngưỡng nghiệp vụ nào cho §4.9. Mọi mặt detect thấy (tối đa 4) đều nằm trong kết quả để UI vẽ hộp; chống chấm trùng cùng một người trong N phút là việc của `svc_attendance`.

**Kết quả là sự kiện, không phải trạng thái.** `step()` trả `SVC_VISION_NONE` ở phần lớn khung; `NO_FACE`/`FACE_SMALL`/`FACE_OUT_OF_FRAME` chỉ báo khi trạng thái quan sát đổi; `SPOOF`/`UNKNOWN`/`MATCH` báo đúng một lần mỗi lượt xác thực. Nhánh spoof vắng trong ảnh `models_0` (§6.2.2) thì pipeline bỏ qua spoof và trả `live_score = −1`; cho cửa hay không với điểm âm đó là quyết định của `svc_attendance`, không phải của tầng này.

Bốn ngưỡng (`detect_min_score`, `live_min_score`, `match_min_score`, `face_min_px`) là ngưỡng nghiệp vụ theo §4.9: `main` đọc từ NVS namespace `vision` (§6.2.1) và truyền vào `svc_vision_init()`; lần boot đầu chưa có key thì `main` gieo từ `Kconfig` của `svc_vision`. `live_min` gieo **750‰**, đo 12/09 trên 57 khung thật của board và 35 khung giả (`docs/measurements/antispoof` §33): mọi khung giả đứng dưới 0,686 nên trên 0,70 là chặn sạch, và 750‰ giữ khoảng đệm mà chỉ trượt 1/57 khung thật. Số ấy **chưa có khung giả chụp bằng chính OV5640**, nên E8-T12 vẫn phải chốt lại. Ba ngưỡng còn lại 🔬 chưa đo.

Header công khai `svc_vision.h` chỉ có C: `svc_vision_init(thresholds)`, `svc_vision_step(const camera_fb_t*, svc_vision_result_t*)`, `svc_vision_reset()`. Khung do `ai_task` giữ bằng `FrameGuard` suốt `step()` và trả sau đó; `svc_vision` không sở hữu khung và không chép khung.

```
components/svc_vision/
├── include/svc_vision.h                  # C: ngưỡng, kết quả, init/step/reset
├── priv_include/{vision.hpp, backends.hpp}   # 4 interface + VisionPipeline · 4 adapter thật
├── src/{pipeline.cpp, backends.cpp, svc_vision.cpp}   # chuỗi thoát sớm · adapter · mặt tiền C
├── Kconfig                               # giá trị gieo cho 4 ngưỡng
└── test_apps/pipeline/{main/test_pipeline.cpp, CMakeLists.txt, pytest_pipeline.py}
```

`test_apps/pipeline` dựng `VisionPipeline` với bốn adapter giả (kịch bản mặt xuất hiện, ổn định, đổi người, giả mạo, mất dấu) và đếm lần gọi từng adapter — chạy trên board **không cần partition model**, kiểm đúng thứ tự detect → spoof → recog và mọi lối thoát sớm. Đây là lý do thực dụng nhất để dùng OOP ở tầng này.

##### e) `svc_door` — chỗ interface trả nợ trực tiếp

Board có một bộ chấp hành (§2.3F): servo gạt thanh chắn. Trừu tượng ở đây không tồn tại để đổi phần cứng — nó tồn tại để `svc_attendance` chạy được trên host với một cánh cửa giả, và để `main`, viết bằng C, nối dây mà không phải biết C++. Giữ nguyên quy tắc *driver viết bằng C*, đặt trừu tượng lên tầng service:

```
components/drv_servo/   [C]   ← driver thuần, chỉ biết đẩy xung LEDC 50 Hz
components/svc_door/    [C++] ← IDoor + ServoDoor bọc driver trên + FakeDoor cho test
```
```cpp
class IDoor {
public:
    virtual ~IDoor() = default;
    virtual esp_err_t open(uint32_t hold_ms) noexcept = 0;   // mở, tự đóng sau hold_ms
    virtual esp_err_t close() noexcept = 0;
    virtual bool      is_open() const noexcept = 0;
};
class ServoDoor final : public IDoor { /* drv_servo_angle() + esp_timer đóng lại */ };
class FakeDoor  final : public IDoor { /* ghi lại lệnh cuối để test kiểm */ };
```

Ba lớp nằm trong `priv_include/door.hpp`. Header công khai `svc_door.h` theo luật §4.5.3 chỉ có cú pháp C: handle mờ `svc_door_t`, `svc_door_servo()` trả về cửa thật dựng tĩnh một lần, `svc_door_fake()` trả về cửa giả, và ba hàm `svc_door_open / svc_door_close / svc_door_is_open` gọi vào bảng ảo bên dưới. `svc_attendance` chỉ thấy `svc_door_t`. `main/app_wiring.c` đưa `svc_door_servo()` vào; `test_apps` của `svc_attendance` đưa `svc_door_fake()` vào cùng chỗ để chạy máy trạng thái chấm công trên host, không cần board. Không có `Kconfig` chọn cơ cấu vì chỉ có một cơ cấu thật.

`ServoDoor::open(hold_ms)` quay tới `APP_DOOR_OPEN_DEG` và đặt một `esp_timer` one-shot; hết `hold_ms` thì `close()` quay về `APP_DOOR_CLOSED_DEG`, rồi sau khi tay đã tới (SG90: 0,1 s/60°) gọi `drv_servo_release()` để motor không giữ dòng. `open()` trong lúc đang mở chỉ gia hạn giờ đóng. Trạng thái được một mutex có timeout bảo vệ vì `attend_task` và task của `esp_timer` cùng đụng vào.

##### f) `svc_attendance` — máy trạng thái bảng, **cố ý không dùng State pattern**

```cpp
enum class St : uint8_t { Idle, Detecting, Verifying, Granted, Denied, Cooldown };
enum class Ev : uint8_t { PresenceOn, PresenceOff, NoFace, FaceSmall, Spoof, Unknown, Match, Timeout };
enum class Act : uint8_t { None, Watch, Grant, Refuse, Rest };
struct Transition { St from; Ev on; St to; Act act; };
static constexpr Transition kTable[] = { … };   // nằm ở flash, 0 byte RAM
```

State pattern (mỗi trạng thái một lớp virtual) nghe "chuẩn OOP" hơn nhưng ở đây **tệ hơn**: 6 lớp + 6 vtable, chuyển trạng thái thành cấp phát/hủy đối tượng, và không nhìn được toàn bộ sơ đồ trạng thái trong một màn hình. Bảng `constexpr` nằm trong flash, đọc một phát thấy hết, kiểm chứng bằng unit test dễ. Dùng mẫu thiết kế phải có lý do, không phải để cho đủ.

**Sơ đồ, đọc hết trong một bảng.** Sự kiện không có trong bảng ở trạng thái hiện tại thì **bị bỏ**, không phải lỗi: `svc_vision` bắn `NONE` ở phần lớn khung và ToF bắn `PresenceOff` bất cứ lúc nào.

| Từ | Sự kiện | Sang | Hành động |
|---|---|---|---|
| `Idle` | `PresenceOn` | `Detecting` | `Watch` — bật preview, chờ mặt |
| `Detecting` | `FaceSmall` | `Detecting` | `None` — chỉ UI nhắc lại gần |
| `Detecting` | `Match` | `Granted` | `Grant` |
| `Detecting` | `Spoof` / `Unknown` | `Denied` | `Refuse` |
| `Detecting` | `NoFace` / `PresenceOff` | `Idle` | `Rest` |
| `Verifying` | `Match` | `Granted` | `Grant` |
| `Verifying` | `Spoof` / `Unknown` | `Denied` | `Refuse` |
| `Verifying` | `Timeout` | `Detecting` | `None` |
| `Granted` | `Timeout` | `Cooldown` | `Rest` |
| `Denied` | `Timeout` | `Cooldown` | `Rest` |
| `Cooldown` | `Timeout` | `Idle` | `None` |
| `Cooldown` | `PresenceOff` | `Idle` | `None` |

`Verifying` tồn tại cho đường xác thực nhiều khung của §4.5.5d: `svc_vision` tự giữ nhịp thử lại, nên tầng này chỉ cần một trạng thái chờ có `Timeout` để không kẹt nếu `ai_task` chết.

**Bốn quyết định nghiệp vụ tầng này giữ, không đẩy xuống dưới:**

1. **Chống chấm trùng.** Cùng một `employee_id` trong `attend.dedup_min` phút thì `Grant` vẫn mở cửa nhưng **không sinh bản ghi mới** — người ta quét lại vì cửa chưa kịp mở, không phải vì muốn chấm hai lần. Cửa sổ là ngưỡng nghiệp vụ nên nằm ở NVS (§4.9, §6.2.1).
2. **Điểm liveness âm.** §4.5.5d trả `live_score = −1` khi ảnh `models_0` không có nhánh spoof. Mặc định là **từ chối**, vì một kiosk không biết phân biệt mặt thật với ảnh in thì không nên mở cửa. `attend.allow_no_spoof` = 1 cho phép bàn thử mở, và bản ghi sinh ra vẫn mang `liveness_score` âm để server biết.
3. **`flags` của bản ghi (§6.2.5).** bit0 theo `svc_door_open` trả về; bit1 bật khi bản ghi chỉ nằm ở LittleFS chưa lên được server; bit2 theo `sys_time_source()`, tức bật khi nguồn giờ chưa từng được NTP xác nhận.
4. **`local_id`.** `boot_count << 32 | seq`, `seq` đếm trong phiên. Không bao giờ trùng kể cả sau mất điện (§6.2.5).

Thời lượng `Granted`, `Denied` và `Cooldown` là nhịp giao diện, không phải ngưỡng nghiệp vụ, nên là hằng số của component chứ không vào NVS.

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

`EmbeddingTable` giữ nguyên ảnh file của §6.2.4 trong PSRAM — header 32 B rồi các bản ghi 552 B — nên ghi bền là một lệnh `write_atomic` của đúng khối đó, và chuẩn bình phương của từng bản ghi được tính sẵn lúc nạp. Tích vô hướng int8·int8 chạy bằng SIMD PIE của ESP32-S3 (`ee.vmulas.s8.accx`, 16 MAC mỗi lệnh) trong `dot_s8_esp32s3.S`: 32 B header và 552 B bản ghi đều chia hết cho 8 nên mọi embedding nằm 8-byte aligned, đủ cho `ee.vld.l.64.ip`; bản C thuần chỉ còn cho target khác. Kết quả số **đúng bằng** bản C — accumulator 40 bit, không làm tròn — nên `cosine.py` bên `ml/` vẫn là bản tham chiếu. Đo 10/09 ở `-O2`, 1.000 bản ghi: vòng C thuần **20,9 ms**, quá mốc 20 ms của E8-T11; số của kernel PIE ghi ở `TASKS.md`.

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

**Hộp mặt trên preview bám theo khung hình, không bám theo nhịp detect.** Detect ra hộp 3–4 lần/giây và im hẳn 0,93 s trong lúc spoof + recog chạy (§4.5.5d); vẽ hộp theo nhịp đó là hộp khựng. `BoxTracker` (`src/box_tracker.cpp`) nhận hộp mới từ `svc_vision`, lấy một mẫu độ sáng **24×24 điểm bám** dưới tâm hộp — mỗi điểm bám là một pixel khung lấy cách 2 (nửa độ phân giải), tức mẫu phủ 48×48 px khung — rồi trên mỗi khung preview (core 0) đổi cửa sổ 40×40 điểm bám quanh vị trí cũ sang độ sáng một lần, quét 17×17 = 289 vị trí trong bán kính ±8 điểm bám (**±16 px khung**, đủ cho người đi ngang ở cự ly kiosk) bằng tổng sai tuyệt đối trên 576 điểm, và dịch hộp theo vị trí khớp nhất. Ba luật giữ nó không nói dối: chỉ dịch khi khớp **tốt hơn đứng yên**; sai lệch trung bình trên 48 mức/điểm là mất dấu, hộp đứng lại; mẫu phẳng (độ tương phản dưới 24 mức) không bám. Hộp mới từ detect **thay thế** hộp đang bám, nên sai số không tích luỹ quá một chu kỳ detect. 🔬 Ước 1–2 ms mỗi khung (~3 % core 0), đo ở `test_apps/tracker`. Bộ bám không phát hiện mặt mới và không đưa gì về đường model: nó chỉ là cách mắt không thấy giật mà kết quả chấm công không chậm thêm một mili giây nào. Kết quả chấm công vẽ đè lên khung preview trong cùng đường này, không qua LVGL cho vùng preview.

```
components/ui_kiosk/
├── priv_include/box_tracker.hpp          # BoxTracker: set(hộp, khung) · update(khung) · box()
├── src/box_tracker.cpp
└── test_apps/tracker/{main/test_tracker.cpp, CMakeLists.txt, pytest_tracker.py}   # khung tổng hợp, không cần camera
```

##### i) Vòng đời đối tượng — dựng một lần, không bao giờ hủy

```cpp
// src/svc_vision.cpp
static AiDetector s_detector; static AiLiveness s_liveness;        // 4 adapter thật, tĩnh
static AiEmbedder s_embedder; static FacedbMatcher s_matcher;
static VisionPipeline s_pipeline(s_detector, s_liveness, s_embedder, s_matcher);

extern "C" esp_err_t svc_vision_init(const svc_vision_thresholds_t* t) {
    /* cấp bộ đệm crop trong PSRAM một lần, configure(t) */
}
extern "C" esp_err_t svc_vision_step(const camera_fb_t* fb, svc_vision_result_t* out) {
    /* fb do ai_task giữ bằng FrameGuard; ở đây chỉ đọc */
    *out = s_pipeline.step(frame_of(fb));
    return ESP_OK;
}
```

Mọi đối tượng C++ nằm trong bộ nhớ tĩnh, dựng đúng một lần trong `app_main`, không có destructor nào chạy trong vòng đời thiết bị. RAII vẫn hoạt động đầy đủ cho những thứ **có phạm vi ngắn** (frame, khoá, profile) — đó mới là chỗ cần nó.

##### j) Bảng tổng kết: dùng gì ở đâu

| Component | Lớp chính | Kỹ thuật | Lý do chọn |
|---|---|---|---|
| `common` | `FrameGuard`, `LockGuard`, `Queue<T,N>` | RAII, template | Xoá cả một lớp lỗi rò tài nguyên |
| `ai_engine` | `ITfliteModel` → `TfliteModelBase` → 3 lớp con | Kế thừa + template method | Ba model khác nhau ở op resolver và hậu xử lý |
| `svc_vision` | `VisionPipeline`, 4 interface + 4 adapter | Chuỗi thoát sớm; tiêm phụ thuộc qua tham chiếu interface | Kết quả nhanh nhất ba model cho phép; test toàn bộ logic với adapter giả, không cần model |
| `svc_facedb` | `FaceDb`, `IMatcher` | Strategy | Đổi thuật toán so khớp khi quy mô tăng |
| `svc_door` | `IDoor`, `ServoDoor`, `FakeDoor` | Adapter bọc driver C, ra ngoài bằng handle mờ | Chạy máy trạng thái chấm công trên host với cửa giả |
| `svc_attendance` | `AttendanceFsm` | Bảng `constexpr`, **không** virtual | Nhìn hết sơ đồ trạng thái trong 1 màn hình |
| `svc_sync` | `UplinkQueue`, `IPersist` | Composition | Thay LittleFS bằng RAM fake khi test |
| `ui_kiosk` | `Screen` → 5 lớp con, `ScreenManager`, `BoxTracker` | Kế thừa; bộ bám là giá trị thuần | Năm màn hình cùng vòng đời; hộp mặt theo khung hình, không theo nhịp detect |

#### 4.5.6 `ai_engine` — mỗi model một thư mục

Ba model không gộp chung một cục. Danh sách op, hậu xử lý và test của từng model nằm cạnh nhau, sửa nhánh nào chỉ mở một thư mục:

```
components/ai_engine/
├── include/ai_engine.h                    # mặt tiền C duy nhất cho cả 3 model
├── Kconfig                                # kích thước 2 arena, E8-T7 chỉnh lại theo số đo
├── priv_include/{tflite_model.hpp, arena.hpp, model_store.hpp, pixels.hpp}
├── src/
│   ├── ai_engine.cpp                      # dựng 2 arena, mở model store, nối 3 model
│   ├── core/                              # dùng chung — KHÔNG chứa gì riêng của model nào
│   │   ├── model_base.cpp                 # TfliteModelBase: arena, interpreter, AllocateTensors
│   │   ├── arena.cpp                      # cấp phát 16-byte aligned, internal → PSRAM fallback
│   │   ├── model_store.cpp                # đọc header partition, trả con trỏ mmap từng entry
│   │   ├── profiler.cpp                   # MicroProfiler, chỉ bật khi CONFIG_AI_PROFILING
│   │   └── pixels.cpp                     # RGB565 → RGB, lấy mẫu bilinear/area, ghi vào tensor int8
│   ├── detection/
│   │   ├── detect_model.hpp               # DetectModel : TfliteModelBase, chỉ khai op + tên
│   │   ├── ops.cpp                        # MicroMutableOpResolver<6>, đếm trên graph thật
│   │   ├── letterbox.cpp                  # khung 480×320 → tensor 160×120, khớp letterbox_params
│   │   ├── decode.cpp                     # giải mã anchor — khớp 1:1 ml/tasks/detection/postproc
│   │   └── nms.cpp
│   ├── antispoof/
│   │   ├── spoof_model.hpp                # lớp + op của nhánh, không ra khỏi thư mục này
│   │   ├── spoof_model.cpp
│   │   ├── ops.cpp                        # MicroMutableOpResolver<7>, đếm trên graph thật
│   │   └── preproc.cpp                    # crop + resize 81×81
│   └── recognition/
│       ├── recog_model.hpp                # lớp + op của nhánh, không ra khỏi thư mục này
│       ├── recog_model.cpp
│       ├── ops.cpp                        # MicroMutableOpResolver<4>, đếm trên graph thật
│       ├── align.cpp                      # affine warp 5 landmark → 113×113
│       └── l2norm.cpp
└── test_apps/                             # chuẩn ESP-IDF, host-side chạy bằng pytest-embedded
    ├── detection/{main/test_decode.c, CMakeLists.txt, pytest_decode.py}
    ├── antispoof/{main/{test_spoof.c, test_preproc.c}, CMakeLists.txt, pytest_preproc.py}
    └── recognition/{main/test_align.c, CMakeLists.txt, pytest_align.py}
```

**Quy tắc**: `src/core/` không được biết tên bất kỳ model nào. Thứ gì chỉ đúng cho một nhánh thì nằm trong thư mục nhánh đó. Thêm model thứ tư sau này = thêm một thư mục, không sửa `core/`.

`src/ai_engine.cpp` nằm ngoài `core/` chính vì lý do đó: nó là chỗ duy nhất gọi tên cả ba nhánh, để dựng đúng model nào vào arena nào. `core/` chỉ nhận `tflite::Model*` và một `Arena&`, không biết chúng thuộc nhánh gì.

**Kích thước arena khai ở `components/ai_engine/Kconfig`**, không gõ vào code, để `sdkconfig.bench` chỉnh được mà không sửa nguồn:

| Symbol | Mặc định | Nghĩa |
|---|---|---|
| `AI_ARENA_FAST_KB` | 224 | `arena_fast` riêng detect. E8-T7 đo detect dùng 189.628 B |
| `AI_ARENA_BIG_KB` | 1536 | `arena_big`, spoof + recog dùng chung. Đo 823.148 B |
| `AI_ARENA_FAST_INTERNAL` | n | `n` = `arena_fast` ở PSRAM; `y` = xin SRAM nội trước (§3.8) |

Xin `arena_fast` ở SRAM nội mà không đủ chỗ thì `Arena` lùi xuống PSRAM và **log cảnh báo** kèm khối liền lớn nhất còn lại — chạy chậm còn hơn không chạy, nhưng phải thấy được là đã lùi.

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
| **Core 1 (APP_CPU)** | **CHỈ `ai_task`** | Một lần `Invoke()` chiếm CPU liên tục **209 ms (detect), 470 ms (spoof), 1.074 ms (recog)** — đo ở `docs/measurements/latency.md`; 🔬 số spoof đo với hai backbone, đo lại khi bản một backbone (§1.1) lên board. Để chung với LVGL thì UI đứng hình hơn một giây, để chung Wi-Fi thì rớt gói. Độc chiếm 1 core là cách duy nhất giữ UI mượt trong lúc AI chạy |
| **Core 0 (PRO_CPU)** | Wi-Fi/lwIP (hệ thống) + camera + LVGL + touch + audio + ToF + MQTT + sync | Toàn bộ là việc ngắn, phần lớn do DMA/ISR gánh; CPU chỉ điều phối |

**`ai_task` phải tự nuôi watchdog, và nhường một tick.** `CONFIG_ESP_TASK_WDT_CHECK_IDLE_TASK_CPU1` bật và timeout 5 giây, mà detect chạy **mỗi frame** nên core 1 bận liên tục và IDLE1 không bao giờ tới lượt. Đã thấy watchdog bắn thật khi chạy invoke liên tiếp trong `bench_ai`. Hai việc khác nhau, phải làm cả hai:

- `ai_task` **tự đăng ký** vào watchdog rồi `esp_task_wdt_reset()` sau mỗi step. Việc này bảo vệ chính nó: một model treo thì watchdog kêu tên `ai_task`. Một lần `Invoke()` lâu nhất là 1.074 ms, còn xa 5 giây, nên không cần hạ timeout.
- `ai_task` **nhường đúng một tick** sau mỗi frame. Ô của IDLE1 chỉ được nạp khi **chính IDLE1 chạy**; `esp_task_wdt_reset()` từ task khác không nạp hộ nó, nên không nhường là watchdog vẫn bắn tên IDLE1 dù `ai_task` báo cáo đều. Một tick 1 ms trên mỗi 210 ms của detect là 0,5% core 1 — rẻ hơn nhiều so với bỏ IDLE1 ra khỏi watchdog, việc **không được** làm.

**Core 1 bão hoà, đừng trông vào chỗ trống của nó.** Camera ra một frame mỗi 70,5 ms còn detect tốn 209 ms, nên AI xử lý được 1 trong 3 frame và không có lúc nào rảnh. Ý định cũ "chuyển `mqtt_task` + `sync_task` sang core 1 vì chúng chỉ chạy khi AI nghỉ" vì thế không dùng được: AI không nghỉ. Core 0 quá tải thì phải giảm việc của core 0 hoặc giảm tần suất chạy detect, không phải đẩy sang core 1.

**Preview chạy song song lấy mất 16,6% của AI.** Core 0 đẩy frame camera và heap LVGL qua PSRAM (~8,7 MB/s), core 1 quét `arena_big` cũng qua PSRAM. Đo với tải đúng bằng lưu lượng đó: một khuôn mặt đi từ 1.758 ms lên **2.050 ms**, và cả ba nhánh chậm đều nhau 16,0–16,7%. **Kể cả detect, dù arena của nó nằm ở SRAM nội** — trọng số vẫn đọc từ flash qua mmap, mà flash và PSRAM dùng chung MSPI lẫn cache dữ liệu. Nên đặt arena ở SRAM **không** miễn nhiễm với tranh chấp bus; muốn giảm khoản 16,6% này thì phải giảm lưu lượng của core 0, không phải chuyển arena.

### 5.2 Bảng task

| Task | Component | Core | Prio | Stack | Kích hoạt | Nhiệm vụ |
|---|---|---|---|---|---|---|
| `cam_task` | `drv_camera` | 0 | 7 | 4 KB | mỗi frame (~15 fps) | `esp_camera_fb_get()` → đẩy con trỏ vào `q_frame_ai` (overwrite) + `q_frame_preview` |
| `tof_task` | `drv_tof` | 0 | 6 | 3 KB | ngắt GPIO3 / poll 100 ms | Đọc khoảng cách → phát `EVT_PRESENCE_ON/OFF`, đánh thức hệ thống |
| `audio_task` | `drv_audio` | 0 | 6 | 4 KB | chờ `q_audio` | Đọc WAV từ LittleFS → `i2s_channel_write` |
| `touch_task` | `drv_touch` | 0 | 5 | 3 KB | ngắt GPIO14 | Đọc GT911 → `q_touch` |
| **`ai_task`** | `svc_vision` | **1** | 5 | 8 KB | chờ `q_frame_ai` | mỗi khung một `svc_vision_step()`: detect, và khi mặt đã ổn định thì spoof → recog → tra bảng ngay trong bước đó (§4.5.5d); kết quả khác `NONE` → `q_result`; `esp_task_wdt_reset()` sau mỗi step (§5.1) |
| `ui_task` | `ui` | 0 | 4 | 8 KB (+ LVGL heap ở PSRAM) | tick 20 ms | `lv_timer_handler()`, vẽ preview, xử lý `q_touch`, đọc `eg_system` |
| `attend_task` | `attendance` | 0 | 4 | 4 KB | chờ `q_result` | State machine, chống trùng, ghi LittleFS, mở cửa, đẩy `q_audio` + `q_uplink` |
| `mqtt_task` | `net_mqtt` | 0 | 3 | 6 KB | esp-mqtt tự tạo | pub/sub, TLS |
| `ota_task` | `net_ota` | 0 | 3 | 8 KB | khi có lệnh `down/ota` | Tải firmware / models, verify sha256, ghi partition |
| `sync_task` | `sync_service` | 0 | 2 | 5 KB | 5 s hoặc khi `q_uplink` có dữ liệu | Đẩy bản ghi offline lên MQTT, chờ ack, xoá khỏi hàng đợi |
| `net_task` | `net_wifi` | 0 | 3 | 4 KB | một nhịp lúc boot | Chờ link rồi giương `WIFI_OK`, để `app_main` không bị giữ 30 s chỉ để biết là không có sóng. **Tạm**: tách thành `mqtt_task` và `sync_task` ở E10-T6 |
| `wifi` / `lwip` | hệ thống IDF | 0 | 18–23 | — | — | Do IDF quản lý, không tự tạo |

> **Quy tắc priority**: mọi task ứng dụng phải < 18 để không chèn Wi-Fi stack. Task có deadline cứng (cam, tof, audio) đặt cao hơn task chỉ cần "mượt mắt" (ui) và task nền (sync).

### 5.3 Bảng Queue / Mutex / Semaphore / EventGroup

| Đối tượng | Kiểu | Kích thước | Gửi | Nhận | Vì sao đặt ở đây |
|---|---|---|---|---|---|
| `q_frame_ai` | Queue, **depth 1**, `camera_fb_t*` | 1 × 4 B | `cam_task` | `ai_task` | Depth 1 + `xQueueOverwrite`: **luôn xử lý frame mới nhất**, frame cũ trả về pool ngay → không dồn RAM, không trễ tích luỹ |

**Không có semaphore giữa ISR camera và `cam_task`.** `esp_camera_fb_get()` đã tự chặn cho tới khi có khung, nên một binary semaphore nữa chỉ là tầng chờ thứ hai chờ đúng thứ mà tầng dưới đã chờ.

| `q_frame_preview` | Queue, depth 2, `camera_fb_t*` | 2 × 4 B | `cam_task` | `ui_task` | Preview cho phép trễ 1 frame |
| `q_result` | Queue, depth 4, `svc_vision_result_t` | 4 × ~104 B | `ai_task` | `attend_task` | Tách hẳn tính toán khỏi nghiệp vụ |
| `q_touch` | Queue, depth 8, `touch_evt_t` | 8 × 8 B | `touch_task` | `ui_task` | Không mất thao tác vuốt nhanh |
| `q_audio` | Queue, depth 4, `sound_id_t` | 4 × 4 B | `attend_task`, `ui_task` | `audio_task` | Phát âm không được chặn nghiệp vụ |
| `q_uplink` | Queue, depth 16, `attendance_rec_t` | 16 × ~96 B | `attend_task` | `sync_task` | Đầy thì ghi thẳng LittleFS, không mất bản ghi |
| `q_presence` | Queue, depth 2, `app_presence_t` | 2 × 4 B | `tof_task` | `attend_task` | Máy trạng thái cần **cạnh**, không cần khoảng cách. Depth 2 đủ cho một lần vào và một lần ra chưa kịp xử lý |
| **`m_i2c`** | Mutex | — | GT911, VL53L1X, PCF8574, DS3231 | — | **Bắt buộc** — 4 thiết bị 1 bus, 3 task khác nhau truy cập |
| **`m_spi_lcd`** | Mutex | — | `ui_task`, `ota_task` (màn hình tiến trình) | — | 1 bus SPI, tránh xé khung hình |
| **`m_facedb`** | Mutex | — | `ai_task` (đọc), `mqtt_task` (ghi khi enroll) | — | Bảng embedding bị sửa giữa lúc đang so khớp = kết quả sai |
| **`m_littlefs`** | Mutex | — | `attend_task`, `sync_task`, `ota_task`, `audio_task` | — | LittleFS không thread-safe mặc định |
| `m_door` | Mutex | — | `attend_task`, task của `esp_timer` | — | `open()` và callback tự đóng cùng đụng trạng thái tay servo (§4.5.5e). Khoá lá: không lấy khoá nào khác bên trong |
| `s_bounce_free` | Counting semaphore, **2 suất** | — | callback `esp_lcd` | `drv_lcd` | Đệm bounce được trả lại thì mới nạp lượt sau. Có hai đệm nên phải đếm được hai suất: binary chỉ giữ được một, đệm rỗi thứ hai sẽ nằm không. Callback **trả** cờ yield cho `esp_lcd` tự nhường, không tự gọi `portYIELD_FROM_ISR` |
| `s_tof_int` | Binary semaphore | — | ISR GPIO3 | `tof_task` | Một lần đo xong là một lần đánh thức, không có suất để dồn |
| `eg_system` | EventGroup | 4 B | mọi task | `ui_task`, `sync_task` | Bit: `WIFI_OK` `MQTT_OK` `TIME_OK` `DB_LOADED` `AI_READY` `OTA_RUNNING` `PRESENT`. Thay cho 7 biến cờ rời rạc |
| `eg_wifi` | EventGroup, nội bộ `net_wifi` | 4 B | handler sự kiện Wi-Fi | `net_wifi_wait_connected()` | `net_wifi` ở L5 không được phụ thuộc lên `app_wiring` ở L7 (§4.5.4), nên trạng thái link phải có chỗ đứng ngay trong component. `net_task` là nơi duy nhất bắc bit này sang `WIFI_OK` của `eg_system` |

**Đường của `EVT_PRESENCE_ON/OFF`.** `drv_tof` chỉ trả khoảng cách (§2.3D), nên `tof_task` là
chỗ biến khoảng cách thành hai cạnh: dưới `vision.present_mm` là có người, trên ngưỡng đó cộng
một dải trễ là hết người, và **chỉ cạnh** mới đi vào `q_presence`. Trạng thái thì đi ra bằng
bit `PRESENT` của `eg_system`, vì `ui_task` chỉ cần biết có ai đứng đó không trên mỗi nhịp
20 ms chứ không phải chờ cạnh. Một người ghi là `tof_task`, hai người đọc hai kiểu khác nhau —
hàng đợi cho `attend_task`, bit cho `ui_task` — nên không cần fan-out. E7-T7 không cần gì
trong số này: `drv_tof` chỉ trả khoảng cách và giương `s_tof_int`.

**Handle của queue và event group nằm ở `main/app_wiring.c`.** `common/include/app_events.h`
(L0) khai `app_presence_t`, `app_sound_t` và bảng bit của `eg_system` — những thứ khai được mà
không cần biết tầng nào tồn tại. Bản thân handle thì không: `q_uplink` chở
`storage_attend_record_t` của L2 và `q_result` chở `svc_vision_result_t` của L4, nên chỗ duy
nhất thấy đủ để dựng chúng là tầng nối dây ở L7 (§4.5.4 luật 2).

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
| `device` | `serial`, `jwt`, `jwt_exp`, `mqtt_host`, `mqtt_port`, `mqtt_user`, `mqtt_pass`, `sntp_host` | str / u32 | token xoay vòng khi còn 7 ngày; `sntp_host` là host hiệu chỉnh giờ, §4.9 xếp host vào loại một nguồn duy nhất nên `sys_time` **nhận qua tham số**, không gõ vào code |
| `model` | `active_slot` (u8: 0/1), `version` (str), `sha256` (blob 32B) | | chọn `models_0` hay `models_1` |
| `sys` | `boot_count` (u32), `last_ota_result` (u8), `fw_valid` (u8), `rtc_ntp_set` (u8) | | `boot_count` dùng sinh `local_id`; `rtc_ntp_set` = 1 khi DS3231 đã từng được một lần SNTP đặt lại. **Tầng nối dây ghi khoá này, không phải `sys_time`**: §4.5.4 cấm phụ thuộc ngang tầng nên L2 `sys_time` không gọi được L2 `sys_storage` (§6.2.5) |
| `ui` | `brightness` (u8), `volume` (u8), `lang` (str) | | không nhạy cảm, cho phép sửa từ màn hình cài đặt |
| `vision` | `detect_min` (u32, ‰), `live_min` (u32, ‰), `match_min` (u32, ‰), `face_min_px` (u32), `present_mm` (u32, mm) | | bốn ngưỡng của §4.5.5d cộng ngưỡng "có người" của §2.3D; boot đầu gieo từ `Kconfig` của `svc_vision`, đổi bằng `SET_CONFIG` |
| `attend` | `dedup_min` (u32, phút), `allow_no_spoof` (u8) | | hai quyết định nghiệp vụ của §4.5.5f; boot đầu gieo từ `Kconfig` của `svc_attendance` theo đúng luật của `vision`, đổi bằng `SET_CONFIG`. `allow_no_spoof` chỉ để bàn thử chạy khi ảnh model chưa có nhánh spoof, mặc định 0 |

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
             arena_hint u32              # arena model này chạy trong (byte); 0 = chưa đo
   +0xD0  reserved                       (44B)
   +0xFC  crc32 của 0x00..0xFB           (4B)

offset 0x0100  detect.tflite
offset ...     spoof.tflite   (căn 16 B — ESP-NN cần)
offset ...     recog.tflite   (căn 16 B)
```

`sys_storage_models_open()` mmap toàn bộ partition một lần và kiểm crc header; `sys_storage_model_find()` tra theo `name` rồi trả `base + entry[i].offset` **cùng `arena_hint`** cho `ai_engine`. Tra theo tên chứ không theo vị trí, nên `count` nhỏ hơn 3 vẫn hợp lệ: khi một nhánh chưa có model, ảnh chỉ chứa những nhánh đã có và các entry còn lại để 0. **Verify sha256 chỉ chạy ngay sau OTA**, không chạy mỗi lần boot — băm 1.7 MB tốn ~200 ms mỗi lần khởi động mà không đổi lại được gì.

`arena_hint` là **số byte của arena mà model đó chạy trong**, không phải phần riêng của nó. Hai nhánh dùng chung một `MicroAllocator` thì cả hai entry ghi **cùng một** con — tổng của nhóm — và `ai_engine` cấp `max` trên từng nhóm; §3.8 nói vì sao `max` đúng và vì sao không thêm field `arena_group`. Nhóm nào chung arena là hằng số kiến trúc khai ở `ai_engine` (§4.5.5c), không nằm trong ảnh.

Ảnh do `ml/src/facepipe/export/pack_models_partition.py` gộp: nó đọc `contracts/models.lock.json` để biết nhánh nào đang deploy, đối chiếu sha256 và `meta.json` của từng nhánh, rồi ghi header + ba khối `.tflite`. `ml/scripts/50_pack_and_flash.sh` gọi nó và ghi kết quả xuống `models_0` bằng `parttool.py`.

**So hai phiên bản model không được sửa contract.** Cả hai script nhận `--lock <file>`; mặc định là `contracts/models.lock.json`, tức bản đang deploy. Lock thí nghiệm nằm ở `ml/artifacts/<nhánh>/` — chỗ đã gitignore — chứ không ở `contracts/`, vì nó không phải hợp đồng mà là một lần đo. Nhờ vậy đo bản B là trỏ `--lock` sang file khác rồi flash lại `models_0`, không đụng `contracts/` và không build lại firmware: `ai_engine` đọc kích thước đầu vào từ chính graph và arena từ `arena_hint`, nên hai bản khác kích thước dùng cùng một binary. Giữ **cả hai** bản trên flash cùng lúc thì cần chọn slot lúc boot bằng `nvs:model/active_slot`, và đó là việc của E13-T2.

**Không phải ngoại vi nào hỏng cũng được chặn boot.** `app_main.c` khởi tạo tuần tự, nhưng
`ESP_ERROR_CHECK` cho **mọi** lời gọi nghĩa là một con hỏng thì cả máy chấm công không lên.
Chia hai nhóm:

| Nhóm | Thiết bị | Hỏng thì |
|---|---|---|
| **Sống còn** | `sys_storage`, `ai_engine`, `bsp_board`, `drv_lcd`, `drv_ioexp`, `drv_camera` | dừng boot — không có chúng thì không chấm công được, cũng không báo được cho người dùng biết vì sao |
| **Suy giảm được** | `drv_touch` | log cảnh báo rồi đi tiếp. Chấm công bằng mặt, cảm ứng chỉ phục vụ màn cài đặt và ghi danh; mất nó thì mất tính năng, không mất máy |

Đây là đúng cách `ai_engine` đã làm với ảnh model thiếu nhánh ở §6.2.2, áp cho ngoại vi.
Thiết bị suy giảm được thì tầng trên phải hỏi trạng thái trước khi dùng, thay vì cho rằng
`app_main` đã bảo đảm nó có.

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

**Nguồn giờ của `ts`, và khi nào bật bit2.** DS3231 (§2.3H) là nguồn giờ **chính**: `sys_time`
đọc nó lúc boot và đặt giờ hệ thống ngay, trước khi có Wi-Fi. Đó là lý do nhánh này không còn
là tuỳ chọn — cửa sổ hỏng là mất điện xong có điện lại mà mạng chưa lên, đúng lúc người ta
tới chấm công, và không có RTC thì `ts` của những bản ghi đó vô nghĩa. SNTP là nguồn **hiệu
chỉnh**: mỗi lần đồng bộ được thì ghi giờ trở lại DS3231 và đặt `sys.rtc_ntp_set` = 1
(§6.2.1).

`flags` bit2 = **`ts` không đến từ một đồng hồ đã từng được NTP đặt**, tức một trong hai
trường hợp: DS3231 báo mất dao động (cờ `OSF`, pin cạn hoặc chưa bao giờ được đặt), hoặc
`sys.rtc_ntp_set` = 0. RTC còn giờ và đã từng được NTP đặt thì bit2 = 0 kể cả khi phiên này
chưa gặp NTP lần nào — sai số ~2 ppm của DS3231 không đáng kể với một bản ghi chấm công.
Server đọc bit2 để biết `ts` tin được tới đâu và **không** được thay `ts` bằng giờ nhận gói:
giờ vào làm là dữ liệu của thiết bị, không phải của broker.

**Ai làm gì.** `sys_time` (L2) đọc `OSF` với thanh ghi giờ, đặt giờ hệ thống, chạy SNTP và ghi
giờ đã hiệu chỉnh trở lại DS3231; nó **báo nguồn giờ ra ngoài** qua API và **không chạm NVS**,
vì §4.5.4 cấm L2 phụ thuộc L2. Cờ bền `sys.rtc_ntp_set` do **tầng nối dây** đọc lúc boot rồi
đưa vào `sys_time`, và ghi lại khi `sys_time` báo SNTP vừa thành công. `svc_attendance` (L5)
hỏi nguồn giờ để đặt bit2 lúc dựng bản ghi. Cách chia này giữ `sys_time` test được trên host
mà không cần storage, và giữ một nguồn sự thật duy nhất cho câu hỏi giờ có đáng tin hay không.

**`record_count` của header log luôn bằng 0.** Header ghi một lần lúc tạo file, nên con số này
chỉ đúng được nếu ghi lại header sau mỗi bản ghi — thêm một lần ghi cộng một `sync` vào cùng
một block cho mỗi 48 byte, tức gấp đôi giá của §6.2.6 và dồn hết vào một block duy nhất. Người
đọc lấy số bản ghi từ kích thước file: `(size − 32) / 48`. Header vẫn phải có vì `magic` và
`record_size` là thứ bắt được một file lệch định dạng, và `format_ver` là thứ cho phép migrate.

**`log/cursor.bin` — 16 B, một bản ghi duy nhất.** §6.2.3 khai file này, §6.2.7 buộc mọi layout
nhị phân phải có bảng trong §6.2, nên bảng của nó là:

| Offset | Kích thước | Trường |
|---|---|---|
| 0 | 4 | `magic` = `'ACU1'` |
| 4 | 2 | `format_ver` u16 |
| 6 | 2 | `file_index` u16 — đã đồng bộ tới `attend.NNN` nào |
| 8 | 4 | `offset` u32 — byte kế tiếp trong file đó, luôn là 32 + k×48 |
| 12 | 4 | `crc32` |

Con trỏ ghi bằng **đúng đường hai pha của `faces.bin`** (§6.2.6): mất điện giữa lúc ghi để lại
con trỏ cũ nguyên vẹn, không để lại 16 byte nửa vời. Con trỏ cũ chỉ gây gửi lại, đúng ý đồ
at-least-once. Không có `cursor.bin` nghĩa là chưa đồng bộ gì, tức `{0, 32}`.

**Ai làm gì.** `sys_storage` (L2) sở hữu tên file, header, xoay vòng 256 KB, `cursor.bin` và
việc xoá file đã đồng bộ hết — §4.1 cho nó độc quyền gọi `lfs_*`, và mục này đã giao cho nó
một hàm header dùng chung cho cả hai định dạng. `svc_attendance` (L5) chỉ đưa xuống bản ghi
48 B đã dựng sẵn. `svc_sync` (L5) đọc bản ghi ở con trỏ, gửi, rồi đẩy con trỏ **sau khi** có
ack. Không component nào ngoài `sys_storage` biết log gồm mấy file.

#### 6.2.6 Quy tắc ghi — chống mất điện

| Việc | Cách ghi | Mất điện giữa chừng thì sao |
|---|---|---|
| Sửa `faces.bin` | Ghi `faces.tmp` → `lfs_file_sync` → rename `faces.bin`→`faces.bak` → rename `faces.tmp`→`faces.bin` | `faces.bin` hoặc còn nguyên bản cũ, hoặc đã là bản mới. Không bao giờ nửa vời. Boot sau đọc `faces.bin`; CRC sai thì rơi về `faces.bak` |
| Thêm bản ghi chấm công | `lfs_file_write` + **`lfs_file_sync` ngay sau mỗi bản ghi**. Lần ghi sau **cắt cái đuôi dở** về mốc 32 + k×48 trước khi ghi tiếp | Bản ghi cuối dở dang bị cắt, các bản ghi trước còn nguyên. Không cắt thì n byte lẻ đó đẩy lệch mọi bản ghi ghi sau nó và cả file đọc ra sai |
| Cập nhật `cursor.bin` | Ghi **SAU KHI** broker trả ack QoS 1, bằng đường hai pha của `faces.bin` | Gửi lại bản ghi đã gửi → server khử trùng bằng `local_id`. Đây là at-least-once, đúng ý đồ — thà trùng còn hơn mất |
| Xoay vòng log | Bản ghi kế tiếp không còn vừa trong 256 KB → mở `attend.NNN+1`, ghi header rồi ghi vào đó. Xoá file cũ chỉ khi `cursor.file_index` đã vượt qua nó | Không mất bản ghi chưa sync. Không file nào vượt 256 KB, nên người đọc chặn được kích thước buffer |
| `tmp/` | Xoá sạch trong `sys_storage_init()` | Không cần quan tâm |

`lfs_file_sync` sau mỗi bản ghi 48 B là đánh đổi có chủ đích: chậm hơn (~10–20 ms/lần ghi) nhưng bản ghi chấm công không được phép mất. Tần suất ghi thấp (vài chục lần/ngày) nên không ảnh hưởng gì.

**Tuổi thọ flash**: 87.000 lần ghi × 48 B, LittleFS có wear-leveling, phân vùng 4 MB → không phải lo trong vòng đời thiết bị. Ngược lại, **không được** ghi `heartbeat` hay log debug xuống LittleFS mỗi giây — đó mới là thứ giết flash.

#### 6.2.7 Struct định nghĩa ở đâu

Mọi layout nhị phân trong §6.2 tồn tại ở **đúng một file**:

```
firmware/components/sys_storage/include/storage_format.h
```

File này là bản dịch 1:1 của §6.2.2, §6.2.4, §6.2.5 sang C — kèm đường dẫn file của §6.2.3 (`STORAGE_FACES_PATH`, …) để không component nào gõ lại chuỗi `/lfs/db/...` — và **bắt buộc có `static_assert`** để trình biên dịch chốt lại con số, không để nó chỉ là bảng trên giấy:

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
| Camera FB ×4 (480×320 RGB565) | 4 × 300 KB = 1.200 KB | **PSRAM** | `fb_location = CAMERA_FB_IN_PSRAM`, `fb_count = 4`, `grab_mode = CAMERA_GRAB_LATEST` | Quá lớn cho SRAM. Một cấu hình cho cả preview và AI (§2.1), nên không có buffer riêng cho nhánh AI. **Cần 4 chứ không phải 3**: `ai_task` giữ một khung tới 2 giây và `cam_task` giữ một khung suốt lúc vẽ, nên với 3 khung cảm biến không còn chỗ để lấp khung kế tiếp và chu kỳ thành *lấp + xử lý* thay vì `max(lấp, xử lý)` — đo 11/09: preview **8,1 fps** với 3 khung, **14,18 fps** với 4, cùng phòng cùng bản (`docs/measurements/latency.md` §6) |
| LCD frame buffer 320×480 RGB565 | 300 KB | **PSRAM** | `heap_caps_malloc(..., MALLOC_CAP_SPIRAM)` | |
| LCD bounce buffer (2 × 20 dòng) | 2 × 19.2 KB | **SRAM (DMA)** | `MALLOC_CAP_DMA \| MALLOC_CAP_INTERNAL` | SPI DMA đọc trực tiếp từ PSRAM bị giới hạn → bắt buộc bounce qua RAM nội |
| **`arena_fast`** — detect một mình @160×120 | **189.628 B** đo thật | **PSRAM** | `heap_caps_aligned_alloc(16, n, MALLOC_CAP_SPIRAM)` | Không nhánh nào nằm vừa SRAM nội (§6.4); `ai_engine` cấp theo `arena_hint` rồi làm tròn lên bội KB |
| **`arena_big`** — anti-spoof @81×81 và recognition @113×113 **chung một `MicroAllocator`** | **422.764 B** đo thật 12/09 | **PSRAM** | như trên | `Σ tail + max(head)` theo §3.8, không phải tổng hai arena. Bản hai backbone từng chiếm 823.148 B |
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

**Hệ quả, sau khi E8-T7 đo thật** (`docs/measurements/arena.md`):

| Arena | Dùng | Cấp | Ở đâu | So với bảng trên |
|---|---|---|---|---|
| `arena_fast` — detect một mình | 189.628 B | 224 KB | SRAM nội | vượt **49 KB** |
| `arena_big` — spoof + recog chung | 422.764 B | 466 KB | PSRAM | bảng này không tính, vì chỉ tính SRAM |

Nạp cả ba trong `bench_ai` xong, RAM nội còn **111 KB**. Nhưng `bench_ai` chưa có Wi-Fi,
LVGL, camera lẫn LCD, nên năm dòng dưới của bảng vẫn chưa chi đồng nào: 55 + 53 + 42 + 57 +
60 = **267 KB**. 111 KB không trả nổi 267 KB, tức **giữ `arena_fast` ở SRAM nội là không
đủ chỗ cho phần còn lại của hệ**.

**Đã chốt: `AI_ARENA_FAST_INTERNAL=n`, cả hai arena ở PSRAM** — và đo lại trên board xác
nhận:

| | `arena_fast` ở SRAM nội | `arena_fast` ở PSRAM |
|---|---|---|
| RAM nội trống sau khi nạp cả ba | 111 KB | **331 KB** |
| Cân đối với 267 KB còn nợ | −156 KB | **+64 KB** |
| detect | 209,1 ms | **232,5 ms** (+23,4) |

Trả 224 KB lại cho hệ thu về **220 KB RAM nội đo thật**, giá là **+23,4 ms mỗi frame** trên
detect, tức 2,0% của một lượt 1.159 ms. Trong 267 KB kia có 42 KB bounce buffer LCD bắt
buộc là DMA nội, nên không có cách nào giữ `arena_fast` ở SRAM mà vẫn đủ chỗ cho LCD.

Đường quay lại khi model nhỏ đi: **thu nhỏ model trước, bật `AI_ARENA_FAST_INTERNAL=y` sau**.
`arena_big` đã nhỏ đi hai lần và cả hai đều là số đo: hạ `width` của recognition xuống 32
đưa 823.148 B về 476.188 B, bỏ nhánh ngữ cảnh của anti-spoof đưa tiếp về **422.764 B**.
`arena_fast` chỉ nhỏ đi khi chính detect nhỏ đi.

Bảng trên là ngân sách **tổng**, mà thứ chặn `arena_fast` lại là dải liền mạch (§3.8). Phải đo lại ở E8-T9 khi Wi-Fi và LVGL đã lên.

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
│                    ├─► LCD kết quả  ├─► loa ├─► IDoor: servo      │
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

**Model**: [YuNet paper](https://link.springer.com/article/10.1007/s11633-023-1423-y) · [libfacedetection.train](https://github.com/ShiqiYu/libfacedetection.train) · [OpenCV Zoo YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) · [Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing) · [arcface_torch](https://github.com/deepinsight/insightface/tree/master/recognition/arcface_torch) · [MobileFaceNet paper](https://arxiv.org/abs/1804.07573)

**Dữ liệu — nguồn thật đang dùng** (trang chủ của dataset ở §1.2): [WIDER FACE](https://huggingface.co/datasets/wider_face) · [RetinaFace 5-landmark](https://github.com/deepinsight/insightface/tree/master/detection/retinaface) · [CelebA-Spoof](https://huggingface.co/datasets/Ar4ikov/celebA_spoof) · [NUAA](https://huggingface.co/datasets/akahana/anti-spoofing-nuaaaa) · [UniqueData live](https://huggingface.co/datasets/UniqueData/anti-spoofing_Real) · [UniqueData replay](https://huggingface.co/datasets/UniqueData/anti-spoofing_replay) · [AxonData masks](https://huggingface.co/datasets/AxonData/face-anti-spoofing-dataset) · [MS1MV3](https://huggingface.co/datasets/gaunernst/ms1mv3-recordio) · [Glint360K](https://huggingface.co/datasets/gaunernst/glint360k-wds-gz) · [benchmark nhận diện](https://huggingface.co/datasets/gaunernst/face-recognition-eval)

**Nền tảng**: [esp-tflite-micro](https://components.espressif.com/components/espressif/esp-tflite-micro) · [ESP-NN](https://github.com/espressif/esp-nn) · [TFLite Micro memory management](https://github.com/tensorflow/tflite-micro/blob/main/tensorflow/lite/micro/docs/memory_management.md) · [esp32-camera](https://github.com/espressif/esp32-camera) · [ESP-IDF partition table](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/partition-tables.html) · [Pinout board GOOUUU ESP32-S3-CAM](https://github.com/profharris/GOOUUU_ESP32-S3-CAM)
