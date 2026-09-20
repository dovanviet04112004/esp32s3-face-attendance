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
| **Anti-spoof** | **MiniFASNetV1SE** của minivision, nhập nguyên trọng số, `conv1` PReLU viết thành stem tách hai nhánh ReLU, ba khối SE giữ Sigmoid, đọc crop ngữ cảnh 2,7× (ADR-0004) | [minivision-ai/Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing) — trọng số `4_0_0_80x80_MiniFASNetV1SE.pth`, kiến trúc ở `src/model_lib/MiniFASNet.py` | **431.958 params**, 42,7 MMAC @80×80, spoof **581 ms** trên board; student distill width 32 (ADR-0003) 262.875 params, 234 ms giữ làm phương án nhẹ | Apache-2.0 (code và weight upstream) |
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
| Anti-spoof (MiniFASNetV1SE nhập, stem tách) | 431.958 | **603 KB** đo trên board 18/09 |
| Recognition (MobileFaceNet, embedding 512-D) | 1.199.488 | 720 KB đo trên board |
| **Tổng** | 1.707.077 | **1.481 KB trong 2 MB** (§6.1), gồm cả detect 158 KB |

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
| UniqueData live + replay | HF `UniqueData/anti-spoofing_Real` + `_replay` | 542 MB + 702 MB: **29 video người thật** (kèm selfie) và **30 clip phát lại chính những người đó** trên màn hình, 30 danh tính | **hai vai**: **train** từ arm 14/09 — đây là cặp đối chứng đúng nghĩa (cùng người, cùng phòng, cùng kiểu chụp, khác đúng tấm màn hình), nên phong cách ảnh không tách được hai lớp và model buộc phải tìm cái màn hình. Giá trị nằm ở **phía thật**, không phải phía tấn công: model bắt phía phát lại tốt (trung vị 0,151) nhưng **từ chối 45,9% khung mặt thật** (số đo 40.5) vì người thường trong phòng thường không giống ảnh studio của CelebA-Spoof — đây là nguồn duy nhất phạt model vì lỗi đó. Lấy khung trải đều và **bỏ hai đầu mỗi clip**: khung đầu của trình phát mang nút ▶ đè lên mặt, để nguyên là đẻ ra một đường tắt mới. Tách **theo người**, không danh tính nào nằm ở cả train và val. Số thật là 30 người chứ không phải số khung — khung trong cùng clip gần trùng nhau, nên cân bằng bằng tỉ trọng chứ không bằng nhân bản |
| AxonData face-anti-spoofing | HF `AxonData/face-anti-spoofing-dataset` | 4.94 GB | test khác miền — video, có **mặt nạ latex 3D** |
| LCC-FASD | Bản Kaggle [`faber24/lcc-fasd`](https://www.kaggle.com/datasets/faber24/lcc-fasd), script `00_fetch_raw.sh` tải bằng token Kaggle khai trong `ml/.env`, không form; [bài báo gốc](https://csit.am/2019/proceedings/PRIP/PRIP3.pdf) (ID R&D 2019) không vào được — **đã tải 11/09/2026** | 5,19 GB, 18.827 PNG: training 1.223 thật / 7.076 giả, development 405 / 2.543, evaluation 314 / 7.266; bố cục `LCC_FASD/LCC_FASD_{training,development,evaluation}/{real,spoof}/` | **hai vai**: split `training` (8.299 ảnh) **trộn vào train** từ arm 11/09, **một lần**, vì đây là bộ duy nhất có thật và giả **chụp lại bằng điện thoại trong cùng loại phòng thường** — đúng thứ CelebA-Spoof thiếu (§3, cảnh làm đường tắt). Không nhân bản: model đã đạt **AUC 1,0000** trên chính bộ này (số đo 40.4), nên mỗi lần lặp thêm là một lần tiêu sức vào ca đã thắng, trong khi kênh chưa giải được chỉ có 2% pool (số đo 40.6); giữ đúng một lần để miền ấy không bị quên; split `evaluation` (7.580 ảnh) là test khác miền, không bao giờ train; `development` (2.948 ảnh) đi vào **val** cùng 10 shard CelebA, để ngưỡng khớp trên hai miền chứ không một. **Không phải identity-disjoint**: `training` và `development` trùng 12 người, `evaluation` ẩn danh nên không kiểm được (`DU_LIEU` §4.2b), nên số trên `evaluation` của arm có trộn phải ghi kèm cảnh báo. Ảnh đã được tác giả cắt sẵn quanh mặt, nên crop 1,0× của detector nằm trong ảnh cắt đó |
| SynthASpoof | Google Drive **công khai** (`SynthASpoof.zip`, id ghi trong manifest, script `00_fetch_raw.sh` tải bằng gdown), [GitHub](https://github.com/meilfang/synthaspoof) — **đã tải 11/09/2026** | zip 12,36 GB, 103.797 PNG 256×256 đã cắt mặt: 25.000 thật tổng hợp (`BonaFide`) + 78.797 tấn công (`PAs/`: in 3.800, phát lại Samsung 24.999, iPad 24.998, webcam 25.000) | **hai vai**, tách theo ảnh và **giữ từng kênh là một nguồn riêng ở cả hai nhánh**: **test** lấy 2.000 ảnh trải đều mỗi kênh (10.000, đọc APCER theo thiết bị chụp lại); **train** lấy phần còn lại với **hạn mức đặt theo độ khó đã đo** (số đo 40.5) — `iPad_ReplayAttack` là kênh duy nhất model chưa giải (AUC 0,8729, trung vị tấn công 0,809, cùng hạng với đòn thật của board) nên lấy tối đa, còn `Samsung`, `webcam`, `print` đã ở 0,97–0,98 nên chỉ giữ mức đủ để không quên. **Gộp bốn kênh thành một nguồn là sai**: `train_split` khi đó không nâng được iPad mà không nâng kèm ba kênh dễ, và đó chính là cách kênh khó tụt xuống 2% pool (số đo 40.6). Mặt thật là ảnh sinh, nên bộ này không thay được ảnh thật của camera — bài báo gốc cũng train trên nó và test trên bộ thật. CC BY-NC-SA 4.0, chỉ nghiên cứu, không sản phẩm |
| MS1MV3 — mượn từ nhánh recognition | HF `gaunernst/ms1mv3-recordio`, đã cắt sẵn ở `interim/recognition/ms1mv3_shards` cho §1.2 nhánh nhận diện | 28 GB, 518 shard, **93.431 danh tính**, ≈ 5,2 triệu ảnh mặt căn chỉnh 112×112 | **train, chỉ phía thật** từ arm 14/09. Lý do là một phép đo, không phải thiếu số lượng: trên khung OV5640 chụp dưới đèn huỳnh quang, **không đặc trưng màu nào tách nổi mặt thật khỏi ảnh giả** — `chroma_hp` 0,5397, `sat_mean` **0,3889 tức đảo chiều** (số đo 40.8), trong khi cùng model ở phòng khớp sáng đạt 0,9932. Phía thật của pool quá hẹp nên độ bão hoà **tách được hai lớp ngay trong tập train**, và model học đúng lối tắt đó. Lấy **một ảnh mỗi danh tính**, rải bước nhảy qua shard, cỡ 20.000 ảnh: mục tiêu là **bề rộng người và ánh sáng**, không phải số lượng. Khi phía thật trải khắp dải bão hoà thì đại lượng ấy hết tách được hai lớp, và mạng buộc bỏ trục đó — dữ liệu làm việc mà nới augment không làm được (§39 đã bác đường nới augment). **Giữ dưới mức các nguồn ghép cặp**: đổ ồ ạt một nguồn vào một lớp là dựng lại đúng confound §22.3, lần này thành "ảnh web = thật". Ảnh web nên một phần nhỏ có thể tự nó là bản chụp lại; với 93.431 danh tính thì đó là nhiễu nhãn, không phải thiên lệch |
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

**Nhà sản xuất không cam kết con điều khiển.** Bảng thông số của module ghi ô "驱动芯片" là
**`ILI9486 / ILI9488 / ST7796S`** — ba con, hàng nào có thì lắp con ấy. Ba con dùng chung phần
lớn tập lệnh chuẩn MIPI DCS nên vẫn lên hình với cùng một đoạn khởi tạo, nhưng **dải `0xB0`–`0xC7`
thì mỗi con một nghĩa**: `0xC0` của ST7796S là AVDD/VGH/VGL còn của ILI9486 là hai thanh ghi `VRH`,
`0xC5` của ST7796S nhận **một** tham số VCOM còn của ILI9488 nhận **bốn**. Ghi mù vào dải đó là
ghi vào một bản đồ thanh ghi có thể không phải của con đang cắm. Vì vậy `drv_lcd_init()` đọc
`RDID4` (`0xD3`) rồi in mã chip ra log boot: ST7796S trả `00 77 96`, ILI9486 trả `00 94 86`,
ILI9488 trả `00 94 88`. Đường đọc đã có sẵn — chính đường đọc dòng quét `0x45` của §2.3A.
**Đo 19/09: `panel id 007796`** — module này là ST7796S, nên bản đồ thanh ghi đang dùng là đúng.

**Giao thức đọc 4 dây chèn một bit dummy, và nó dịch mọi giá trị đọc được.** Chuỗi thô của
`RDID4` về là `00 3b cb 7f`; bỏ **đúng một bit đầu** mới ra `00 77 96`. Hệ quả nằm ở chỗ khác:
`scan_line()` đọc `0x45` cùng kiểu và **không** bỏ bit ấy, nên 16 bit nó lấy là `N15…N1` chứ
không phải `N15…N0` — con số đọc ra là **N/2**. Vậy dải `0…241` mà `SCANLINE_UNITS` chốt thực ra
là bộ đếm **`0…483`** đọc ở nửa độ phân giải, và **484 = 480 + VFP 2 + VBP 2** đúng bằng tổng số
dòng một khung khi `BPC (0xB5)` để mặc định. Ba số đo tự khớp: 41,6 ms ÷ 242 nấc = 172 µs mỗi
nấc, mỗi nấc 2 dòng thật → 86 µs mỗi dòng, 484 × 86 µs = 41,6 ms = **24,0 Hz**, đúng con số
`FRMCTR1 = 0x81 0x1F` tính ra từ công thức §9.3.2. Khoá pha **không sai** vì nó chỉ cần vị trí
tương đối và đơn điệu; nhưng ai đọc `SCANLINE_UNITS` mà tưởng panel có 242 dòng thì sai gấp đôi.

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

**Hàng SD nằm đối xứng với hàng 14 chân**, cùng lùi vào 1,5 mm — đo khoảng cách hai hàng được
104 mm trên tấm màn 107 mm thì chỉ còn cách đó. `J14` dùng footprint tự vẽ `BareHoles_1x04`:
bốn lỗ trần, **không vẽ đường bao in lụa**, vì chỗ ấy không có đế cắm nào và đường bao duy nhất
có nghĩa là khung tấm màn. Nó cách hai lỗ vít đầu trên **20 mm** nên không đụng, và có lệch
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

**Kích thước tấm màn: 108,04 × 61,74 mm**, theo bản vẽ cơ khí của `KMRTM40045`. Nó quyết định
luôn chiều cao board đế: 108,04 mm cộng chỗ cho hàng chữ tên chân ở **cả hai đầu** là **121 mm**
— mỗi đầu phải chừa đủ 4,3 mm cho một chuỗi như `CTP_SDA` cộng lề mép, và ở 121 mm mỗi đầu còn
**6,48 mm**. Tấm màn vì thế phủ gần trọn chiều cao board, và dải còn lại dưới mép tấm màn không
nhét vừa một con tụ nào. Vì thế tụ `C4` của màn nằm **bên trái** tấm màn, trong khe giữa devkit
và tấm màn, chân dương **thẳng hàng với chân `VCC` của `J3`** và cách nó **18,4 mm**; nó là tụ
trữ chứ không phải tụ lọc cao tần nên quãng đó chấp nhận được, còn lọc cao tần thì module màn
tự mang.

Khe đó rộng **8,39 mm** cho một thân tụ 6,3 mm. Tụ đứng yên mà mép tấm màn lấn về phía nó, nên
hai bên không hở đều: **0,98 mm** phía devkit và **0,61 mm** phía tấm màn — và để có được
chừng đó thì devkit phải dịch sang trái 2 mm. Đường bao của devkit vì thế chỉ còn cách mép trái
board 1,75 mm, nhưng đường bao đó **cố ý vẽ rộng hơn thân thật** (§2.6 không có datasheet cho
board này), nên mép thật của module vẫn cách mép board khoảng 4 mm.

**Kính không nằm giữa PCB, và chỗ dôi ra là chỗ để hàng chân với lỗ vít.** Vùng hiển thị ghi
trên bản vẽ là **83,52 × 55,68 mm**, nên so với PCB 108,04 × 61,74:

| Chiều | PCB | Kính | Dôi mỗi bên |
|---|---|---|---|
| Rộng | 61,74 | 55,68 | **3,03 mm** |
| Dài | 108,04 | 83,52 | **12,26 mm** |

Hai con số đó ràng buộc thiết kế theo hai hướng ngược nhau. Cạnh dài chỉ dôi **3,03 mm** nên
**không khoan được lỗ vít ở giữa hai cạnh dài** — lỗ Ø3,5 cần nhiều hơn thế. Cạnh ngắn dôi
**12,26 mm**, đủ rộng cho cả hàng chân lẫn hai lỗ vít, và đó là lý do bốn lỗ đặt ở **bốn góc**:
góc là chỗ duy nhất có vật liệu.

Cùng con số đó chặn khoảng lùi của hàng chân ≤ **12,26 mm** — hàng chân phải nằm trong dải dôi,
không thể chui xuống dưới kính. Kính **không cân giữa theo cạnh dài**: đầu mang hàng 14 chân dôi
nhiều hơn đầu kia, nên 12,26 mm là số cân giữa chứ không phải số đo của từng đầu.

**Hàng chân nằm ngang hàng với hai lỗ vít đầu dưới**, nhích về phía mép khoảng **1 mm** (nhìn
trên module 12/09). Nhờ đó hai khoảng lùi không còn độc lập: đo lỗ là biết luôn hàng chân, nên
`LCD_HEADER_INSET` suy ra từ `LCD_HOLE_INSET` chứ không khai riêng. `J3` tụt xuống `y = 107,5`
cho mép xa của tấm màn không tràn khỏi mép trên board, và hàng chữ tên chân của nó rơi **ngay
dưới** mép tấm màn — tức là vẫn đọc được sau khi lắp màn, không bị che.

**Bốn lỗ vít đã có số đo (12/09).** Vít M3 qua lỗ Ø3,5 của tấm màn rồi qua lỗ Ø3,2 của board đế
chỉ xê dịch được **0,35 mm**, nên đây từng là con số duy nhất chặn đường gửi xưởng. Đo **tâm lỗ
tới tâm lỗ** chứ không đo tới mép tấm — mép tấm rồi suy ra thì dễ nhầm chỗ đặt thước. Khai ở đầu
`hardware/gen/gen_pcb.py`, sửa xong sinh lại là bốn lỗ lẫn `J3` tự dịch theo:

| Hằng số | Đang đặt | Nguồn |
|---|---|---|
| `LCD_PANEL` | **61,74 × 108,04 mm** | Bản vẽ cơ khí `KMRTM40045` |
| `LCD_HOLE_PITCH` | **55,0 × 102,0 mm** | Đo tâm–tâm trên tấm màn 12/09 |
| `LCD_HOLE_INSET` | 3,37 / 3,02 mm | Suy ra: `(61,74 − 55)/2` và `(108,04 − 102)/2` — **hai chiều không bằng nhau** |
| `LCD_HEADER_DROP` | 1,0 mm | Hàng chân thấp hơn hàng lỗ bao nhiêu, nhìn trên module |
| `LCD_HEADER_INSET` | 2,02 mm | Suy ra: `LCD_HOLE_INSET dọc − LCD_HEADER_DROP` |

**Ba phép đo tự kiểm chéo nhau.** Khoảng cách giữa hàng 14 chân và hàng 4 chân microSD đo được
**104 mm**; từ chuỗi trên mà suy thì phải là `108,04 − 2,02 − 2,02 = 104,00`. Khớp. Bản vẽ ghi
tâm lỗ lùi vào **3,00 mm** theo cạnh dài và **3,42 mm** theo cạnh ngắn, cho `108,04 − 2 × 3,00 =
102,04` và `61,74 − 2 × 3,42 = 54,90` — lệch bước đo tâm–tâm **0,04** và **0,10 mm**, đều nhỏ hơn
0,35 mm mà vít M3 còn xê dịch được trong lỗ Ø3,5. Nếu lúc đo lỗ mà kẹp thước theo mép ngoài thay
vì tâm–tâm thì chuỗi ấy cho ra **100,5 mm**, lệch hẳn — nên phép đo thứ hai chốt luôn rằng phép
thứ nhất đọc đúng cách.

**Sửa `LCD_PANEL` không dịch một lỗ khoan nào.** Bốn lỗ và hai hàng chân neo vào bước đo tâm–tâm
với khoảng cách hai hàng, cả hai đều đo thẳng trên module; `LCD_PANEL` chỉ nuôi hình chữ nhật
đứt nét của tấm màn và các phép kiểm chồng lấn. Toạ độ sinh ra giữ nguyên `H1`…`H4` ở
(44,55 / 99,55) × (9,50 / 111,50) và `J14` ở `y = 8,50`; thứ duy nhất đổi là mép tấm màn nhích
ra **0,37 mm** mỗi bên cạnh dài và **0,52 mm** mỗi đầu cạnh ngắn.

⚠️ Theo chiều dọc, lỗ Ø3,5 thụt vào 2,50 mm nên chỉ còn **0,75 mm vật liệu** tới mép tấm màn.
Siết vừa tay; siết mạnh là nứt mép.

| Chân LCD | GPIO | Vai trò | Lưu ý |
|---|---|---|---|
| VCC | **`+3V3_LCD`** | Rail riêng | **Không lấy `+3V3` của devkit**: dãy LED đèn nền không có gì ổn áp nên độ sáng bám thẳng theo rail, mà rail ấy còn nuôi lõi 240 MHz với PSRAM 80 MHz. **Cũng không nuôi 5 V**: trở treo `CTP_SCL` của module lấy điện từ chính `VCC` (§2.5 luật 8, 9) |
| GND | GND | | |
| SCL / SCK | **GPIO42** | SPI CLK | **80 MHz** — ở 40 MHz một khung 307 KB mất 61 ms, màn hiện hai khoảnh khắc cùng lúc và mặt di chuyển thấy rõ vạch |
| SDA / MOSI | **GPIO41** | SPI MOSI | |
| SDO / MISO | **GPIO43** | Đọc thanh ghi panel | Khoá pha đọc `GET_SCANLINE`, chẩn đoán đọc `RDDPM`/`RDDSDR`/`RDID4` (xem dưới). Đọc **4 MHz**: 1–2 MHz không ra dữ liệu, **3 MHz chỉ đúng 42 %**, 4 MHz đúng 99,99 %, trên 6,6 MHz vượt chu kỳ đọc 150 ns của datasheet |
| CS | **GPIO47** | Chip select | |
| DC / RS | **GPIO39** | Data / Command | Chân thường. Không đặt trên GPIO45: board LCD hay có pull-up ở DC, mà GPIO45 là strapping VDD_SPI — kéo lên lúc reset là chọn flash 1.8 V và board không boot |
| RES | **GPIO40** | Reset panel | (nguyên là SD_DATA — trống vì không dùng microSD) |
| BLK | **GPIO21** | Backlight | LEDC PWM 5 kHz. Nếu backlight > 40 mA → qua MOSFET N (AO3400) |

**Khoá pha để preview không bị xé hình.** Panel quét lại bộ nhớ ảnh của nó theo nhịp riêng,
không đồng bộ với lúc firmware ghi. Đo trên board: một khung 320×480 RGB565 (307 KB) mất
**31,7 ms** để ghi ở 80 MHz, còn chu kỳ quét mặc định là **17,5 ms** — nên trong lúc ghi,
tia quét lướt qua vùng đang ghi ~1,8 lần và mỗi lần để lại một vết cắt ngang giữa phần khung
mới và phần khung cũ. Mặt người di chuyển thấy rõ. Khấc **chỉ nhìn thấy được khi ảnh chuyển
động nhanh**: cảnh đứng yên thì khung rách trông y hệt khung lành, nên nghiệm thu phải vuốt tay
trước ống kính chứ không phải nhìn màn tĩnh.

Điều kiện để hết hẳn: **con trỏ ghi phải chạy trước tia quét trọn cả khung**. Cần hai thứ:

| Điều kiện | Cách đạt |
|---|---|
| Chu kỳ quét **dài hơn** thời gian ghi | `FRMCTR1 (0xB1) = 0x81 0x1F` → **42,98 ms** đo được (23,26 Hz) |
| Bắt đầu ghi khi tia quét còn cách vạch cuộn vòng một quãng **có sàn và có trần** | Đọc `GET_SCANLINE (0x45)` qua `SDO` mỗi 1 ms, thấy bộ đếm vào đoạn **160…200** thì ghi |

Bộ đếm của `0x45` chạy **0…241** đều đặn 172 µs mỗi đơn vị (dump 240 lần đọc liên tiếp,
18/09), tức mỗi đơn vị bằng 2 dòng vật lý và trọn một vòng là 41,6 ms. Bắt đầu ở đoạn cuối chứ
không đợi đúng lúc cuộn vòng: con trỏ ghi xuất phát từ dòng 0 trong khi tia quét còn đang quét
nốt phần dưới, nên có **quãng chạy đà** trước khi bị đuổi.

**Cửa sổ phải có trần, không chỉ có sàn.** Một ngưỡng đơn "từ 220 trở lên" chấp nhận cả giá trị
241, mà ở đó quãng chạy đà chỉ còn **0,17 ms** — gần như không có. Khung nào rơi đúng mép ấy thì
chỉ cần lượt vẽ chậm hơn thường vài ms là bị vượt, và đó là lý do khấc quay lại từng đợt trong
vài giây đầu sau khi bật nguồn, lúc Wi-Fi bắt tay và SNTP chỉnh giờ còn đang chiếm lõi 0.

Gọi `H` là quãng chạy đà, `T` là thời gian ghi trọn khung. Tia quét đi 11,54 dòng/ms. Ngòi ghi bị
đuổi kịp ở dòng `R = H / (T/480 − 1/11,54)`; hết khấc khi `R > 480`. Bảng dưới là hệ quả trực tiếp:

| Bộ đếm lúc bắt đầu | `H` | `T` chậm nhất còn an toàn |
|---|---|---|
| 241 | 0,17 ms | 41,7 ms |
| 220 | 3,8 ms | 44 ms |
| 200 | 7,2 ms | 47 ms |
| 160 | 14,1 ms | 53 ms |

Nên cửa sổ là **160…200**: sàn 160 giữ độ rộng cửa sổ (41 đơn vị, 7,1 ms) **rộng hơn** đoạn
220…241 cũ nên thời gian chờ trung bình **ngắn hơn**, còn trần 200 bảo đảm mọi khung đều có ít
nhất 7,2 ms chạy đà. Thời gian ghi đo được là 33–36 ms, đỉnh 40 ms, nên biên đi từ 2 ms lên
**11 ms** mà không giảm một điểm ảnh nào và không đổi tốc độ khung.

Đọc `0x45` không được thì **đọc lại tối đa 4 lần** rồi mới ghi như không có khoá pha. Lần đọc đầu
ngay sau một lượt ghi panel luôn trả giá trị ngoài dải, và bỏ cuộc ngay lần đầu làm **49 % số
khung** ghi lệch nhịp trong im lặng (đo 18/09, 616/1.260 khung). Một khung bị xé vẫn tốt hơn một
preview đứng hình, nhưng chỉ sau khi đã thử lại.

**Khoá pha áp cho cả hai đường vẽ, không riêng đường preview.** Màn phủ kín đi qua
`drv_lcd_paint` chứ không qua `drv_lcd_blit_frame`, mà nó cũng ghi trọn 320×480 và cũng mất
~31 ms. Ngòi ghi chạy 15,5 dòng/ms còn tia quét 11,6 dòng/ms, nhanh hơn **1,33 lần**, nên mỗi
lượt vẽ lại **cắt ngang màn đúng một lần** nếu không chờ pha. Một lượt thì không ai thấy; chạm
dồn dập trên màn `Cài đặt` thì mỗi lần chạm đẻ hai lượt vẽ lại (ấn và nhả), **chạm 5 lần/giây là
10 vết cắt mỗi giây** và chữ trông như nhấp nháy. Giá của việc chờ là ~16 ms mỗi lượt vẽ lại, mà
màn phủ kín chỉ vẽ khi có sự kiện chứ không vẽ 14 lần/giây, nên không mất gì.

**Hai khoang overlay là một lỗi riêng, và nó mới là thứ làm chữ nháy lúc chạm.** `cam_task` cầm
con trỏ overlay suốt một lượt blit ~50 ms, còn `ui_task` thì **xoá** khoang trước khi vẽ lại. Với
hai khoang, chỉ cần `ui_task` publish **một** lượt trong khi blit đang chạy là nhịp sau nó quay về
xoá đúng khoang người đọc đang đọc. Đo 19/09 bằng bộ đếm thế hệ từng khoang, trong lúc chạm
**457 lần** trên màn preview: **156/660 khung = 23,6 %** đọc trúng khoang đang bị xoá, tức ~3,3
khung hỏng mỗi giây ở 14 fps.

Phép đếm đầu tiên chấm **0/720** vì nó đếm nhầm thứ: nó hỏi "có hai lượt publish trong một blit
không", mà hỏng xảy ra ngay ở **lượt xoá tiếp theo sau lượt publish thứ nhất**, lúc bộ đếm publish
mới bằng 1. Bài học: đếm đúng cái sự kiện gây hỏng, đừng đếm một thứ tương quan với nó.

**Cách chữa không tốn thêm byte PSRAM nào** — không thêm khoang thứ ba, vì mỗi khoang là một
canvas 153.600 ô và sổ PSRAM chỉ còn 7,7 KB. `cam_task` **giữ chỗ** khoang nó đang đọc;
`ui_task` chỉ vẽ vào khoang **không phải khoang đang hiện trên kính và cũng không phải khoang
đang bị giữ**, không còn khoang nào rảnh thì **bỏ nhịp đó và giữ `s_dirty`**. Giao diện vốn không
hiện nổi quá một overlay mỗi lượt blit, nên publish nhanh hơn người tiêu thụ chỉ là vừa phí vừa
hỏng; trần nhịp cập nhật tụt về đúng nhịp blit ~14 lần/giây.

**Soát cùng lượt tìm ra bốn chỗ nữa cùng loại.** `rest_level()` hỏi "màn có phủ kín không" bằng
cách đọc thẳng trường `opaque` **trong khoang overlay**, và nó được gọi từ bốn task khác không
hề giữ chỗ. Câu hỏi ấy giờ trả lời bằng một cờ riêng do `publish()` đặt, nên không task nào phải
chạm vào bộ nhớ khoang để biết. Cùng nguyên tắc: **thứ nhiều task cùng hỏi thì đừng để nó nằm
trong vùng nhớ đang được ghi lại.**

Nghiệm thu 19/09 sau khi sửa: **490 lần chạm trải khắp preview, `Menu` và `Cài đặt`, 0/840 khung
hỏng** (trước là 23,6 %), fps 12,9–14,2 không đổi, không dòng lỗi nào.

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

**`drv_lcd` chỉ ghi đúng một thanh ghi của panel: `FRMCTR1 (0xB1)`.** VCOM `0xC5` và kiểu đảo
cực `0xB4` để nguyên như thư viện `esp_lcd_st7796` cài, vì **không phép đo nào đứng vững sau lưng
việc đổi chúng**: quét `0xC5` cả dải `0x00`–`0x3C`, 16 bậc, trên nền trắng cho kết quả **phẳng**
(bảng vùng đã loại ở dưới), còn nhấp nháy thì hoá ra là của **đèn nền** chứ không của tấm kính —
cho panel ngủ hẳn mà dãy LED vẫn sáng thì nó vẫn nháy.

Lần đo 11/09 từng chấm bằng mắt rằng `0x2C`–`0x34` êm còn column inversion làm dải trắng êm;
cả hai kết quả ấy **không lặp lại được** ở lần nghiệm thu 18/09 với cùng cách đo và cùng module.
Bài học ghi lại vì nó tái diễn được: **chấm bằng mắt trên một hiện tượng có nguyên nhân khác
đang chi phối thì cho ra tương quan giả**, và một thanh ghi ghi theo tương quan giả là một thanh
ghi không ai giải thích được về sau.

**Nghiệm thu 18/09 lật lại kết luận trên: VCOM vô can.** Quét lại cả dải `0x00`–`0x3C`, 16 bậc,
bấm tay từng bậc trên nền trắng — **gần như không đổi gì**, nên `0x30` của 11/09 là trùng hợp chứ
không phải nhân quả. Hai quan sát mới cắt gọn bài toán: nhấp nháy thấy rõ **trên màn `Menu`**, mà
màn ấy là lớp phủ kín nên `cam_task` vẽ đúng một lần rồi thôi — lúc nó rung, **không một byte nào
đi trên SPI**, loại sạch camera, khấc hình và khoá pha. Và nó **nặng hơn khi quét nhanh hơn**,
tức ngược hẳn với cơ chế "nạp lại thưa quá" ở đoạn trên.

Datasheet ST7796S §9.3.9–9.3.11 chỉ đúng chỗ. **`PWR3 (0xC2)`**: `D3-D2 = SOP[1:0]` là *source
driving current level*, `D1-D0 = GOP[1:0]` là *gamma driving current*, thang `00` không chạy,
`01` thấp, `10` vừa, `11` cao. Thư viện cài `0xA7`, nibble thấp `0111` → **SOP = Low**, tức dòng
lái cột ở mức thấp nhất khác không. Đó chính là dòng nạp điện dung điểm ảnh trong từng dòng quét,
nên quét nhanh hơn thì thời gian nạp ngắn hơn và điểm ảnh không tới đủ áp — sáng tối theo nhịp,
không đụng gì tới VCOM. **`PWR2 (0xC1)`** cùng chiều: `VRH[6:0]` đặt GVDD, thư viện cài `0x06` =
**3,85 V** trong khi mặc định của chính con chip là `0x13` = **4,50 V**, tức biên độ lái cột cũng
bị hạ. `PWR1 (0xC0)` đặt VGH/VGL và AVDD thì không ai ghi, để nguyên mặc định — nó không dính tới
thời gian nạp.

**Thử hết bốn nút ấy 18/09 và không nút nào ăn thua.** Bảng dưới là toàn bộ vùng đã loại, ghi lại
để không ai đi lại:

| Đổi gì | Từ → tới | Kết quả |
|---|---|---|
| VCOM `0xC5` | quét cả dải `0x00`–`0x3C`, 16 bậc | không đổi |
| Dòng lái cột `0xC2` | `0xA7` (SOP Low) → `0xAF` (SOP High) | không đổi |
| Tần số quét `0xB1` | 24 Hz → bỏ hẳn lệnh, về mặc định ~60 Hz | không đổi |
| Độ sáng đèn nền | 100 % → 70 → 40 → 20 → 10 → 5 % | **mức nào cũng nháy** |
| Băm xung đèn nền | LEDC 5 kHz → **kéo thẳng chân lên cao, DC phẳng** | **vẫn nháy** |
| Trạng thái nguồn `0x0A` | 30.000 lượt đọc nền trắng, 30.000 nền đen | `BSTON = 1` mọi lượt |
| Tự kiểm `0x0F` | 30.000 lượt mỗi nền | `D7 D6 = 1 1`, `D0 = 0`, **không đổi lượt nào** |

**Chính panel khai là nó khoẻ, và khai giống hệt nhau ở trắng lẫn đen (19/09).** `RDDPM (0x0A)`
trả `BSTON = 1` — bơm điện tích đang chạy — cùng `SLPOUT`, `NORON`, `DISON` đều bật, suốt 60.000
lượt đọc. `RDDSDR (0x0F)` trả `D7 = 1` nạp thanh ghi đạt, `D6 = 1` chức năng đạt, `D0 = 0`
checksum khớp, **không lệch một lượt nào** trong 30.000 lượt mỗi nền. Nếu rail sập dưới tải nền
trắng thì hai thanh ghi này phải động đậy. Chúng không. Giả thuyết "bơm điện tích đói dòng" vì
thế **không có bằng chứng**, và đường "cấp nguồn riêng" cũng mất phần lớn cơ sở.

Hai con số nữa chốt lại vùng đã loại. **Thư viện `esp_lcd_st7796` không ghi `0xB1`** — bảng khởi
tạo của nó chỉ có `0xf0/0xb4/0xb7/0xe8/0xc1/0xc2/0xc5/0xe0/0xe1`. Nên phép thử "bỏ lệnh `0xB1`"
đúng là thả panel về mặc định **60,1 Hz** thật, không phải âm tính giả; nhịp quét vô can. Và
`PWR1 (0xC0)` mặc định `0x80` đọc theo bảng bit §9.3.9 là `AVDDS = 2` → **AVDD 6,60 V**, trong
khi `GVDD = 3,85 + 1,50 = 5,35 V`, tức còn **1,25 V** biên — không phải sát trần. Nấc duy nhất
còn lại là `AVDDS = 3` → 6,80 V, mua thêm 0,2 V.

**Xung đọc 3 MHz là xung hỏng, và nó giấu mặt suốt từ đầu.** `RDID4 (0xD3)` là hằng số trong
silicon nên mọi lượt đọc phải ra một giá trị; ở 3 MHz nó chỉ ra đúng **42 %**, và tỷ lệ ấy trôi
từ 82 % xuống 1,6 % giữa hai lượt đo cách nhau 15 phút mà không ai đụng code. Quét 5 mức xung ×
5 mức `input_delay_ns`, mỗi ô 2.000 lượt đọc, trên chính bus đó:

| Xin | Driver sinh thật | Giá trị trội | Ổn định |
|---|---|---|---|
| 1 MHz | 1.000 kHz | `ffffffff` | không có dữ liệu |
| 2 MHz | 2.000 kHz | `007fdf7f` | 100 % nhưng sai |
| **3 MHz** | **2.962 kHz** | `003bcb7f` | **42 %** |
| **4 MHz** | **4.000 kHz** | `003bcb7f` | **100 %** |
| 6 MHz | 6.153 kHz | `003bcb3f` | 100 % |

`input_delay_ns` từ 0 đến 100 ns **không đổi một phần trăm nào**, nên đây không phải chuyện bù
trễ dưới mức một bit. 🔬 Vì sao đúng mức 2.962 kHz hỏng trong khi 4.000 và 6.153 kHz đều sạch
thì chưa giải thích được; số đo lặp lại ở hai lần chạy khác nhau nên cứ chốt theo số đo.
`APP_LCD_READ_HZ` để **4 MHz**: sau đó `0xD3` đúng **30.198/30.200**, `0x0A` 30.199/30.200,
`0x0F` 30.200/30.200. Đây cũng là lý do `SCANLINE_RETRIES` phải bằng 4 — khoá pha đi qua đúng
đường đọc ấy, và nó đã chạy suốt với chưa tới nửa số lượt đọc là thật.

**Dao động nội của panel phẳng, nên nguồn không phải thủ phạm.** Bộ đếm dòng chạy bằng dao động
nội của ST7796S mà tần số dao động thì ăn theo điện áp, nên bấm giờ chu kỳ khung là đo gián tiếp
được nguồn — và phép này không cần giải mã bit nào, chỉ cần thấy bộ đếm vòng về 0. Đo 200 khung
mỗi nền, bỏ các lượt lỡ nhịp do task bị chen: nền trắng **42.566 µs**, dao động **91 µs (0,21 %)**;
nền đen **42.876 µs**, dao động **119 µs (0,28 %)**. Nếu rail sụt rồi hồi theo một nhịp mắt nhìn
thấy được thì chu kỳ khung phải nhảy theo đúng nhịp ấy. Nó phẳng tới 0,2 %. Cộng với `BSTON` và
`RDDSDR` đứng yên, **ba phép đọc độc lập đều nói nguồn không bị điều biến**. Chênh 0,73 % giữa
trắng và đen là ổn định và ngược chiều với giả thuyết sụt áp (trắng **nhanh** hơn), nên nó không
phải cơ chế nhấp nháy.

Phép thử cuối là phép quyết định: nền trắng tĩnh, **không một byte nào đi trên SPI**, đèn nền là
một mức **DC phẳng không băm xung** — mà vẫn nhấp nháy. Ở trạng thái đó **không còn thứ gì trong
firmware đang điều biến cái gì cả**. Nên nguyên nhân nằm ngoài phần mềm, và mọi thanh ghi phía
trên đều là chữa nhầm bệnh.

**Chốt 19/09: nhấp nháy là của đèn nền, không phải của tấm kính.** Cho panel ngủ hẳn bằng
`DISPOFF` + `SLPIN` mà vẫn giữ chân đèn nền ở mức cao, không băm xung. `RDDPM` đọc về xác nhận
panel đã xuống thật: `BSTON = 0` bơm điện tích tắt, `SLPOUT = 0`, `DISON = 0`. Tấm này là loại
**normally white** nên cắt hết điện lái thì kính trong suốt và màn sáng trắng — trong module lúc
ấy **chỉ còn dãy LED hoạt động**. Chủ repo nhìn: **vẫn nháy**. Vậy mọi thanh ghi của ST7796S đều
vô can, và cả vùng đã loại ở bảng trên là loại đúng nhưng loại nhầm hệ thống.

**Vì sao đi lạc cả ngày.** Quan sát "nền trắng nháy, màn `Menu` tối thì đỡ" đã bị dùng làm bằng
chứng rằng nội dung màn hình dính líu, tức là phía kính. Nó không chứng minh được điều đó: đèn
nền sáng như nhau ở cả hai nền, chỉ có lớp kính chắn bớt. Đèn nền phập phồng 5 % thì nền trắng
cho lọt ~100 % và mắt thấy đủ 5 %, nền tối cho lọt ~10 % và mắt thấy 0,5 %. **Một lỗi đèn nền và
một lỗi kính nhìn từ ngoài giống hệt nhau qua phép so đó.**

**Và vì sao panel đo ra sạch.** ST7796S tự ổn áp các rail của nó bằng bơm điện tích nội, nên
gợn trên `VCC` không lọt vào `BSTON`, `RDDSDR` hay dao động nội. Dãy LED thì **không có gì ổn áp
cả** — nó mắc qua điện trở, nên độ sáng bám thẳng theo `VCC`. Hai hệ thống dùng chung một chân
nguồn nhưng một bên miễn nhiễm còn một bên thì không, và đó là lý do ba phép đọc trong chip đều
phẳng trong khi mắt vẫn thấy nháy.

**Vùng còn lại đúng bằng đường đèn nền:** GPIO21 → chân `LED` của module → `Q1` với `R4`/`R5` →
dãy LED → đất, cộng với `VCC` nuôi dãy ấy.

**Nghiệm thu trên bàn 19/09: đổi `VCC` sang một nguồn khác thì hết nháy.** Chủ repo cấp 5 V lấy
ở chân khác của devkit — tức vẫn cùng cổng USB và cùng đất, chỉ khác chỗ là nó **không đi qua con
ổn áp 3,3 V đang nuôi lõi với PSRAM**. Nền tĩnh thì sạch hẳn. Chạy full app thì nháy quay lại,
vì lúc đó camera, Wi-Fi và ba model kéo `VBUS` lẫn đất cùng lắc. Hai quan sát ấy chốt cơ chế:
**gợn trên rail nuôi dãy LED**, không phải tấm kính. Board đế vì thế đổi theo §2.5 luật 8 — rail
`+3V3_LCD` riêng do `U2` cấp, đất tấm màn đóng lại ngay tại chân đất `U2`.

**Chỗ phải soi tiếp là điện, theo thứ tự này:**

1. **Chân `BLK` có đi qua MOSFET không, hay nối thẳng vào GPIO21?** §2.3A đã viết sẵn điều kiện:
   *"nếu backlight > 40 mA → qua MOSFET N (AO3400)"*. Nối thẳng thì chính chân ESP là nguồn dòng
   cho dãy LED, và nó sụt áp — nháy ở **mọi** mức duty, kể cả DC, đúng như đo được.
2. **Đường nguồn và đất của module.** `TASKS.md` E7-T16 đã ghi bench này **phạm luật 1, 2 và 3 của
   bảng mass §2.5**. Cấp riêng cho module và cho đất về thẳng domino.
3. **Tụ lọc ngay tại module — đã có và đã loại.** §2.5 bắt sẵn **100 µF gần LCD**, bench đã cắm,
   và vẫn nháy. Nên tụ trữ không phải chỗ thiếu.
4. **Đuôi cáp.** Cùng ngày đã một lần gây nửa panel tối hơn nửa kia. Độ phân giải, số màu và fps của ảnh **không đổi** — 23,26 Hz là nhịp
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

**Quét cả bus với đủ thiết bị, 12/09** — `bsp_board/test_apps/buses`, 7/7 case PASS ở 400 kHz:

| Địa chỉ | Ai |
|---|---|
| `0x14` | GT911 — **không phải `0x5D`**, xem dưới |
| `0x20` | PCF8574 |
| `0x29` | VL53L1X |
| `0x57` | AT24C32 trên module RTC, không dùng |
| `0x68` | DS3231 |

Đúng năm con phải có và không con nào thừa, nên **SDA không bị chập** — nếu chập thì mọi địa
chỉ đều "trả lời" và phép đếm của test bắt được. Trở treo 4,7 kΩ đủ cho sườn lên ở 400 kHz với
cả năm con trên dây breadboard, mà dây breadboard dài hơn đồng trên board đế nhiều.

GT911 trả lời ở **`0x14`** chứ không phải `0x5D` mặc định: app này không chạy trình tự reset của
`drv_touch`, nên địa chỉ do cuộc đua lúc cấp nguồn quyết định — đúng như cảnh báo ở §2.3C. Đây là
bằng chứng đo được rằng trình tự đó bắt buộc, không phải tuỳ chọn.

Log ghi `i2c ready after 0 ms` vì đây là **reset**, ngoại vi vẫn đang có điện từ trước. Mốc 5 ms
và 17 ms ở bảng trên chỉ hiện ra lúc **cấp nguồn lần đầu** (§2.3B).

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
| VIN | **3V3** | Breakout có LDO nên *bản thân nó* chạy được 3,3–5 V, nhưng **đừng nuôi 5 V**: chưa biết trở treo I2C của breakout bám vào `VIN` hay bám vào ngõ ra LDO. Bám `VIN` thì nuôi 5 V là kéo cả bus lên 5 V — đúng cái bẫy §2.3H đã cấm với DS3231. Muốn đổi thì soi mạch breakout trước |
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

**Chữ in lụa: cao 0,8 mm, nét 0,15 mm** — đúng hai mức sàn mà xưởng công bố (JLCPCB: rộng nét
≥ 0,15, cao ≥ 0,8). Nét đúng tỉ lệ với cỡ chữ 0,8 là 0,12, và 0,12 vẫn in ra trên dây chuyền bây
giờ — nhưng nó nằm **dưới** mức hãng cam kết, nghĩa là họ được quyền in mờ hoặc bỏ hẳn mà không
báo. Cả bộ in lụa này tồn tại để cắm module khỏi phải tra bảng, nên mất chữ là mất hết công; đổi
lấy chữ đậm hơn một chút là đổi có lãi. Đường bao thân linh kiện vẫn giữ **0,12** của thư viện
KiCad: đó là nét thẳng dài, in bao giờ cũng ra, mà sửa nó thì dấu chân lệch khỏi thư viện và DRC
dựng lại cả loạt cảnh báo `lib_footprint_mismatch`.

**Ba khe quanh tấm màn để bằng nhau: 7,3 mm.** Tấm màn cách devkit, cách khung PCF8574 và cách
khung MAX98357A đúng một khoảng. Con số 7,3 không chọn cho đẹp mà do **thân tụ `C4` chặn**: nó
6,3 mm và nằm trong khe bên trái, nên khe không hẹp hơn được. Cân bằng bằng cách đẩy tấm màn
sang trái 1,46 mm và cả cụm bên phải sang phải 1,85 mm — chia đôi đơn thuần thì ra 6,38 mm và
con tụ chỉ còn hở 0,04 mm mỗi bên.

**Board đế có lỗ bắt của riêng nó — `H5`…`H9`, năm lỗ M3.** Bốn lỗ `H1`…`H4` giữ *tấm màn vào
board*, không giữ *board vào cái gì*. Thiếu chúng thì cả cụm màn cộng board treo lơ lửng trong
vỏ, mà hai con domino lại là chỗ người ta vặn vít siết dây vào — lực đó phải có chỗ truyền xuống.

Bốn lỗ **đúng bốn góc**, cách mép board 5 mm. Hai góc vốn bị chiếm — góc trên trái có thân con
ToF, góc dưới phải có hai con domino — nên **con ToF dịch phải 2 mm và hai domino dịch lên 2 mm**
để nhường chỗ. Dịch linh kiện rẻ hơn là bỏ góc: lỗ bắt nằm giữa mép thì board vẫn vênh được ở
góc, mà góc lại đúng chỗ vỏ máy đỡ.

Cùng cỡ **M3 Ø3,2** với lỗ bắt màn, nên cả board chỉ dùng một cỡ vít.

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

Tụ: 1000 µF gần jack 5 V, 470 µF gần MAX98357A, 470 µF gần chân nguồn servo, 470 µF ở đầu vào
`U2`, 100 µF ở đầu ra `U2` ngay sát tấm màn.

**Tấm màn không ăn thẳng `+3V3` của devkit nữa.** Rail riêng `+3V3_LCD` do `U2` — một module ổn
áp 3,3 V ba chân cắm đế — lấy từ `+5V_R1` mà ra, và chỉ nuôi đúng `J3.1`. Ba cảm biến I2C với
trở treo `R1` vẫn ở `+3V3` của devkit. `U2` tiêu tán `(5 − 3,3) × 0,1 A ≈ 0,17 W`, không cần tản.

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

#### Đường dương — cùng một vấn đề, và năm luật trên không phủ

Năm luật trên đều nói về mass. Nhưng đồng có điện trở ở **cả hai chiều**: nếu 600 mA của amp
chạy qua đoạn đồng mà devkit đang lấy điện, nó kéo sụt đúng chỗ ESP32 ăn. Về sơ đồ thì `J10`,
`U1.5V` và `J7.VIN` cùng một net nên nối kiểu gì cũng "đúng"; về vật lý thì không.

| # | Luật | Hỏng thế nào nếu bỏ |
|---|---|---|
| 6 | Mỗi tải nặng đi **thẳng** từ domino của nó, không mượn nhánh của tải khác. `J10 → U1` và `J10 → J7` là **hai nhánh song song**, không bao giờ là `J10 → U1 → J7` | Nối chuỗi là dòng đỉnh của amp chạy qua đoạn đồng của devkit — tái hiện đúng cú brownout đã đo ở §2.3E, lần này trên board in |
| 7 | Tụ trữ bám vào **chân tải**, không bám vào domino: `C2` treo trên `J7.VIN`, `C3` trên `J9.VCC` | Bám domino là tụ nạp cho cả rail thay vì cho riêng tải, mất tác dụng của luật 3 |

#### Tải nhìn thấy được — hai luật rút ra từ vụ nhấp nháy 19/09

Bảy luật trên bảo vệ thứ **nghe được** (amp) và thứ **đo được** (sụt áp devkit). Dãy LED đèn nền
là loại thứ ba: nó **nhìn thấy được**, và nó không có gì ổn áp — độ sáng bám thẳng theo hiệu điện
thế đặt lên nó. Một gợn 1 % trên rail là 1 % độ sáng, mà mắt người thấy được mức đó.

| # | Luật | Hỏng thế nào nếu bỏ |
|---|---|---|
| 8 | Tải **không tự ổn áp mà mắt nhìn thấy được** phải có **ổn áp riêng**, và chân đất của ổn áp phải là **cùng một nút cục bộ** với chân đất của tải. Không phải chỉ một nhánh đồng riêng | `LCD` ăn chung ngõ ra LDO của devkit với lõi 240 MHz và PSRAM 80 MHz: **đo 19/09, nhấp nháy thấy rõ trên nền trắng**, không thanh ghi nào của ST7796S chữa được vì lỗi không nằm ở tấm kính |
| 9 | Rail nuôi một module **dùng chung bus với ESP** phải là **3,3 V**. Trở treo của module lấy điện từ rail của chính nó | Cấp 5 V cho module màn thì trở treo `SCL` của nó kéo đường I2C vượt mức chân ESP chịu được: **đo 19/09, trượt SCL 0,76 % so với 0,10 %, p = 0,00001** |

Luật 8 giải thích luôn vì sao chỉ tách đường **dương** là không đủ: mốc đất của tải cũng lắc theo
dòng của tải khác, mà LDO giữ ngõ ra so với **chân đất của chính nó**, nên hễ đất của tải và đất
của ổn áp là một nút thì mọi dao động chung đẩy cả hai đầu đi cùng nhau và tải không thấy gì.
Trên board đế điều đó thành chuỗi `U1.40 → C5.2 → U2.2 → C4.2 → J3.2`: đất tấm màn đóng lại ở
chân đất `U2` chứ không đi tiếp.

**Luật 9 loại thẳng phương án nối `J3.1` vào `+5V_R1`**, dù module có khai là ăn được 5 V.

`U2` là tải **duy nhất** được phép mượn nhánh của tải khác (`U1.20 → U2.1`, tức luật 6 không áp).
Lý do là cơ chế của luật 6 không còn: nó ăn **100 mA đều đặn**, không có đỉnh để đẩy sang ai, còn
đỉnh 350 mA của devkit tới đầu vào `U2` thì rơi trên ~110 mm đồng 1,0 mm thành **18 mV**, và LDO
với biên dropout 1,7 V nuốt gọn. Đổi lại được đoạn 5 V ngắn thay vì kéo 115 mm cắt ngang board.

Hai luật này khai thẳng trong `hardware/gen/gen_pcb.py` ở `RAIL_TREE` — từng đoạn dây một, chứ
không để thuật toán tự tìm cây ngắn nhất. Cây ngắn nhất sẽ nối chuỗi, vì nối chuỗi thì ngắn hơn.

**Chân giữa của một hàng ba chỉ có hai lối ra.** `U2.2` bị `U2.1` và `U2.3` kẹp hai bên nên chỉ
đi lên hoặc đi xuống được; khai cho nó ba mối là router quay 8 lượt rip-up rồi bỏ cuộc. Chuỗi
đúng cho nó đúng một mối vào từ trên và một mối ra dưới. Cùng lý do, `C5` phải đặt **đứng** để
chân dương ra ngang còn chân âm ra dọc, chứ nằm ngang thì hai chân cùng một hướng và chân này
chắn chân kia.

⚠️ **Chân `5V` của devkit nối với VBUS của USB.** Chính phép đo ở §2.3E chứng minh: lúc lấy điện
cho amp từ chân đó thì đường USB của board rớt. Nghĩa là khi vừa cắm USB vừa vặn dây vào `J10`,
nguồn ngoài và cổng USB của máy tính **đấu song song**. Trên bàn thường không sao, nhưng nguồn
ngoài cao hơn 5 V rõ rệt thì nó đẩy ngược vào cổng USB. Ngoài thực địa không có USB nên không
gặp; chỉ là chuyện của bàn thử.

#### Đi dây — cái máy tìm đường, luật thì người khai

Board **2 lớp**. Đường nguồn **1,0 mm đi mặt sau**, tín hiệu **0,25 mm đi mặt trước**; đường nào bí
thì lật sang mặt kia, và chỗ lật là một **via**. Mọi chân đều xuyên lỗ nên một đường đi trọn vẹn ở
mặt sau vẫn tới được chân mà không tốn via nào.

**Via nguồn khoan to hơn via tín hiệu** — Ø0,6 so với Ø0,4. Theo IPC-2221 (1 oz, 10 °C), thành mạ
25 µm của lỗ Ø0,4 chỉ chịu **1,11 A**, mà via mass nặng nhất trên board gánh **0,91 A** (đường về
của devkit + màn + ba con I2C) — dư 18%, mỏng. Ø0,6 đưa lên **1,48 A**, dư 63%. Dây 1,0 mm thì chịu
**2,39 A** so với đỉnh 1,34 A của rail 1, không phải lo.

**Router giữ khe rộng hơn mức netclass đòi.** Netclass vẫn là 0,2 mm cho tín hiệu và 0,3 mm cho
nguồn — DRC chấm theo đúng đó — nhưng router đi với 0,25 và 0,35, nên nó tự tránh những lối chỉ
vừa khít. Kết quả: khe đồng hẹp nhất toàn board **0,255 mm** thay vì 0,215, không còn cặp nào dưới
0,25 mm, và lại còn **ít via hơn** (46 thay vì 53) vì đường đi đơn giản hơn. Đi sát đúng mức tối
thiểu thì DRC vẫn qua, nhưng không còn chỗ nào cho sai số ăn mòn của xưởng.

**Không đồng nào trong bán kính 3,5 mm quanh tám lỗ vít.** Luật này không phải luật điện, nên DRC
không bao giờ bắt: khoảng cách đồng tới **mép lỗ** thì DRC chấm, còn thứ đè lên mặt board là **đầu
vít và trụ đồng**, rộng hơn lỗ nhiều. Vít M3 pan head Ø5,6; trụ lục giác M3 Ø5,2–5,8; long đen M3
Ø7,0 — lấy cái to nhất, vùng cấm là **Ø7,0, tức bán kính 3,5 mm, cả hai mặt**, chặn cả dây lẫn via.

Trước khi có luật này router chỉ tránh lỗ đúng bằng khoảng cách netclass — 1,97 mm tính từ tâm — nên
đồng chui vào đúng chỗ kim loại sẽ đè, chỉ còn lớp sơn phủ ~20 µm ngăn. Ba chỗ đã thành bẫy thật:
`H1` và `H2` có `I2C_SCL` mặt trước với `GND` mặt sau dưới **cùng một con vít** (nứt sơn là chết cả
bus I2C), `H4` có `+3V3` **và** `GND` cùng nằm mặt sau dưới một đầu vít — chập thẳng nguồn. Giá của
vùng cấm: **5 đoạn dây**, 0 via, khe đồng hẹp nhất không đổi.

**Mọi via đều bịt mask cả hai mặt.** Sơn phủ kín vành đồng quanh via — lỗ vẫn khoan, thành vẫn mạ,
vẫn dẫn giữa hai mặt, chỉ là không còn đồng trần. Được ba thứ: module đứng bên trên không thể chạm
vào via nằm dưới nó, in lụa in đè lên được (xưởng gọt in lụa khỏi chỗ đồng trần, nên tên chân in
qua via là mất chữ), và không có đồng trần nào để oxy hoá. Mất một thứ: không chọc que đồng hồ vào
via đo được nữa — board này via không phải điểm đo nên không mất gì. Ngoài ra router vẫn chặn sẵn
không đặt via dưới chữ, và `check_pcb` kiểm lại.

**Bảy luật trên không phải là thứ máy tự tìm ra được.** Router đi theo cây khai sẵn trong
`RAIL_TREE` của `hardware/gen/gen_pcb.py` — từng nhánh một — và **các nhánh của cùng một cây chặn
lẫn nhau** lúc tìm đường, nên hai tải không bao giờ dùng chung đoạn đồng mà luật 6 cấm. Mass tách
làm hai net rời (`GND@1`, `GND@2`) chặn nhau y hệt, rồi nối lại bằng đúng một đoạn `GND@tie` giữa
hai domino — đó là luật 1, thành ra đúng nghĩa đen chứ không còn là lời dặn.

Một chân bị hai chân khác kẹp trong hàng thì **chỉ còn hai lối ra**, nên không chân nào ở chỗ chật
được phép đẻ quá hai nhánh. Cây mass xếp lại theo đúng ràng buộc đó: bốn nhánh rời `J10.2` (chỗ
rộng), còn các chân trong hàng thì nối chuỗi hai một.

**Điểm sao của rail 1 là chân domino cộng chân tụ `C1`**, không phải riêng chân domino. `C1` cố ý
nằm chồng lên hai chân của `J10` (đoạn trên), nên tải rẽ nhánh ngay tại chân tụ — đoạn đồng dùng
chung chỉ còn 5 mm giữa domino và tụ, mà rẽ ngay tại tụ trữ mới đúng là chỗ nên rẽ.

`tools/check_pcb.py` đọc lớp đồng đã vẽ rồi kiểm lại luật 1, 2, 6, 7 bằng cách **cắt chân ra khỏi
đồng và xem cái gì còn dính nhau**. Cần thiết vì **DRC của KiCad không thấy được mấy luật này**:
board nối chuỗi `J10 → U1 → J7` vẫn cho DRC 0 vi phạm, chỉ `check_pcb` bắt.

Luật 5 là luật **đi dây trong vỏ máy**, không phải luật PCB: loa đấu thẳng vào domino của
chính module MAX98357A, nên `OUT+` và `OUT−` không có net nào trên board đế và board đế
không mang đầu nối loa (§2.3E). `OUT−` **không bao giờ** nối xuống GND — kể cả khi bắt vít
loa vào khung máy.

#### Hai cổng USB nạp điện — `J15`…`J18`

Ngoài hai domino, board đế có **hai chỗ hàn breakout USB** để cấp 5 V lúc thử trên bàn. Mỗi chỗ
là hai phần rời nhau:

| Ref | Là gì | Lỗ |
|---|---|---|
| `J15` | Lưới hàn giữ breakout **USB-C** | **20 lỗ** Ø1,0, lưới 4 × 5 bước 2,54 — **không lỗ nào mang net** |
| `J16` | Hai lỗ nguồn của cổng USB-C | `+5V_R1` và `GND` |
| `J17` | Lưới hàn giữ breakout **micro-USB** | 20 lỗ Ø1,0, lưới 4 × 5 bước 2,54 — không lỗ nào mang net |
| `J18` | Hai lỗ nguồn của cổng micro-USB | `+5V_R2` và `GND` |

**Lưới hàn chứ không phải hàng chân.** Breakout USB bán ngoài không theo chuẩn chân nào: micro-USB
thường 5 chân (`VBUS D− D+ ID GND`), USB-C có loại 2, 6 và 16 chân, `VBUS` với `GND` khi thì cạnh
nhau khi thì ở hai đầu. Đặt sẵn một hàng lỗ là cược rằng chân của nó rơi đúng chỗ đó — cược cả về
số chân lẫn về việc hàng chân nằm cách mép module bao nhiêu, mà cả hai số đều chưa ai đo.

Lưới 2,54 thì không phải cược: **lỗ và chân cùng một bước, nên trượt module tới đâu cũng có lúc cả
hàng chân rơi trọn vào lỗ.** Đẩy cho trùng rồi hàn, thừa lỗ thì bỏ trống. Đổi sang con breakout
khác sau này cũng không phải sửa board.

`J15` và `J17` **không có trên sơ đồ nguyên lý**: chúng không mang một net nào, đúng như bốn lỗ vít
`H5`…`H8`. Điện đi riêng — hai sợi dây ngắn từ `VBUS` và `GND` của breakout lên `J16`/`J18` ngay
phía trên, và hai lỗ đó đã có đồng nối thẳng về domino.

**USB-C gánh rail 1, micro-USB gánh rail 2.** Đầu C chịu 3 A nên đỡ được đỉnh 1,34 A của rail 1;
đầu micro-B chỉ chịu 1,8 A và tiếp xúc yếu hơn hẳn, nên chỉ giao cho đỉnh 0,7 A của servo. Làm
ngược lại là dựng sẵn đúng cú sụt áp đã đo ở §2.3E, lần này ngay tại đầu cắm.

⚠️ **Cắm USB lúc đang vặn dây vào domino là đấu song song hai nguồn** — cùng cái bẫy mà cảnh báo
ngay trên đã nói cho chân `5V` của devkit, giờ thêm hai đường nữa. Board không chặn được bằng
đồng: muốn chặn phải thêm diode Schottky, mà mỗi con sụt 0,3–0,4 V trên một rail 5 V vốn không dư
(ESP32 brownout quanh 4,5 V). **Mỗi lúc chỉ một đường vào.**

⚠️ **Breakout USB-C thiếu hai con 5,1 kΩ ở `CC1`/`CC2` thì sạc USB-C không ra một vôn nào.** Đó là
cách nguồn USB-C nhận biết có thiết bị; loại 2 chân rẻ nhất hay bỏ hai con này. Soi trước khi
mua — board không sửa được chuyện đó.

**Khung thân 13 × 15 mm mỗi con.** Hai con nằm cạnh nhau ở mép dưới, cùng quay đầu cắm ra ngoài —
chung mép với hai domino, để dây nguồn vào từ một phía. Ô chứa chúng rộng **31 mm**, chặn trái
bởi khung tấm màn và chặn phải bởi `J10`; để đủ chỗ thì **`C1` `J10` `J11` đã dịch sang phải
3 mm**, đúng một phép tịnh tiến nên mọi khoảng cách trong luật 1–7 giữ nguyên.

Cả hai con đo **chưa tới 10 mm** bề ngang, bằng nhau, nên mỗi khung 13 mm còn dư hơn 3 mm. Khung
vẽ rộng hơn thân là cố ý: nó là chỗ cấm đặt linh kiện khác, không phải bản vẽ của con breakout.

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
| Chọn op thân thiện INT8 | Thay SiLU/HardSwish/GELU/**PReLU** → **ReLU6** hoặc **ReLU**. Sigmoid trong khối SE → **HardSigmoid dạng ReLU6(x+3)/6** khi tự train. **Trọng số nhập có SE** thì giữ Sigmoid gốc: `LOGISTIC` và `MEAN` chạy kernel tham chiếu trên vector đã gộp về 1×1, ba khối tốn **46 ms** đo trên board (`latency.md` §11), đổi HardSigmoid là đổi hàm đã học | cả 3 |
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
| anti-spoof | `ReLU` qua config, `conv1` giữ PReLU dưới dạng **stem tách** hai nhánh ReLU + ADD | **Không chạy CLE** — đo 12/09 cho thấy nó làm EER sau INT8 tăng 53% (`measurements/antispoof` §32). `ReLU` vẫn giữ vì nó không tốn gì so với `ReLU6` và để ngỏ đường bật lại CLE nếu kiến trúc đổi. Khối SE của trọng số nhập giữ **Sigmoid** gốc (`LOGISTIC` tham chiếu, xem lớp 1); student tự train dùng `HardSigmoid` `ReLU6(x+3)/6` |
| recognition | `ReLU` qua config | Chạy CLE — `ReLU6` chỉ giữ được 15/48 cặp conv, `ReLU` giữ đủ 48/48 |

### Lớp 2 — Huấn luyện

**Detect và recognition train từ khởi tạo ngẫu nhiên trên nhãn thật, không có teacher**
(`docs/adr/0002-bo-knowledge-distillation.md`). **Nhánh chống giả distill từ trọng số nhập**
(`docs/adr/0003-distill-chong-gia-tu-trong-so-nhap.md`): mọi student train trên nhãn pool đều
chặn oan mặt thật của OV5640 vì nhãn CelebA-Spoof dạy phong cách ảnh, còn trọng số minivision
giữ trọn 62/62; teacher ấy tốt hơn mọi student nên có thứ để distill, và không dùng nhãn thì
confound không đi theo.

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

`minifasnet_v2_se` nhận thêm `views: wide`: một backbone width 32 đọc **riêng** view ngữ cảnh 2,7×
của shard, 81×81 (lẻ, không PAD), ba lớp `[sống, phát lại, in]`. Nó được **distill** từ run nhập
(ADR-0003), không train trên nhãn: `configs/antispoof/minifasnet_distill.yaml` đặt
`loss.name: antispoof_distill`, `loss.teacher_run` trỏ run `20260916-0728_f20a94a_ec4799` (PReLU
gốc, float, host), `loss.temperature`; `train.py` nạp teacher đóng băng, thu view về 80×80 cho nó
và đưa logit của nó vào `SpoofBatch.teacher_logits`; `losses/distill_loss.py` tính KL·T². Ảnh
của cả pool là đầu vào, nhãn không đọc. Augment theo view wide: `crop_scale_range` 1,2–2,7 với
xác suất 0,5 vì board kẹp khung khi mặt gần, `occlusion` nhẹ (0,15; 10–25% cạnh) để không che
mất vành ngữ cảnh, `chroma: false`, và **`photometric_probability: 0`**: đo trên chính pipeline
train, khối nhiễu/mờ/phơi sáng làm teacher gọi 59% mặt thật là giả so với 20% trên ảnh sạch,
trong khi năm augment còn lại không đổi phán quyết của nó (`measurements.md` §41.10); distill
là học hàm của teacher trên miền cần dùng, không phải dạy nó "mờ là giả".

`train_split` chọn theo **dải crop**, không theo tỉ lệ tấn công, vì nhãn không đọc. `fitted()` kẹp ô
vuông vào khung nên scale đạt được phụ thuộc cỡ mặt: trên board mặt thật đứng ở 2,0–2,7× còn khung
giả ở 0,8–1,7×. Chỉ CelebA có ảnh đủ rộng (39% mẫu ≥ 2,0×), các nguồn khác đã là crop mặt sẵn nên
không bao giờ vượt 1,4×; mà loader cấp một slot luồng mỗi thư mục nên split 16 slot pha loãng CelebA
còn 1/16 và chỉ phủ 13% dải mặt thật của board. `CelebA ×6 + unique_live + unique_replay` đưa con số
ấy lên 28%, trần của pool là 29% (`measurements.md` §41.10).

Và scale phải **phủ đều cả dải**, không chỉ một góc: board chạy 0,76–2,69× tuỳ cự ly người đứng.
`crop_scale` cũ bốc đều trên dải rồi kẹp, nên ảnh rộng dồn về trần của nó và sàn 1,2 không chạm dải
khung giả; `SpoofShardDataset.scale_target()` bốc trong đúng khoảng từng ảnh có với số mũ
`crop_scale_bias`, và `[0,75; 2,7]` với `bias: 4` cho mọi ô rộng 0,3× đều có ≥ 6% mẫu. Lợi ích đo
được là student thấy **ảnh giả ở mọi cự ly**, kể cả dải xa mà 25 khung giả của board chưa có; thứ nó
**không** sửa được là lệch phân bố scale giữa hai lớp của chính bộ đo, việc ấy cần đòn tấn công chụp
ở xa. Chọn checkpoint bằng **KL trên val**, không bằng EER pool.
Nghiệm thu bằng bảng bốn dòng cùng thước 87 khung INT8 + tập lớn + `bench_ai`: teacher, bản
nhập stem tách, student distill, student cũ `0107`. Kết quả 16/09: student
`20260916-1109` giữ **62/62**, chặn **25/25**, khe 49 nấc INT8 so với 53 của bản nhập, chạy
**234 ms thay vì 535** và dùng **423 KB arena thay vì 744**, bộ op toàn esp-nn không PAD
(ADR-0003, `measurements.md` §42). Chỗ nó thua là ảnh in, và phép lọc thông thấp chốt nguyên nhân là
trần năng lực của width 32 chứ không phải dữ liệu hay hiệu chuẩn. **Thử trực tiếp 17/09 trên board,
student cho qua mọi đòn giấy** — tờ tiền, ảnh in, thẻ — trong khi bản nhập chặn 15/15 lượt
(`measurements.md` §43); bộ 25 khung giả của board toàn đòn màn hình nên 25/25 chưa từng đo giấy.
Vì thế student **rời `models.lock.json`** và giữ vai phương án nhẹ; model nhánh là **V1SE nhập**
(mục dưới, ADR-0004).

Đường xuất của nhánh có một bước **căn bias** tuỳ chọn: `eval.py --calibrate-live-bias` cộng một
hằng số vào logit lớp sống rồi gấp vào bias của lớp phân loại (`classifier.bias` hay `prob.bias`,
model nhập cần `prob_bias: true`), giữ bản gốc ở `ckpt/best.uncalibrated.pth`. Phép cộng hằng số
không đổi thứ tự nên không khung nào đổi phán quyết và khe logit giữ nguyên; nó chỉ dịch điểm vận
hành về giữa cửa sổ của **bộ căn**. Vì thế bộ căn quyết định tất cả: nó phải gồm đúng những khung
kiosk sẽ chấm (qua `square_fits` và `face_min_px`) và phía giả phải có đòn khó nhất định chống. Bộ
87 khung hiện có chỉ có màn hình kề ống kính ở phía giả, nên hằng số nó sinh ra đẩy tờ tiền lên trên
0,5 (`measurements.md` §43.7); student cần căn (cửa sổ 19‰ trước, 320‰ sau), V1SE **không** căn (hằng
số 0) vì 500‰ đã nằm giữa tiền và mặt thật ở thang gốc. `live_min` gieo **500‰** cho mọi đời model.

#### Trọng số nhập từ Silent-Face-Anti-Spoofing, đọc crop ngữ cảnh 2,7×

Port `minifasnet_v2` dựng cả hai kiến trúc minivision-ai theo tên bảng kênh: `keep: 1.8M_` là
MiniFASNetV2 (không SE, trọng số `2.7_80x80_MiniFASNetV2.pth`, sha256 bắt đầu `a5eb02e1843f19b5`),
`keep: 1.8M` cộng `squeeze_excite: true` là **MiniFASNetV1SE** (trọng số
`4_0_0_80x80_MiniFASNetV1SE.pth`, sha256 bắt đầu `84ee1d37d96894d5`), cả hai Apache-2.0 từ kho
Silent-Face-Anti-Spoofing; `import_minifasnet.py --source` còn nhận trọng số facenox (MiniFASNetV2-SE
128 px, CelebA-Spoof) để đối chứng. Chúng **không train trên pool của dự án**; giá trị nằm đúng ở đó.
**V1SE là model trên `models.lock.json`** từ 18/09 (ADR-0004): cùng 87 khung và cùng đường tối ưu,
nó giữ khe INT8 +0,559 so với +0,365 của V2, chặn ảnh in cỡ vừa 12/12 nơi V2 sau đổi ReLU còn 0–1/12,
và chỉ tốn thêm 46 ms cho ba khối SE (`measurements/antispoof` §43.4–43.5). Phần dưới đây viết cho
V2 lúc nhập lần đầu; phép tách stem, gấp tiền xử lý và bộ op áp y nguyên cho V1SE, thêm `LOGISTIC`
×3 và `MEAN` ×3 của SE.

**Vì sao 2,7× đúng với model này mà sai với model train trên CelebA (§22).** §22 đo model
train trên CelebA-Spoof, nơi mặt thật là ảnh sự kiện studio còn mặt giả là người cầm ảnh
trong phòng thường: "phòng thường" trở thành nhãn, và view ngữ cảnh học đúng đường tắt ấy.
Kết luận đó là về **dữ liệu train**, không phải về ngữ cảnh. Trọng số minivision train trên
bộ riêng không mang confound này. Đo trên 85 khung OV5640 (64 thật, 21 giả, 6 phiên, gồm cả
nền cửa gỗ của §22), cắt bằng chính `fitted()` của firmware ở 2,7× và lấy mẫu lại trung bình
vùng như board:

| kích hoạt | AUC | p5 thật − p95 giả | bắt giả ở 3 thật bị chặn | thật bị loại khi chặn hết giả |
|---|---|---|---|---|
| PReLU (gốc) | **1,0000** | **+0,468** | 21/21 | **0/64** |
| ReLU (thay) | 0,9978 | +0,200 | 21/21 | 3/64 |
| **ReLU, `stem: split_prelu`**, INT8 trên 87 khung | **1,0000** | **+0,368** | 25/25 | **0/62** |

Cùng model ở crop 1,0× của mục trên: AUC 0,9241, khe −0,041, 21/64 thật bị loại. Tín hiệu
nằm ở vành ngữ cảnh — viền máy, tay cầm, mép màn — không ở da mặt.

**Ba khác biệt tiền xử lý gấp vào trọng số, không viết vào code chạy.** Upstream đọc BGR
thang 0–255 và xuất `[in, sống, phát lại]`; `import_minifasnet.py` đảo trục kênh vào và nhân
255 vào `conv1` để model nhận RGB thang `[0,1]` đúng như `to_tensor` và `Quantizer(0, 255)`
sẵn có, và hoán vị hàng của `prob` thành `[sống, phát lại, in]` để `LIVE = 0` giữ nguyên ở
cả `ml/` lẫn `kLive` của firmware. Nhãn 1 của pool rơi vào lớp phát lại, đúng đòn của bộ này.

**Bộ op, đối chiếu với §3 lớp 1.** Đồ thị gốc mang `PRelu ×33`, `PAD ×4` và một chuỗi flatten
động `Shape→Gather→Concat→Reshape`. PReLU bị §3 cấm và `latency.md` đo tốn 37–49% thời gian;
`activation: relu` trong config bỏ nó. Chuỗi flatten thay bằng `Reshape` tĩnh, batch ghim 1.
`PAD ×4` **giữ lại**: map 80→40→20→10→5 chẵn ở mọi stride-2, mà `conv_6_dw` là kernel 5×5 trên
map 5×5 nên đổi 80→81 là đổi hình dạng trọng số. Resolver antispoof đăng ký thêm `PAD`; bốn PAD đo trên board tốn 33 ms, 6,7% thời gian spoof (`latency.md` §9).

**Ba mặt thật ReLU đánh mất nằm ở một lớp.** Đổi từng lớp PReLU sang ReLU một mình trên 87 khung
board: 32 lớp không làm rơi mặt nào, riêng `conv1` (hệ số trung vị |a| 0,133, max 0,587, 66% âm)
làm rơi 8/62; giữ PReLU đúng ở `conv1` và ReLU 32 lớp còn lại giữ **0/62**, khe +0,423. Vì
PReLU(t) = ReLU(t) − a·ReLU(−t) và lớp kế tiếp `conv2_dw` là depthwise **tuyến tính theo kênh**,
hàm ấy viết lại **chính xác** bằng op esp-nn: `stem: split_prelu` dựng hai nhánh
`conv_pos = ReLU(BN₁(W·x))`, `conv_neg = ReLU(−BN₁(W·x))` (trọng số −W, BN đảo dấu), rồi
`act(BN₂(DW_w(conv_pos)) + DW_{−a·γ₂/σ₂·w}(conv_neg))` — thêm một `CONV_2D` 1,4 MMAC, một
`DEPTHWISE_CONV_2D` 0,5 MMAC và một `ADD`, không có `PRELU`. Importer gấp các hệ số vào trọng số
và kiểm parity với bản PReLU-ở-conv1 trước khi ghi run. Đây là đường lên `models.lock.json`
của nhánh; bản ReLU trơn giữ lại làm đối chứng.

**Hai run, một nút.** `import_minifasnet.py` viết run đúng cấu trúc §4.2 — `config.resolved.yaml`,
`split.lock`, `env.txt`, `ckpt/{best,last}.pth` ở định dạng checkpoint của `Trainer` — nên
`30_quantize.sh`, `update_lock.py` và `21_train_spoof.sh train.resume=` chạy như với mọi run.
Cờ `activation` cho ra hai run; latency và số đo INT8 trên board quyết định run nào lên
`models.lock.json`. Nếu ReLU giữ 3 mặt thật bị loại sau INT8 thì fine-tune ngắn từ chính
run ấy là bước kế tiếp, không phải train lại từ đầu.

**Ràng buộc §22 vẫn đứng nguyên cho `minifasnet_v2_se`**: model đó train trên pool này và
vẫn đọc 1,0×. Hai model, hai crop, cùng một `fitted()`; `kFaceScale` trong `preproc.cpp` đi theo
model đang nạp.

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

Nhánh tight đọc crop 1,0× và tách mặt thật khỏi bản in bằng **kết cấu bề mặt**: lỗ chân
lông, độ bóng của da, vân moiré của màn hình. Kết cấu là đại lượng cục bộ, không phụ thuộc
mức sáng chung của khung.

**Nhưng kết cấu không sống sót qua phép thu về 81×81, và dấu của nó đổi theo ống kính.**
Đo 13/09 trên ba miền (`measurements/antispoof` §38): năng lượng tần số cao cho AUC 0,86
trên khung OV5640 nhưng **0,10** trên `phone_eval` — màn hình chụp lại bằng camera điện
thoại sinh moiré nên tấn công *nhiều* tần số cao hơn mặt thật, còn qua ống kính mềm của
OV5640 thì tấn công *ít* hơn. Mọi đặc trưng kết cấu đo được đều đổi dấu như vậy, nên học
kết cấu là học đặc tính của một chuỗi ống kính. Và mặt 195 px của một bản sao lẫn mặt
150 px của người thật đều bị thu về 81×81 trước khi model nhìn: vi cấu trúc mà mắt người
dùng để phân biệt **đã mất trước lớp conv đầu tiên**.

**Thứ sống sót là màu.** Cùng phép quét ấy, `sat_mean` (độ bão hoà trung bình của crop) giữ
**cùng một dấu trên cả ba miền** — AUC 0,8548 trên chính phân bố train CelebA-Spoof, 1,0000
trên `phone_eval`, 0,9829 trên OV5640 — và `chroma_hp` cho 0,71 / 0,91 / 0,91. Cả hai là
thống kê **tần số thấp** nên phép thu nhỏ không xoá được. Lý do vật lý: một bản sao đi qua
**hai lần đường màu** — màn hình hoặc mực in, rồi cảm biến — và mỗi lần bóp dải màu, nên da
mất bão hoà. Đây là dấu hiệu nhánh tight phải dựa vào ở độ phân giải này, không phải kết cấu.

**Chuỗi augment bóp dấu hiệu ấy, nhưng nới nó ra thì hỏng.** `photometric` đổi `contrast`
trong 0,50–1,50 và cân bằng trắng từng kênh trong 0,86–1,16; đo trên 2.000 bản ghi val, AUC
của `sat_mean` tụt **0,8609 → 0,7185** sau augment. Thu hẹp hai dải ấy đã **chạy thử và bị
bác** (§39): AUC rơi ở **cả ba miền**, riêng `phone_eval` sập 0,9838 → 0,5353 với hai phần ba
nhóm mặt thật không qua nổi ngưỡng nào — dải rộng ấy **đang mua sự bền vững** chứ không chôn
dấu hiệu. Đường còn lại là **kênh sắc độ thứ tư**: ngoài R, G, B thì đầu vào mang thêm
`S = (max − min) / max` tính trên từng điểm, **sau** toàn bộ augment — model ở suy luận cũng
chỉ có ảnh cảm biến đã qua đường quang học của nó, nên train phải nhìn đúng thứ đó. Một mạng
tích chập **không tự tính được** `max` và `min` trên trục kênh: hai phép ấy phi tuyến theo
kênh, còn conv thì tuyến tính rồi mới ReLU, nên đại lượng này phải được **đưa vào**, không
phải được **hy vọng học ra**. Giá: `stem` nhận 4 kênh thay vì 3, tức thêm đúng một hàng trọng
số ở lớp đầu — arena không đổi, 234 ms không đổi, 81×81 không đổi; `ai_engine/src/antispoof/
preproc.cpp` ghi thêm một kênh vào tensor đầu vào cùng lúc nó ghi ba kênh kia. §39 bác việc
**nới lỏng augment**, không nói gì về việc **đưa thẳng đại lượng vào**, nên đây là hai phép
thử khác nhau. **Không** chốt độ
bão hoà thành cổng cứng: trên OV5640 hai lớp chồng ở 0,282–0,413 và biên chỉ 1,7%, nên cổng
ấy chặn đúng một tấm ảnh chứ không chặn được một loại tấn công (§38.3).

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

#### `backlight` mô phỏng nền, mà nhánh một backbone không nhìn thấy nền

Đo 14/09 trên 64 khung mặt thật của OV5640: lấy dải p5–p95 của bốn đại lượng (độ nét, bão hoà,
độ sáng, tương phản) làm đích, rồi hỏi **bao nhiêu phần trăm mẫu train rơi vào đúng dải ấy**.
Đây là độ **phủ**, không phải khoảng cách giữa hai trung vị — augment có nhiệm vụ nới rộng để
trùm lấy thiết bị, chứ không phải dời phân bố tới đó.

| Thao tác trong `photometric` | Phủ | So với tắt hết |
|---|---|---|
| tắt hết | 53,0% | — |
| nhoè chuyển động | **62,8%** | **+9,8** |
| vignette | **59,2%** | **+6,2** |
| cân bằng trắng | 52,8% | −0,3 |
| nhiễu cảm biến | 50,8% | −2,2 |
| tương phản | 46,0% | −7,0 |
| phơi sáng | 41,7% | −11,3 |
| **ánh ngược** | **33,3%** | **−19,7** |
| bật hết | 32,8% | −20,2 |
| **bật hết trừ ánh ngược** | **44,5%** | thu lại **11,7 điểm** |

**Cả chuỗi augment đang phủ thiết bị kém hơn là không augment gì** (43,5% so với 53,0% khi đo ở
mức cổng), và `backlight` một mình gánh hơn nửa khoản lỗ.

Lý do không nằm ở dải số mà ở chỗ nó mô phỏng sai vật: `backlight` kéo một bên khung **về phía
trắng** để giả cảnh ngược sáng, nhưng nhánh `views: tight` **chỉ nhìn crop khuôn mặt**, nơi
không có nền. Một cảnh ngược sáng thật làm **mặt tối đi** còn nền cháy trắng; ở đây nó đang bôi
trắng lên chính khuôn mặt. Số đo khớp với chẩn đoán: bão hoà rơi 51,3% → **9,0%**, độ sáng
53,3% → **16,3%**. **Tắt.** Con số −0,724 giữa nền cháy sáng và điểm vẫn đúng — nó đo trên
**khung đầy đủ**, và nếu muốn khai thác thì phải cho model nhìn thấy nền, không phải bôi trắng
lên mặt.

**Phơi sáng và tương phản thì giữ, dù cũng âm.** Đổi lấy độ phủ ở đây là mở lại một lỗi đã đo:
làm tối 15% kéo một khuôn mặt thật từ 0,9999 xuống **0,026**, và §39 đã đo rằng thu hẹp dải làm
AUC rơi ở **cả ba miền**. `vignette` thì tối bốn góc và nhân đúng 1,0 ở giữa khung — nơi khuôn
mặt nằm — nên nó không thay được `backlight`, mà cũng không cần thay.

#### Đích giám sát 6×6 ô: đã chạy, đã đo, **bị bác**

Mọi mục trên đây đổi **thứ model được ăn**. Mục này đổi **câu hỏi bắt nó trả lời**, và đó là
trục duy nhất chưa đụng tới sau khi 12 hướng phía dữ liệu đã bị số đo đóng lại
(`docs/thesis/nghien-cuu-chong-gia-mao-ov5640.md`).

Cross-entropy nhị phân hỏi model đúng **một** câu cho cả khung hình. Một câu duy nhất thì
trả lời được bằng **bố cục tổng thể** — chân dung chính diện, nền sạch, sáng đều — và đó
đúng là thứ model đang làm: ảnh thẻ hiển thị trên màn hình ăn **0,999**, trong khi mặt thật
thiếu sáng rớt xuống 0,135. Nó phân loại *phong cách ảnh*, không phân loại *bề mặt sống*.

**Bản đồ không gian vẫn còn nguyên, chỉ đang bị vứt đi.** Chuỗi hạ mẫu 81 → 41 → 21 → 11 → 6
để lại `head` xuất ra **6×6 × 256**, rồi `head_dw` — depthwise kernel 6×6 — bóp nó về một
điểm. Gắn thêm **một conv 1×1, 256 → 1** vào chính bản đồ ấy là có **36 quyết định độc lập**,
mỗi ô phủ ~13×13 điểm ảnh đầu vào. Không còn bố cục toàn cục nào để bám: từng mảnh bề mặt
phải tự đứng vững.

Hàm mục tiêu thành `L = CE(nhãn) + λ · BCE(bản đồ 6×6)`, nhãn bản đồ là hằng số theo lớp vì
crop **đã là** khuôn mặt — giá trị nằm ở chỗ ép tính cục bộ, không ở chỗ khoanh vùng.
Đây là dạng rẻ nhất của pixel-wise supervision; bản đồ độ sâu giả cần một bộ khớp 3DMM chạy
trên cả pool, còn bản đồ nhị phân thì không cần gì.

| | |
|---|---|
| Tham số thêm khi train | **257** |
| Tham số thêm trên board | **0** — đầu phụ bỏ lúc xuất, `head_dw` trở đi không đổi một byte |
| Arena, latency, 81×81 | không đổi |


#### Đích giám sát bản đồ độ sâu 21×21

Mục 6×6 phía trên bị bác, và lý do hỏng nằm ở **nhãn**, không ở ý tưởng. Nhãn bản đồ nhị phân
là **hằng số theo lớp**: mọi ô của mặt thật gán 1, mọi ô của ảnh giả gán 0. Nó lặp lại đúng
cái nhãn 36 lần mà không thêm một bit thông tin nào, nên model vẫn trả lời được bằng phong
cách ảnh — chỉ là phải trả lời 36 lần.

Bản đồ độ sâu đổi hẳn câu hỏi: mặt thật mang **hình khối 3D riêng của từng ảnh** (sống mũi
nhô, hốc mắt lõm, má lùi, đổi theo tư thế), ảnh giả là **mặt phẳng**. Model phải dựng lại
hình học từ một ảnh đơn.

**Đây là lý do nó đáng thử sau khi mọi hướng phía dữ liệu đã đóng:** hình khối 3D là **vật
lý**, không phải phong cách ảnh. Một khuôn mặt là 3D dù chụp bằng máy web của CelebA hay bằng
OV5640; một tấm kính là phẳng trong cả hai. Toàn bộ chẩn đoán ở
`docs/thesis/nghien-cuu-chong-gia-mao-ov5640.md` §14–15 là *model học phong cách, mà phong
cách pool ngược dấu với board* — đây là trục đầu tiên miễn nhiễm với chẩn đoán đó.

**Gắn ở tầng 21×21**, tức bản đồ sau `down_2`, chứ không ở 6×6: tài liệu FAS dùng 32×32, và
ở 6×6 thì hình khối của mọi khuôn mặt bóp lại gần như giống nhau — *giữa gần, rìa xa* — nên
nhãn lại thoái hoá về hằng số, đúng cái đã hỏng.

Hàm mục tiêu: `L = CE(nhãn) + λ · MSE(bản đồ 21×21)`.

Nhãn sinh **ngoại tuyến** bằng một bộ ước lượng độ sâu ONNX chạy trên crop của pool, phía
tấn công gán **toàn 0** theo quy ước. Chạy bằng `onnxruntime` đã khai trong `pyproject.toml`,
không thêm gói nào.

| | |
|---|---|
| Tham số thêm khi train | **conv 1×1, C → 1** ở tầng 21×21 |
| Tham số thêm trên board | **0** — đầu phụ bỏ lúc xuất |
| Arena, latency, 81×81 | không đổi |
| Cần dữ liệu thiết bị mới | không |

**Điều kiện đúng đắn của nhãn, và là rủi ro lớn nhất của mục này:** bản đồ độ sâu phải chịu
**đúng** mọi phép biến đổi hình học mà crop chịu — `roll`, `translate`, `crop_scale`,
`horizontal_flip`. Sai một phép thì nhãn lệch khỏi ảnh **trong im lặng**, không test nào bắt
được và số đo sẽ tệ mà không rõ vì sao. Chỉ `roll` đi qua cơ chế `views()`; ba phép còn lại
gọi thẳng tên trường nên phải sửa tay từng phép.

**Lỗ hổng không được đóng, phải ghi rõ:** nhãn phía tấn công vẫn là hằng số, nên model **vẫn
có thể** lách bằng phong cách — thấy phong cách pool-live thì xuất hình mặt, thấy phong cách
pool-spoof thì xuất 0. Thứ ngăn nó là phía mặt thật: 441 ô phải khớp một hình khối **cụ thể,
đổi theo từng ảnh**, không đoán bừa được. Đó là ép gián tiếp, không phải khoá chặt.

#### SSDG: ép mặt thật giống nhau giữa các miền, thả cho tấn công tách ra

Ba mảnh, tất cả chỉ sống lúc train và **biến mất khi xuất**: eval trả về đúng một tensor logit
như cũ, nên đồ thị INT8, arena và 81×81 không đổi một byte. Giá lúc train là **1.161 tham số**
(128 × 9 + 9).

1. **Đối kháng một phía.** Một đầu tuyến tính đoán *khung hình này từ nguồn nào*, nhưng chỉ
   được nuôi bằng **mẫu mặt thật**, và nối vào thân qua một lớp **đảo dấu gradient**. Thân vì
   thế học cách làm đầu ấy đoán sai — tức đặc trưng của mặt thật thôi mang dấu vết của camera
   đã chụp. Phía tấn công **không** bị ép như vậy: mỗi kiểu tấn công được phép khác nhau.
2. **Triplet bất đối xứng.** Gom nhãn lại: mọi mặt thật là **một lớp**, còn tấn công của mỗi
   miền là **lớp riêng**. Triplet trên nhãn ấy kéo mặt thật của mọi nguồn lại gần nhau, đẩy
   các kiểu tấn công ra xa nhau, và vẫn tách thật khỏi giả.
3. Đặc trưng chuẩn hoá về độ dài đơn vị trước khi tính khoảng cách.

**Nhưng nó chỉ chạy được nếu một batch mang nhiều miền, và ban đầu thì không.** Đo 14/09: mỗi
worker đọc **hết shard này mới sang shard khác**, mà một thư mục shard là một miền, nên batch
mang **1–2 miền** — đầu đối kháng không có gì để phân biệt và triplet không có cặp khác miền
nào. Bộ đệm xáo 2.048 mẫu không cứu được vì nó chỉ trộn quanh một ranh giới shard.

Sửa: đọc **xen kẽ 12 shard cùng lúc**, và chọn shard mở tiếp **theo miền chưa có mặt** chứ
không theo thứ tự — vì `unique_live`/`unique_replay` lặp năm lần trong split nên chọn theo thứ
tự sẽ để chúng chiếm trọn cửa sổ. Sau khi sửa: **2–6 miền mỗi batch**, không còn batch một miền.

Số miền **đếm từ chính split** lúc dựng model, không gõ vào config — đổi pool mà quên sửa thì
đầu phân biệt sẽ lệch kích thước trong im lặng.

**Cảnh báo giữ nguyên:** độ lệch đã đo được nằm giữa **pool và camera**, mà SSDG chỉ san phẳng
chênh lệch **giữa các miền có trong pool** — OV5640 không phải một trong số đó. Và phía mặt
thật chỉ có **4 trong 9** thư mục, nên đầu đối kháng thường chỉ thấy 2 miền mỗi batch. Đây là
một phép thử có cơ sở, không phải một lời giải đã biết trước.

**Bản ghi cũ về SSDG như bước hai:** Ý định ban đầu là làm sau nếu bước một đạt; bước một
trượt, nên nó không được kích hoạt. Giữ lại đây vì nó nhắm đúng chế độ hỏng vừa đo được: ép đặc
trưng **mặt thật** không phân biệt được giữa các miền, còn **tấn công** thì cho tách theo miền —
tức tối ưu thẳng cho một miền chưa từng thấy. Nhãn miền đã có sẵn trên shard từ `xdomain_crop.py`
(`synth_ipad`, `synth_samsung`, `unique_replay`…) nên không phải gắn lại. Giá: thêm lớp đảo
gradient và bộ lấy mẫu triplet bất đối xứng. ⚠️ Nhưng số đo ở trên cho thấy độ lệch nằm giữa
**pool và camera**, mà SSDG chỉ san phẳng được chênh lệch **giữa các miền có trong pool** —
OV5640 không phải một trong số đó. Nên đừng chạy nó như bước kế tiếp mặc định.

**Nghiệm thu, chốt trước khi train** — 21 khung tấn công + 64 khung mặt thật của OV5640, giữ
hoàn toàn ngoài tập huấn luyện. Đạt khi **ACER dưới 0,1425** *và* số khung mặt thật bị chặn
**không vượt 2/64**. Thiếu một trong hai là trượt.

**Kết quả 14/09, 90 epoch, cùng pool với bản không có đầu phụ:**

| Model | AUC | ACER | Giả lọt ≤5% | Thật bị chặn |
|---|---|---|---|---|
| chroma 13/09 | **0,8668** | **0,1425** | 23,8% | **2/64** |
| cùng pool, không đầu phụ | 0,8512 | 0,1964 | 66,7% | 15/64 |
| **có đầu phụ 6×6** | 0,7552 | 0,2675 | 52,4% | 14/64 |

**Trượt cả hai vế**, và kém hơn chính bản đối chứng cùng pool: AUC −0,096, ACER +0,071. Chỉ
nhỉnh hơn ở tỉ lệ giả lọt. Đầu phụ vì thế **tắt mặc định**; mã giữ lại sau cờ
`patch_supervision` vì nó không tốn gì khi tắt, và vì số đo phải tái lập được.

**Nhưng phép đo này lại trả về thứ giá trị hơn kết quả của nó.** Chấm lại chính run ấy ở giữa
lịch train:

| | epoch 45 | epoch 90 |
|---|---|---|
| val EER — thước đo gián tiếp | 0,1934 | **0,1624** ↓ tốt lên |
| AUC trên OV5640 | **0,8616** | 0,7552 ↓ tệ đi |

**Trong cùng một lần train**, proxy đi lên đều trong khi thiết bị đi xuống. Hiện tượng "proxy
tăng thì thiết bị giảm" trước đó chỉ thấy khi so **giữa hai run**; đây là lần đầu nó lộ ra
**bên trong một run**, tức nó không phải hệ quả của việc đổi pool hay đổi siêu tham số. Càng
train lâu, model càng khớp phân bố pool và càng lệch khỏi camera thật.

Hệ quả cho mọi arm về sau: **vấn đề không nằm ở kiến trúc hay hàm mục tiêu.** Pool và camera là
hai phân bố khác nhau, và không một đích giám sát nào sửa được điều đó từ phía pool. Trước khi
đề xuất arm tiếp theo, đọc `docs/thesis/nghien-cuu-chong-gia-mao-ov5640.md` — mười ba hướng đã
đóng bằng số đo, và cái duy nhất còn mở đều cần khung ảnh tấn công thật từ chính OV5640.

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
| Chạy tuần tự + early exit | Không dấu hiệu nào của người trong **một phút** → **model, camera và màn nghỉ cùng lúc**. Hai mức nghỉ và danh sách nguồn đánh thức ở **§5.4**. Detect không thấy mặt → **dừng**, không chạy spoof/recog. Spoof fail → không chạy recog. Tiết kiệm ~70% năng lượng |
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
| `arena_big` | **PSRAM**, align 16 B | **anti-spoof + recognition**, dùng chung 1 `MicroAllocator` | `Σ tail + max(head)` = **748.524 B** đo thật 18/09 với V1SE nhập (spoof chiếm 675 KB, recog 412 KB); student width 32 chỉ cần 422.764 B, bản hai backbone từng chiếm 823.148 B |

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

Trong 267 KB đó có 40.960 B bounce buffer LCD **bắt buộc `MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL`** — không có đường đẩy sang PSRAM. Nên đây không phải chọn nhanh hay chậm mà là chọn chạy được hay không: **23,3 ms mỗi frame đổi lấy 224 KB**, và 23,3 ms đó chỉ là 1,3% của một lượt chấm công 1.758 ms.

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
├── tools/         Script ngang khối: gen_contracts · check_comments · check_layers
│               · check_migrations · check_error_codes
│                   · check_schematic · check_pcb · check_migrations
│                   · check_schematic · check_pcb
└── docs/
    ├── KE_HOACH_face_attendance_esp32s3.md      # kiến trúc — nguồn sự thật
    ├── TASKS.md                                 # backlog
    ├── DU_LIEU.md                               # dữ liệu đã tải và xử lí — số đo trên đĩa
    ├── FREERTOS.md                              # sổ kiểm lỗi đồng thời, soát lại mỗi khi thêm task
    ├── DPIA.md                                  # ★ đánh giá tác động Điều 24 — hồ sơ nộp được
    ├── adr/{0001-yunet-thay-ulfg.md, 0002-bo-knowledge-distillation.md, 0003-distill-chong-gia-tu-trong-so-nhap.md, 0004-v1se-thay-student-chong-gia.md}
    ├── measurements/{arena.md, latency.md, power.md, parity.md, ram.md}  # số 🔬 đo được trên board
    │                 └ {antispoof,detection,recognition}/        # số theo nhánh model
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

`tools/gen_contracts.py` sinh ra:

| Nguồn | File sinh ra | Ai dùng |
|---|---|---|
| `contracts/schema/` | `backend/src/common/generated/*.ts` | DTO + validation của NestJS |
| `contracts/schema/` | `frontend/types/generated/*.ts` | React |
| `contracts/schema/` | `firmware/components/common/include/gen_payload.h` | struct + hàm serialize/parse |
| `contracts/mqtt_topics.yaml` | `firmware/components/common/include/gen_topics.h` | `net_mqtt` dựng topic, QoS, retained |
| `contracts/mqtt_topics.yaml` | `backend/src/common/generated/topics.ts` | module `mqtt` của NestJS (E11-T4) |

**Một điểm vào duy nhất, không phải hai script.** Hai nguồn trong `contracts/` nuôi năm đích,
nhưng CI chỉ gọi **một** lệnh rồi `git diff --exit-code`. Tách thành hai script là đẻ ra chỗ
thứ hai có thể quên, mà triệu chứng của việc quên là code sinh ra lệch âm thầm — đúng thứ
`ci/contracts.yml` sinh ra để chặn. Generator chia module bên trong theo nguồn, không chia theo
file thực thi.

**Frontend không nhận bảng topic.** Nó lấy dữ liệu qua REST và WebSocket của `api` chứ không nối
thẳng vào broker (§4.7), nên phát `topics.ts` sang đó là phát một hợp đồng mà không ai bên ấy
dùng — và một hợp đồng không ai dùng là một hợp đồng không ai phát hiện ra lúc nó sai.

**Topic dựng bằng hàm, không bằng chuỗi định dạng.** `gen_topics.h` phát mỗi topic một hàm nhận
buffer của người gọi cộng một macro chốt độ dài tối đa, thay vì phát hằng `"kiosk/%s/up/..."`
để nơi gọi tự `snprintf`. Chuỗi định dạng đẩy việc canh buffer ra từng nơi gọi, nên tràn là lỗi
lúc chạy; hàm với macro độ dài biến nó thành lỗi lúc biên dịch.

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
| Sinh từ `contracts/` | `*/generated/*`, `gen_payload.h`, `gen_topics.h` | ✅ commit — không sửa tay, CI sinh lại rồi `git diff --exit-code` |
| Sinh ra từ source, sinh lại được tại chỗ | `sdkconfig`, `managed_components/`, `build/` | ❌ gitignore |
| Artifact nặng | checkpoint, `.onnx`, `.tflite`, ảnh dataset | ❌ gitignore — lưu ngoài (NAS/S3), ghi sha256 vào lock file |
| Dữ liệu thô | dataset tải về | ❌ gitignore — mô tả trong `manifest.yaml` |
| Cấu hình công cụ AI agent | `CLAUDE.md`, `.claude/`, `.cursor/` | ❌ gitignore — chỉ tồn tại ở máy local |

Bốn thứ **bắt buộc commit** dù là dữ liệu hoặc code sinh tự động: `contracts/golden/` (vài trăm KB), `ml/data/splits/`, `contracts/models.lock.json`, và toàn bộ code sinh từ `contracts/`. Mất chúng là mất khả năng tái lập, hoặc mất chốt chặn giữ ba khối khớp nhau.

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
│   ├── antispoof/depth_maps/<folder>/shard_*.npz # ★ nhan do sau 21x21, float16, khoa theo
│   │                                             #   (shard, chi so ban ghi). Gia mac dinh 0.
│   │                                             #   Sinh lai bang 03_prepare_depth.sh (§3)
│   └── antispoof/depth_model/*.onnx              # ★ bo uoc luong do sau, KHONG commit (§6);
│                                                 #   nguon + sha256 ghi o manifest
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
│   ├── antispoof/{minifasnet.yaml, minifasnet_v2.yaml, minifasnet_distill.yaml}  # v2: trọng số nhập; distill: student w32 (ADR-0003)
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
│   │   │   ├── device_index.py            # quét ov5640/images → manifest.csv
│   │   │   └── depth_maps.py              # ★ nhãn độ sâu 21×21 cho nhánh antispoof (§3).
│   │   │                                  #   Chạy bộ ước lượng trên view WIDE rồi cắt về
│   │   │                                  #   face_in_wide: view TIGHT không còn nền nên
│   │   │                                  #   bộ ước lượng chỉ trả về một mặt phẳng nghiêng.
│   │   │                                  #   Lưu kèm độ tin cậy từng nhãn; ~10% mặt thật
│   │   │                                  #   lệch hẳn khỏi hình chuẩn và phải bị che lúc train
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
│   │   │   │   ├── minifasnet_v2.py           # ★ MiniFASNetV2 upstream, tên thuộc tính giữ nguyên để
│   │   │   │   │                              #   nạp thẳng state_dict; kích hoạt là cờ (§3)
│   │   │   │   └── blocks.py              # ConvBnAct(relu); SE gate HardSigmoid ReLU6(x+3)/6
│   │   │   ├── losses/
│   │   │   │   ├── task_loss.py           # CE live/spoof trên nhãn; SpoofBatch
│   │   │   │   └── distill_loss.py        # ★ KL·T² tới logit teacher, không nhãn (ADR-0003)
│   │   │   ├── postproc/
│   │   │   │   ├── preproc.py             # ★ ai_engine/src/antispoof/preproc.cpp
│   │   │   │   └── emit_golden.py         # → contracts/golden/antispoof/preproc/
│   │   │   ├── data.py                    # patch crop 1.0×/2.7×, augment in ảnh + màn hình
│   │   │   ├── quant.py
│   │   │   ├── train.py
│   │   │   ├── import_minifasnet.py       # ★ .pth upstream → run đúng cấu trúc §4.2, gấp BGR/255/lớp vào
│   │   │   │                              #   trọng số, kiểm parity với ONNX gốc trước khi ghi (§3)
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
│   ├── 03_prepare_depth.sh      # ★ chi nhanh antispoof: tai bo uoc luong do sau, chay tren
│   │                            #   crop cua pool, ghi interim/antispoof/depth_maps/.
│   │                            #   Chay sau 01, truoc 21_train_spoof.sh (§3)
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
  espressif/esp-nn: "==1.3.2"
  espressif/esp_lcd_st7796: "^1.3"
  espressif/esp_lcd_touch_gt911: "^1.1"
  espressif/mqtt: "^1.1"
  espressif/cjson: "^1.7.19"
  joltwallet/littlefs: "^1.16"
```
`espressif/esp_lcd_st7796` có trên registry (đã kéo về bản 1.4.0), nên `drv_lcd` gọi nó chứ không tự viết panel driver.

**`espressif/cjson` vì payload là code sinh, không phải chuỗi gõ tay.** `tools/gen_contracts.py`
sinh `gen_payload.h` từ `contracts/schema/`, và bản C nó sinh ra dựng payload bằng cJSON. Dựng
JSON bằng `snprintf` thì không cần thư viện nào, nhưng khi ấy khuôn payload nằm ở hai chỗ —
schema và chuỗi định dạng — và §4.3 cấm đúng chuyện đó. IDF v6 đã bỏ `json` khỏi lõi giống như
đã bỏ `esp-mqtt`, nên `REQUIRES json` trơ fail ở bước resolve; tên trên registry là
`espressif/cjson`. `svc_sync` là component đầu tiên biên dịch `gen_payload.h`, nên đây cũng là
lần đầu ràng buộc này lộ ra.

**`espressif/mqtt` phải khai dù đây là thư viện của Espressif.** ESP-IDF v6 đã đưa `esp-mqtt` ra
khỏi lõi: `components/mqtt/` trong IDF chỉ còn `test_apps/`, nên `REQUIRES mqtt` trơ sẽ fail ở
bước resolve chứ không phải lúc link.

**`esp-nn` khai thẳng dù `esp-tflite-micro` đã kéo nó theo, và ghim bản chính xác.** Ràng buộc
gián tiếp là `>=1.1.1`, mà các bản esp-nn cũ có lỗi trong kernel INT8 — sai số ở đây không làm
build fail, nó chỉ làm model trả ra số khác trên board so với trên host, tức là đúng thứ khó
lần nhất.

Ghim **sàn** chặn được chiều tụt xuống nhưng không chặn chiều ngược lại, và chiều ngược lại mới
là chiều đã cắn: thêm một dependency bất kỳ làm trình quản lý giải lại cả cây, `^1.3.2` kéo
esp-nn lên 1.4.0, kernel mới xin scratch buffer khác đi, `head` của detect phình **~32 KB**, và
`ai_engine_init()` abort ngay lúc boot. Không dòng code nào của dự án đổi.

Vì vậy **mọi số trong `docs/measurements/arena.md` chỉ đúng với đúng bản esp-nn đã đo**, và
`==1.3.2` là cách duy nhất giữ chúng có nghĩa. Nâng bản esp-nn là một việc có chủ đích: đo lại
arena cả ba nhánh, cập nhật `arena_hint` trong `meta.json` với `contracts/models.lock.json`,
rồi mới đổi con số ở đây — không phải thứ được phép xảy ra như tác dụng phụ của việc thêm một
thư viện không liên quan.

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
│   ├── app_wiring.{c,h}      [C]     # ★ nối queue/event giữa các component
│   └── app_console.{c,h}     [C]     # ★ nạp NVS qua USB, Kconfig tắt ở bản prod (§6.2.1)
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
│   ├── net_provision/     [C]    L3  # xin credential lần đầu qua HTTPS (§7.3)
│   ├── svc_door/          [C++]  L4  # IDoor + ServoDoor bọc drv_servo, FakeDoor cho test
│   ├── svc_vision/        [C++]  L4  # detect mỗi khung, chuỗi spoof → recog khi mặt ổn định (§4.5.5d)
│   ├── svc_attendance/    [C++]  L5  # state machine, chống trùng, ghi log
│   ├── svc_sync/          [C++]  L5  # hàng đợi offline → MQTT
│   └── ui_kiosk/          [C++]  L6  # 8 màn hình vẽ thẳng lên panel + bộ bám hộp (§4.5.5h)
│
├── third_party/
├── assets/                           # ✅ commit — NGUỒN của partition `assets`
│   ├── fonts/{gen_font.py, kiosk_ui_{15,20,24,28}.{c,h}}  # 4bpp khử răng cưa, sinh từ Ubuntu Sans
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
| L3 | `net_wifi` / `net_mqtt` / `net_ota` / `net_provision` | C | `common`, `sys_storage`, `esp_wifi` / `mqtt` / `esp_https_ota` / `esp_http_client` |
| L4 | `svc_door` | C++ | `common`, `bsp_board`, `drv_servo`, `esp_timer` |
| L4 | `svc_vision` | C++ | `common`, `ai_engine`, `svc_facedb`, `drv_camera` |
| L5 | `svc_attendance` | C++ | `common`, `svc_vision`, `svc_facedb`, `sys_storage`, `sys_time`, `svc_door`, `drv_audio` |
| L5 | `svc_sync` | C++ | `common`, `sys_storage`, `net_mqtt` |
| L6 | `ui_kiosk` | C++ | `common`, `bsp_board`, `drv_lcd`, `drv_touch`, `sys_storage` |
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

**Tuần tự, thoát sớm, đúng §3 lớp 5.** Mỗi `step()` chạy detect trên khung mới nhất. Khi mặt chính đã ổn định qua 2 lần detect (IoU ≥ 0,5) thì **cùng bước đó** chạy tiếp spoof → recog → tra `svc_facedb` trên chính khung đang giữ, và trả kết quả ngay: mặt xuất hiện → kết quả sau ≈ 0,6 + 0,93 ≈ **1,5 s**, mức thấp nhất mà ba model cho phép. Trong 0,93 s đó detect không chạy — đó là giá của một core cho AI, và giá được trả ở **đường preview** chứ không ở đường model: hộp mặt trên màn hình do một bộ bám rẻ trên core 0 kéo theo khuôn mặt ở nhịp khung hình giữa hai lần detect (§4.5.5h, E10-T1), nên mắt không thấy hộp khựng mà kết quả không chậm thêm.

**Nhưng hộp phải ra khỏi `step()` ngay khi detect xong, không đợi hai model kia.** Đo 13/09: trả hộp ở cuối `step()` làm nó **cũ 0,5–1,5 giây** khi mặt đã ổn định, và bộ bám phải tự trôi suốt chừng ấy — sai số đo được tới **±169 px** trên khung 480 px, tức hộp nằm hẳn ngoài mặt. Giả định của đoạn trên (bộ bám chỉ phải bắc qua một nhịp detect) vì thế **sai**, và không tham số nào của bộ bám cứu được. `VisionPipeline` nhận một hàm quan sát, gọi **ngay sau detect và trước spoof**, chở danh sách hộp với mặt chính đứng đầu. Kết quả chấm công không nhanh lên một mili giây nào — chỉ có cái hộp trên kính thôi, và nó đi từ cũ 1,4 s xuống cũ ~0,3 s. Hai cách đã cân và bỏ: xen kẽ detect giữa spoof và recog làm kết quả chậm thêm 0,6 s; đưa spoof/recog sang core 0 ăn CPU rỗi của Wi-Fi/LCD và thuế bus PSRAM cho cả hai bên.

**Một lần detect trượt không xoá tiến trình.** Detector trượt lẻ tẻ ngay cả trên khuôn mặt đứng yên, nên `count == 0` của một bước không có nghĩa người đã đi: nó chỉ có nghĩa bước ấy không thấy. Bỏ track ngay tại đó thì `kStableDetects` = 2 phải đếm lại từ đầu và người dùng căn mãi không chấm được. Track chỉ mất sau **2 bước trượt liên tiếp**; `NO_FACE` cũng chỉ báo ra lúc ấy.

**Bám một mặt chính, có quán tính.** Mặt chính là **mặt đang bám** nếu trong lần detect này còn hộp trùng nó (IoU ≥ 0,5); chỉ khi mất dấu mới lấy hộp lớn nhất làm track mới. Nhờ vậy người thứ hai to hơn bước vào không cướp lượt của người đang được xác thực, và hai người ngang cỡ đứng cạnh nhau không làm track nhảy qua lại. Người thứ hai được chấm khi người thứ nhất rời khung (hoặc lùi xa tới mức mất dấu): track mới ổn định sau 2 detect rồi xác thực, tức ~1,5 s sau khi anh ta thành mặt chính. Cùng một track thì sau `MATCH` không xác thực lại; sau `SPOOF`/`UNKNOWN` thử lại sau **3 lần detect**. **Và `UNKNOWN` chỉ được phát ra ở lần thử thứ hai trở đi** — `kUnknownTries` = 2: lần đầu dưới ngưỡng khớp thì khung ấy **không có kết luận**, giống hệt cách một lượt liveness lỗi hay một bảng không trả lời đã xử lý. Lý do là chính đoạn này thừa nhận có "từ chối oan": ngưỡng `match_min` 600‰ chỉ nhận **69%** khung của chính người đã đăng ký (E8-T12), và khung rớt là mặt còn trong bóng vì đo sáng chưa bám kịp lúc người vừa bước vào (E7-T17). Phát `UNKNOWN` ngay khung đầu là nói với một nhân viên thật rằng họ không có trong hệ thống, rồi chấm công cho họ 1,4 giây sau — máy tự cãi chính nó. Giá phải trả là người lạ chờ tới **~2,9 s** mới bị từ chối thay vì ~1,5 s; đổi lại người thật không bị mắng oan lần nào. Bộ đếm reset khi `MATCH` và khi đổi track. Đo 13/09: một bước detect mất 320 ms và một bước chạy cả spoof lẫn recog mất 1.180 ms, nên 6 lần detect là **2,8 giây đứng chờ** — người bị từ chối oan phải đứng im ngần ấy trước khi máy chịu nhìn lại, và họ đọc quãng đó là máy treo. 3 lần cho ~1,4 giây, vẫn đủ để không chạy recog trên mọi khung. **Một yêu cầu đăng ký đang chờ thì bỏ qua cổng này**: nó cần embedding của chính khuôn mặt vừa khớp, mà `matched_` = true khoá vĩnh viễn đường xác thực trên track ấy nên mẫu thứ hai không bao giờ tới. Yêu cầu ấy **chỉ xoá khi bảng đã nhận mẫu**: bảng đầy hoặc phép ghi hết giờ thì yêu cầu còn nguyên và khung xác thực kế tiếp thử lại, vì bỏ qua lỗi ở đây là báo "đã thêm" cho một người không nằm ở đâu cả. Mặt dưới `face_min_px` chỉ báo `FACE_SMALL`, không chạy gì thêm. **Tiền kiểm hình học của §3 "Chốt 1" đứng ngay sau cổng ấy**: ô vuông 1,0× mà `fitted_box` sẽ dựng quanh mặt phải nằm trọn trong khung, không đạt thì báo `FACE_OUT_OF_FRAME` và dừng, **không** chấm sống/giả. Điều kiện nêu bằng chính ô vuông chứ không bằng một lề rời: ô bị kẹp mới là thứ kéo viền vào crop, và nêu như vậy thì không đẻ thêm ngưỡng nghiệp vụ nào cho §4.9. Mọi mặt detect thấy (tối đa 4) đều nằm trong kết quả để UI vẽ hộp; chống chấm trùng cùng một người trong N phút là việc của `svc_attendance`.

**Trượt tiền kiểm hình học không phải là đổi người.** Danh tính của một track do **duy nhất** phép chồng hộp quyết định; `stable_` là bộ đếm riêng, đo hộp ấy đã đứng yên được mấy lần detect, và cổng hình học chỉ xoá bộ đếm ấy chứ không đóng track. Gộp hai thứ vào cùng một biến là cái bẫy: ô vuông 1,0× lấy cỡ theo cạnh dài của đầu nhưng phải lọt cạnh ngắn của khung, nên một người đứng hơi chệch dải giữa trượt cổng ấy liên tục, và mỗi lần trượt lại mở một track mới. Mở track mới thì `kUnknownTries`, `enrol_spoofs_` và `matched_` đều về 0 — người lạ đứng hơi lệch **không bao giờ** đủ hai lần thử để bị kết luận, màn hình đứng mãi ở "Đang nhận diện", còn người vừa chấm công xong thì bị xác thực lại. Track chỉ đóng khi mất mặt (2 bước detect trượt liên tiếp) hoặc khi hộp của lần detect này không chồng hộp lần trước.

**Ba đường thoát im lặng của `verify()` phải để lại dấu.** Liveness lỗi, embed lỗi, và bảng không trả lời đều trả về không kết luận — đúng, vì không cái nào là một phán quyết về khuôn mặt này — nhưng cả ba đều để màn hình ở "Đang nhận diện" mà không có gì trong log. Mỗi đường ghi một dòng `no verdict: <nguồn> <mã lỗi>`, nếu không thì một khoá bảng kẹt và một model hỏng trông giống hệt nhau từ phía người đứng trước kính.

**Kết quả là sự kiện, không phải trạng thái.** `step()` trả `SVC_VISION_NONE` ở phần lớn khung; `NO_FACE`/`FACE_SMALL`/`FACE_OUT_OF_FRAME` chỉ báo khi trạng thái quan sát đổi; `SPOOF`/`UNKNOWN`/`MATCH` báo đúng một lần mỗi lượt xác thực. Nhánh spoof vắng trong ảnh `models_0` (§6.2.2) thì pipeline bỏ qua spoof và trả `live_score = −1`; cho cửa hay không với điểm âm đó là quyết định của `svc_attendance`, không phải của tầng này.

Bốn ngưỡng (`detect_min_score`, `live_min_score`, `match_min_score`, `face_min_px`) là ngưỡng nghiệp vụ theo §4.9: `main` đọc từ NVS namespace `vision` (§6.2.1) và truyền vào `svc_vision_init()`; lần boot đầu chưa có key thì `main` gieo từ `Kconfig` của `svc_vision`. `live_min` gieo **500‰**, đo 16/09 trên 62 khung thật và 25 khung giả **đều chụp bằng chính OV5640**, chấm bằng file INT8 trên `models.lock.json` qua đúng crop và lấy mẫu của firmware (`docs/measurements/antispoof` §42.2): mọi khung giả đứng dưới 0,316, mặt thật thấp nhất ở 0,636, nên 500‰ nằm giữa với biên hai phía 0,184 và 0,136. Con số tròn ấy có được nhờ bước căn bias của §3: không có nó thì cửa sổ chỉ rộng 19‰ và một sai số gieo vài phần nghìn là lật phán quyết. Bộ giả mới có hai phiên, một điện thoại và một bộ ảnh in, nên E8-T12 vẫn phải chốt lại khi có thêm đòn tấn công. `detect_min` gieo **350‰**, đo 13/09 trên board sau khi sửa thứ tự byte RGB565 (§4.5.6): một khuôn mặt thật ở cự ly kiosk chấm **0,45–0,59**, tức sàn 500‰ cũ nằm **ngay giữa dải điểm của chính khuôn mặt ấy** — detector bắt được một bước rồi trượt bước sau, lặp lại suốt, và `kStableDetects` = 2 của §4.5.5d không bao giờ đủ điều kiện nên người dùng phải căn đi căn lại. Trong cùng phép đo, ứng viên nhiễu của nền chấm 0,14–0,37, nên 350‰ nằm giữa hai đám và giữ được biên cả hai phía. Một ứng viên giả lọt qua sàn này vẫn phải qua `face_min_px`, hình học §3 "Chốt 1", liveness và cosine, nên hạ sàn detect **không** hạ độ an toàn của cả chuỗi. `face_min_px` hạ **113 → 100**, đo 13/09 trên board: người đứng ở cự ly tự nhiên trước kiosk cho hộp mặt **107–110 px**, tức hụt cổng cũ đúng 3–6 px **liên tục** — khung ngắm không bao giờ chuyển sang trạng thái đủ gần và người dùng căn mãi không xong. Cổng đo **hộp mặt** của detector chứ không đo cái đầu, mà khung ngắm thì người ta lấp bằng **cả đầu**: đo được đầu lấp kín khung 240 px panel thì hộp mặt chỉ 162 px panel, tức **108 px khung** — hệ số đầu/mặt ≈ **1,48**. Vậy 113 và khung 240 px là hai con số mâu thuẫn nhau; 100 px cho lại biên 7–10 px ở đúng cự ly người ta đứng. Giá phải trả: recognition kéo mặt 100 px lên 113×113, phóng 13%. 🔬 **Chưa đo** ảnh hưởng lên accuracy — E8-T12 phải chốt lại, và nếu nó tốn quá thì đường đúng là **thu khung ngắm về đúng cỡ hộp mặt** chứ không phải nâng cổng lên lại.

`match_min` 🔬 chưa đo.

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

**Đồng hồ giữ UTC, múi giờ là việc của tầng vẽ.** DS3231 và `sys_time_now_ms()` đều là UTC, nên
một bản ghi chấm công mang đúng một mốc thời gian dù kiosk đứng ở đâu. Chuỗi POSIX nằm ở NVS
`device/tz` (§6.2.1), `main` đọc rồi gọi `sys_time_set_zone()` — `sys_time` không tự đọc NVS
được vì `sys_storage` cùng tầng L2 và §4.5.4 cấm phụ thuộc ngang tầng. Thiếu khoá thì rơi về
`CONFIG_SYS_TIME_TZ`: một kiosk hiện sai giờ 7 tiếng còn tệ hơn một kiosk không boot.

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
| `Idle` | `FaceSmall` | `Detecting` | `Watch` — có người, còn xa |
| `Idle` | `Match` | `Granted` | `Grant` |
| `Idle` | `Spoof` / `Unknown` | `Denied` | `Refuse` |
| `Detecting` | `FaceSmall` | `Detecting` | `None` — chỉ UI nhắc lại gần |
| `Detecting` | `Match` | `Granted` | `Grant` |
| `Detecting` | `Spoof` / `Unknown` | `Denied` | `Refuse` |
| `Detecting` | `NoFace` / `PresenceOff` | `Idle` | `Rest` |
| `Verifying` | `Match` | `Granted` | `Grant` |
| `Verifying` | `Spoof` / `Unknown` | `Denied` | `Refuse` |
| `Verifying` | `Timeout` | `Detecting` | `None` |
| `Granted` | `Timeout` | `Cooldown` | `Rest` |
| `Denied` | `Match` | `Granted` | `Grant` |
| `Denied` | `Timeout` | `Cooldown` | `Rest` |
| `Cooldown` | `Match` | `Granted` | `Grant` |
| `Cooldown` | `Timeout` | `Idle` | `None` |
| `Cooldown` | `PresenceOff` | `Idle` | `None` |

`Verifying` tồn tại cho đường xác thực nhiều khung của §4.5.5d: `svc_vision` tự giữ nhịp thử lại, nên tầng này chỉ cần một trạng thái chờ có `Timeout` để không kẹt nếu `ai_task` chết.

**Một khuôn mặt cũng mở được máy, không chỉ ToF.** `PresenceOn` là **một cạnh**: chấm xong, máy về `Idle`, người vẫn đứng nguyên chỗ cũ nên không có cạnh nào nữa và ToF không mở máy lần thứ hai. Đo trên board 13/09: chỉ nghe ToF thì sau lần chấm đầu, mọi lần sau im cho tới khi reset. Bốn sự kiện thị giác ở `Idle` vì thế cũng mở máy — thấy mặt tức là có người, dù ToF chưa kịp nhả cạnh nào.

**Cổng "có người" của ToF cho model nghỉ, nhưng không được là lối vào duy nhất.** Phép đo 13/09 ở trên nói nghe mỗi ToF là hỏng đường chấm công, và bỏ `svc_vision_step` khi ToF không thấy ai thì còn chặt hơn — không còn phán quyết nào để `Idle` nhận. Nón nhìn 27° của VL53L1X (§2.3D) hẹp hơn góc camera: người đứng lệch trục hay ngoài `present_mm` thì ToF đọc 65535 mm trong khi camera vẫn thấy rõ mặt. Vì thế §5.4 giữ **chạm màn** làm nguồn đánh thức thứ hai và giữ GT911 thức suốt: ai mà cảm biến không thấy thì chạm một cái là máy dậy. Với người thật sự đến chấm công, đứng trước kiosk trong `present_mm` là nằm gọn trong nón nên ca này không xảy ra; ca hỏng thật đã gặp là màn lấy mẫu của §4.5.5h.2, nơi người vận hành đứng lùi ra, và nó được giữ thức bằng nguồn đánh thức riêng. Giá của việc cho model chạy liên tục thay vì nghỉ là **1,3 fps preview** (đo 18/09: 12,9 so với 14,187 fps) cộng toàn bộ khoản điện của §5.4 — không đáng, khi đã có đường đỡ.

**Nhưng mở máy không được tiêu mất chính phán quyết đã mở nó.** Mỗi sự kiện ở `Idle` làm đúng việc nó mang: `FaceSmall` mở máy rồi chờ, còn `Match` **cấp luôn** và `Spoof` / `Unknown` **từ chối luôn**. Đo trên board 13/09: khi `Match` ở `Idle` chỉ chuyển sang `Detecting`, lần khớp đầu bị tiêu vào việc mở máy, mà §4.5.5d **không xác thực lại một track đã khớp** nên lần khớp thứ hai chỉ tới khi người dùng cử động đủ để track mất dấu (IoU < 0,5) — người đưa mặt vào khung rồi đứng yên **không bao giờ chấm được**, phải nhúc nhích mới xong. Cùng một lẽ ấy, `Denied` và `Cooldown` nhận `Match`: 3,5 giây giữ màn hình từ chối không được phép nuốt một lần khớp thật, người bị từ chối oan phải được chấm ngay ở vòng thử lại kế tiếp chứ không đứng đợi hết giờ. Chống chấm trùng vẫn là việc của `attend.dedup_min` nên không đường nào trong số này đẻ ra bản ghi thừa.

**Một lần cấp quyền đòi một lần *đến*, không phải một lần *khớp*.** Ba đường `Match` ở trên có mặt để một lần khớp thật không bị nuốt, nhưng chúng cũng khiến khuôn mặt **chưa hề rời đi** được cấp quyền lại sau mỗi vòng `Granted → Cooldown → Idle`: `Cooldown` dài 1.500 ms trong khi một vòng AI đầy đủ mất ≈ 1.750 ms, nên máy không bao giờ nghỉ được trọn vẹn. Hậu quả đo trên board 14/09: cửa mở lại và loa kêu lại **mỗi ≈ 4 giây** suốt thời gian người ta còn đứng đó, còn dải kết quả thì nháy sang câu nhắc căn khung rồi quay lại. `dedup_min` không đỡ được vì nó chỉ chặn **bản ghi**, không chặn cửa, tiếng và màn.

Nên `Grant` bị chặn khi **cùng một `employee_id` còn trong cửa sổ `dedup_min`** *và* chưa có `NoFace` hoặc `PresenceOff` nào kể từ lần cấp trước. Chặn đặt ở **bước chuyển trạng thái** chứ không ở hành động: tiếng và màn bám vào việc *đổi trạng thái*, nên chặn ở hành động thì cửa im mà loa vẫn kêu. Người khác bước tới vẫn được cấp ngay, vì phép so là theo mã nhân viên.

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

`EmbeddingTable` giữ nguyên ảnh file của §6.2.4 trong PSRAM — header 32 B rồi các bản ghi 576 B — nên ghi bền là một lệnh `write_atomic` của đúng khối đó, và chuẩn bình phương của từng bản ghi được tính sẵn lúc nạp. Tích vô hướng int8·int8 chạy bằng SIMD PIE của ESP32-S3 (`ee.vmulas.s8.accx`, 16 MAC mỗi lệnh) trong `dot_s8_esp32s3.S`: 32 B header và 576 B bản ghi đều chia hết cho 8 nên mọi embedding nằm 8-byte aligned, đủ cho `ee.vld.l.64.ip`; bản C thuần chỉ còn cho target khác. Kết quả số **đúng bằng** bản C — accumulator 40 bit, không làm tròn — nên `cosine.py` bên `ml/` vẫn là bản tham chiếu. Đo 10/09 ở `-O2`, 1.000 bản ghi: vòng C thuần **20,9 ms**, quá mốc 20 ms của E8-T11; số của kernel PIE ghi ở `TASKS.md`.

##### h) `ui_kiosk` — kế thừa đúng bài

```cpp
class Screen {
public:
    virtual ~Screen() = default;
    virtual void on_enter() {}
    virtual void on_exit()  {}
    virtual bool on_touch(int x, int y, bool down) { return false; }   // true = vẽ lại
    virtual bool tick(uint32_t dt_ms, const Sight& seen) { return false; }
    virtual void paint(Canvas& to, const Sight& seen) = 0;   // cover map, không phải lv_obj
};
// ScanScreen · MenuScreen · EnrolScreen · CaptureScreen · PeopleScreen · SettingsScreen
class ScreenManager {
    Screen*  screens_[kScreenCount];   // dựng sẵn lúc boot, không tạo/hủy lúc chạy
    Screen*  cur_;
public:
    void go(ScreenId id) noexcept;     // cur_->on_exit(); cur_ = …; cur_->on_enter();
};
```

Sáu màn hình cùng vòng đời, thêm màn hình mới không đụng `ScreenManager`. Đây là chỗ virtual đáng giá nhất và cũng rẻ nhất (mỗi lần chuyển màn mới gọi 1 lần).

**Không dùng LVGL, và đó là hệ quả của chính đoạn dưới.** §4.5.5h đã chốt vùng preview vẽ
thẳng, không qua LVGL — mà **màn hình chính của kiosk chính là preview**. Để LVGL vào thì hai
bộ vẽ cùng ghi một panel SPI, đúng thứ `m_spi_lcd` sinh ra để chặn, và mỗi lần chuyển màn là
một lần bàn giao panel — chỗ mà xé hình hay quay lại. Nên mọi màn dùng **một bộ vẽ duy nhất**:
`Canvas` là một **cover map 1 byte mỗi pixel** mang chỉ số bảng màu cộng độ phủ (xem đoạn bảng
màu ở §4.5.5h), chữ lấy từ bảng glyph 4bpp `assets/fonts/` sinh sẵn từ TTF, và `drv_lcd` cắt
map ấy theo từng dải 48 dòng ngay trong vòng gom khung. Cái giá phải trả là bàn phím, danh
sách, thanh trượt và nút bấm **tự viết**, mỗi thứ cỡ trăm dòng; cái được là không thêm thư
viện, không thêm 48 KB heap, và **không bao giờ có hai người ghi panel**.

**Tự vẽ thì phải tự có hệ thống, không thì ra giao diện chắp vá.** Không có LVGL nghĩa là
không có ai chặn một màn hình đặt chữ đè lên nhau hay tràn khỏi panel, và đó là lỗi đã xảy ra
thật: đo bảng glyph cũ, dòng `Đưa khuôn mặt vào khung` rộng **331 px trên panel 320 px** — câu
chữ người dùng nhìn cả ngày bị cắt cụt hai đầu. Nên `ui_kiosk` khai **`theme` và `widgets`**
làm tầng bắt buộc đi qua: `theme` giữ bảng màu, thang chữ và nấc giãn cách; `widgets` giữ
những thứ lặp lại (nút, dòng danh sách, thanh trượt, công tắc, biểu tượng) cộng **phép xếp
dọc** tự cộng dồn toạ độ. Màn hình mô tả *có những gì*, không tự tính `y`. Chữ dài **tự cắt
đuôi bằng `…`** ngay trong hàm vẽ chứ không trông vào người viết màn hình đếm ký tự, vì tên
người và tên Wi-Fi là dữ liệu chạy lúc chạy, không đoán trước được.

**Một dòng, dùng lại ở khắp nơi.** Menu, Cài đặt, Danh sách người và Wi-Fi đều là *danh sách
những dòng chạm được*, nên cả bốn vẽ bằng **cùng một widget**: ô biểu tượng, nhãn, giá trị xám,
mũi tên. Nhờ vậy bo góc, chiều cao, lề trong và màu lúc nhấn giống nhau ở mọi màn mà không ai
phải nhớ con số — đổi một chỗ là đổi cả máy. Màn hình nào cũng tự đi ra khỏi kiểu chung thì
giao diện thành chắp vá, và đó đúng là thứ tầng này dựng ra để chặn.

**Không ai bàn giao panel cho ai.** Ý đầu là màn không video thì `ui_task` lấy `m_spi_lcd` và
tự đẩy khung hình — nhưng mỗi lần chuyển màn khi ấy là một lần đổi chủ giữa hai task đang chạy,
đúng chỗ xé hình hay sinh ra. Thay vào đó **`cam_task` vẫn là người duy nhất ghi panel ở mọi
màn**, và màn không video chỉ **tô kín nền vào cover map của chính nó** — video vẫn chạy dưới
lớp ấy nhưng không thấy được. Cái giá là một lượt gửi SPI không ai nhìn; cái được là `m_spi_lcd`
không bao giờ bị tranh và không có đường mã nào chuyển quyền lúc đang chạy.

**Cover map gửi xuống theo hộp bao, không gửi cả màn.** `Canvas` nhớ hình chữ nhật nhỏ nhất
chứa mọi ô khác 0; `drv_lcd_mask_t` mang thêm `stride` nên nó nhận thẳng một vùng con của bản
đồ 320×480 mà không phải chép ra. Màn `Scan` chỉ đụng thanh trên, khung ngắm và dải dưới, nên
mỗi khung chỉ quét đúng ngần ấy byte thay vì 153 KB.

**Đường đi giữa các màn:**

```
Scan ──ba gạch──> Menu ──"Thêm người"──> Enroll ──chọn tên──> Capture ──đủ mẫu──> Scan
 ▲                 │                                                              │
 │                 ├──"Danh sách"──> People                                        │
 │                 │                                                              │
 │                 └──"Cài đặt"───> Settings ──"Wi-Fi"─────> Wifi                  │
 │                                     │                                          │
 │                                     └──"Thiết bị của tôi"──> Device             │
 └────────────────────────────── Đóng / Huỷ ───────────────────────────────────────┘
```

`Enroll` là màn **danh sách chờ**, không phải màn bàn phím. Gõ tên là thao tác tệ nhất có thể
đặt lên một màn 3,5 inch, và nó còn sai về dữ liệu: §7.5 đã cho server giữ hồ sơ nhân viên và
đẩy xuống lệnh `ASSIGN` kèm `employeeId` cùng tên đủ dấu. Người vận hành vì thế **chọn một
dòng** rồi đưa mặt vào khung — máy đã biết người ấy là ai, không ai phải đánh vần lại.

Bàn phím còn đó làm **đường lui**, xếp cuối danh sách là dòng *Tự nhập tên*, và chỉ đường lui
ấy mới gõ chữ không dấu: bộ gõ tiếng Việt là một hệ thống riêng, không phải việc của kiosk.
Đường lui tồn tại vì hai ca thật — máy chưa từng nối server, và người cần thêm ngay trong lúc
mạng chết. Người thêm theo đường ấy nhận mã số ở **dải riêng** của §7.5 nên không bao giờ đụng
mã server cấp, và §7.5 đã có đường báo ngược lên bằng `up/enroll`.

Danh sách chờ trống thì màn này **không được là trang trắng**: nó nói thẳng rằng chưa có ai
được giao từ server và chỉ vào đúng dòng *Tự nhập tên*. `CaptureScreen`
gọi `svc_vision_enrol_next()` rồi đứng chờ chính `MATCH` của người vừa thêm, nên "thêm thành
công" là câu nói sau khi máy **đã nhận lại được**, không phải sau khi ghi xong file.

**Đếm lần từ chối phải cùng nhịp với pipeline, và nhịp ấy là từng mẫu.** Màn `Capture` bỏ cuộc
theo số lần bị gọi ảnh giả, `svc_vision` ngừng xác thực theo `kEnrolSpoofTries` — hai con số này
**buộc phải reset cùng lúc**. Màn đếm dồn cả lượt trong khi pipeline đếm từng mẫu thì người thật
bị đá ra oan: rải ba lần từ chối qua ba mẫu là đủ hỏng, mà BPCER đo được ở `live_min` 750‰ là
1,75% nên chuyện ấy xảy ra thật trong ánh sáng xấu. Ngược lại màn đếm rộng hơn pipeline thì
pipeline bỏ cuộc trước, màn đứng đợi hết hạn 15 s rồi mới báo — một khoảng treo không lý do. Cả
hai vì thế reset ở đầu **mỗi mẫu**, và dòng "lần n/3" trên kính đếm đúng số lần của mẫu đang lấy.

**Đăng ký hỏng giữa chừng phải dọn sạch dấu vết.** Mẫu nào đậu là `keep()` ghi ngay vào bảng và
gọi `svc_facedb_persist()` — đúng, vì mất điện giữa chừng không được mất người đã lấy xong. Nhưng
khi màn bỏ cuộc, những mẫu đã lỡ ghi **vẫn nằm lại**: bảng có một người mang `employee_id` thật,
chỉ một template, **nhận diện được**, trong khi người vận hành vừa đọc "Chưa lấy được mẫu" và tin
là không có gì xảy ra. Một người chỉ có mẫu chính diện sẽ trượt ngay khi hơi nghiêng mặt, và
không ai hiểu vì sao — lỗi âm thầm tệ hơn việc phải đăng ký lại.

Nhưng xoá thẳng cũng phí: công lấy mẫu đã bỏ ra rồi, và cái hỏng thường chỉ là ánh sáng hay tư
thế của **một** mẫu. Nên màn hỏng đưa ra **hai nút**, người vận hành chọn:

| Nút | Việc |
|---|---|
| **Thử lại** | Lấy lại từ mẫu đầu, **giữ nguyên `employee_id` và tên**. `FaceDb::enroll` thay thế theo cặp `(employee_id, template_idx)` nên ba mẫu mới đè lên ba mẫu cũ, không đẻ bản ghi thừa. Màn không rời đi nên `main` vẫn giữ mã người ấy |
| **Thoát** | Rời về `Menu`. `main` **xoá người dở dang** bằng `svc_facedb_remove` + `svc_facedb_persist`, đúng đường màn Danh sách đang dùng |

`main` là chỗ duy nhất biết `employee_id` thật, vì màn chỉ gửi mã chỗ `kNewPerson`; nó xoá khi
thấy màn đã rời mà chưa đủ ba mẫu.

**Đăng ký không được đẻ ra một lần chấm công.** Ngay sau mẫu đầu, máy nhận ra người đang đứng đó và `svc_vision` bắn `MATCH` như mọi khi — `svc_attendance` mở cửa, ghi bản ghi, màn hiện "Đã chấm công" giữa lúc người ta đang quay mặt sang trái. Thấy trên board 13/09. Nên `ai_task` **không đẩy kết quả vào `q_result`** khi màn `Capture` đang mở: khung vẫn chạy đủ ba model để lấy mẫu, chỉ có đường nghiệp vụ là im. Câu xác nhận của việc thêm người do chính `CaptureScreen` nói, không mượn thẻ chấm công của màn `Scan`.

**Lá chắn ấy dài đúng bằng thời gian màn mở, và không dài hơn.** Đóng màn lấy mẫu ra thì người
vừa đăng ký, nếu còn đứng đó, sẽ được chấm công ngay — và **đó là đúng**: họ đang có mặt ở máy
thật, bản ghi sinh ra là bản ghi thật. Cái §4.5.5h.2 cấm là chuyện khác hẳn: thẻ "Đã chấm công"
nhảy ra **giữa lúc người ta đang quay mặt lấy mẫu thứ hai**, tức trong lòng một việc chưa xong.

Hai cách chặn dài hơn thế đã thử trên board và **cả hai đều hỏng nặng hơn cái chúng chữa**. Một
cái chốt toàn cục trong `ai_task` chờ `NO_FACE` thì không bao giờ mở, vì bộ dò bám một vật trong
phòng suốt 80 giây không nhả — **cả kiosk mất khả năng chấm công** tới khi khởi động lại. Đánh
dấu người mới là "vừa được phục vụ" để đòi một lần *đến* mới thì nhẹ hơn nhưng vẫn sai: người ta
đứng nguyên tại chỗ nên lần *đến* ấy không tới, màn kẹt ở "Đang nhận diện..." cho hết cửa sổ
`dedup_min`. Bài học chung: **đừng bắt người dùng làm một việc họ không có lý do gì để biết là
phải làm.**

**Đếm lần từ chối phải cùng nhịp với pipeline, và nhịp ấy là từng mẫu.** Màn `Capture` bỏ cuộc
theo số lần bị gọi ảnh giả, `svc_vision` ngừng xác thực theo `kEnrolSpoofTries` — hai con số này
**buộc phải reset cùng lúc**. Màn đếm dồn cả lượt trong khi pipeline đếm từng mẫu thì người thật
bị đá ra oan: rải ba lần từ chối qua ba mẫu là đủ hỏng, mà BPCER đo được ở `live_min` 750‰ là
1,75% nên chuyện ấy xảy ra thật trong ánh sáng xấu. Ngược lại màn đếm rộng hơn pipeline thì
pipeline bỏ cuộc trước, màn đứng đợi hết hạn 15 s rồi mới báo — một khoảng treo không lý do. Cả
hai vì thế reset ở đầu **mỗi mẫu**, và dòng "lần n/3" trên kính đếm đúng số lần của mẫu đang lấy.

**Đăng ký hỏng giữa chừng phải dọn sạch dấu vết.** Mẫu nào đậu là `keep()` ghi ngay vào bảng và
gọi `svc_facedb_persist()` — đúng, vì mất điện giữa chừng không được mất người đã lấy xong. Nhưng
khi màn bỏ cuộc, những mẫu đã lỡ ghi **vẫn nằm lại**: bảng có một người mang `employee_id` thật,
chỉ một template, **nhận diện được**, trong khi người vận hành vừa đọc "Chưa lấy được mẫu" và tin
là không có gì xảy ra. Một người chỉ có mẫu chính diện sẽ trượt ngay khi hơi nghiêng mặt, và
không ai hiểu vì sao — lỗi âm thầm tệ hơn việc phải đăng ký lại.

Nhưng xoá thẳng cũng phí: công lấy mẫu đã bỏ ra rồi, và cái hỏng thường chỉ là ánh sáng hay tư
thế của **một** mẫu. Nên màn hỏng đưa ra **hai nút**, người vận hành chọn:

| Nút | Việc |
|---|---|
| **Thử lại** | Lấy lại từ mẫu đầu, **giữ nguyên `employee_id` và tên**. `FaceDb::enroll` thay thế theo cặp `(employee_id, template_idx)` nên ba mẫu mới đè lên ba mẫu cũ, không đẻ bản ghi thừa. Màn không rời đi nên `main` vẫn giữ mã người ấy |
| **Thoát** | Rời về `Menu`. `main` **xoá người dở dang** bằng `svc_facedb_remove` + `svc_facedb_persist`, đúng đường màn Danh sách đang dùng |

`main` là chỗ duy nhất biết `employee_id` thật, vì màn chỉ gửi mã chỗ `kNewPerson`; nó xoá khi
thấy màn đã rời mà chưa đủ ba mẫu.

**Đăng ký không được đẻ ra một lần chấm công.** Ngay sau mẫu đầu, máy nhận ra người đang đứng đó và `svc_vision` bắn `MATCH` như mọi khi — `svc_attendance` mở cửa, ghi bản ghi, màn hiện "Đã chấm công" giữa lúc người ta đang quay mặt sang trái. Thấy trên board 13/09. Nên `ai_task` **không đẩy kết quả vào `q_result`** khi màn `Capture` đang mở: khung vẫn chạy đủ ba model để lấy mẫu, chỉ có đường nghiệp vụ là im. Câu xác nhận của việc thêm người do chính `CaptureScreen` nói, không mượn thẻ chấm công của màn `Scan`.

**Lá chắn ấy phải dài hơn thời gian màn mở.** Đóng màn lấy mẫu là hết chặn, mà người vừa đăng ký
**vẫn đứng nguyên đó** và giờ đã có mặt trong bảng — nên khung kế tiếp cho `MATCH` và máy chấm
công luôn: mở cửa, kêu loa, ghi một bản ghi mà không ai định tạo. Người vận hành chỉ thấy khi bấm
`Đóng` ở màn `Menu`, vì màn ấy che mất màn `Scan`. Đo trên board: ngay sau `enrol 16 sample 0` là
`verdict 6, live 0.997, match 1.000, id 16` — người mới khớp chính mình ở điểm tuyệt đối, chỉ
1,3 giây sau mẫu đầu. Cách sửa **không** được là một cái chốt toàn cục trong `ai_task` chờ `NO_FACE`: đo hôm nay cho
thấy bộ dò bám một vật trong phòng **suốt 80 giây không nhả một lần nào**, nên chốt ấy không bao
giờ mở và **cả kiosk mất khả năng chấm công** cho tới khi khởi động lại. Một lá chắn có thể kẹt
vĩnh viễn thì tệ hơn hẳn cái lỗi nó định chữa.

Đường đúng đã có sẵn ở §4.5.5f: **một lần cấp quyền đòi một lần *đến***. Đăng ký xong là `main`
báo cho `svc_attendance` rằng người ấy **vừa được phục vụ**, y như vừa chấm công xong — `Grant`
cho đúng `employee_id` ấy bị chặn cho tới khi có một lần *đến* mới, mà `apply()` ghi nhận bằng ba
đường độc lập: `NoFace`, `PresenceOff` của ToF, hoặc **thấy một `employee_id` khác**. Ba đường
nghĩa là không đường nào kẹt được cả ba. Và quan trọng nhất: lá chắn chỉ bọc **một người**, nên
người khác bước tới vẫn chấm công bình thường ngay lập tức — hỏng một người còn hơn hỏng cả máy.

##### h.1) Màn `Scan` — khung ngắm là thứ sửa lỗi "đứng xa không chấm được"

Máy chấm công thương mại (ZKTeco SpeedFace, Hikvision MinMoe) đều để một **khung ngắm đứng yên
giữa màn** và bảo người dùng đưa mặt vào đó ở 30–50 cm. Đó không phải trang trí: nó là cách duy
nhất nói cho người đứng trước máy biết **đứng đâu thì máy làm việc được**, và kiosk này đang
thiếu đúng chỗ ấy — `vision.face_min_px` từ chối mọi khuôn mặt nhỏ hơn mà **không nói gì**, nên
người đứng xa chỉ thấy máy im.

Khung ngắm vì thế vẽ theo **chính cổng ấy quy ra pixel panel**, không phải bằng mắt. Ba con số
nối nhau: đường preview lấy dải giữa 213 cột của khung 480 rồi kéo lên 320, tức hệ số **1,502**;
cổng `face_min_px` = **100 px khung** (§4.5.5d) tức **150 px panel**; và người ta lấp khung ngắm
bằng **cả cái đầu** chứ không bằng hộp mặt, mà tỷ lệ đầu trên mặt đo được là **1,48** (§4.5.5d).
Khung ngắm vì thế **240 × 296 px panel**, đặt giữa, mép trên cách đỉnh 96 px: đầu lấp kín nó cho
hộp mặt 240 / 1,48 ≈ **162 px panel = 108 px khung**, dư 8 px trên cổng. Ai lấp đầy khung thì
chắc chắn qua cổng, và đó là một lời hứa đo được chứ không phải một gợi ý.

**Khung ngắm thay luôn hộp bám mặt.** Hộp vẽ theo đầu ra detect phải bám một khuôn mặt đang đi
lại bằng một bộ so vân sáng chạy mỗi khung, và đo trên board 13/09 nó tốn **~2 fps** mà vẫn
trượt khi người quay nhanh (§4.5.5h, đoạn `BoxTracker`). Khung ngắm **đứng yên** thì không có gì
để trượt, không tốn phép tính nào, và nói được nhiều hơn: hộp bám chỉ nói "máy thấy anh", khung
ngắm nói "đứng vào đây thì máy làm việc được". `BoxTracker` vì thế **ra khỏi đường vẽ**; mã giữ
lại trong cây cho luồng nào cần bám thật (ví dụ nhiều người cùng khung ở E10-T7).

Bốn trạng thái của khung, màu là thông tin chứ không phải trang trí:

| Máy đang | Khung | Dòng nhắc dưới khung |
|---|---|---|
| chờ, không thấy ai | trắng mờ | `Đưa khuôn mặt vào khung` |
| thấy mặt nhưng nhỏ hơn cổng | hổ phách | `Lại gần hơn` |
| mặt tràn ra ngoài khung vì đứng quá gần | hổ phách | `Lùi lại một chút` |
| mặt qua cổng, pipeline đang làm việc | xanh mint | `Đang nhận diện...` |
| xong, đạt | xanh mint | thẻ dấu tích + tên ở dải dưới |
| xong, từ chối | hổ phách | một dòng chữ ở dải dưới, **giữ cho tới khi mặt ấy rời khung hoặc pipeline bắt sang người khác** |

**Màn hình không tự đoán, nó chỉ vẽ điều `svc_vision` nói.** Bốn trạng thái trên là bốn cổng của
pipeline (§4.5.5d): không có mặt, mặt dưới `face_min_px`, ô 1,0× tràn khung, qua cổng. `main` dịch
sang `ui_kiosk_stage_t`, `ui_kiosk` vẽ.

**Trạng thái đi theo đường nhanh, phán quyết đi theo đường chậm — hai kênh, không gộp.** Cổng thứ
tư, "qua cổng, đang chạy model", **không thể** đi bằng `svc_vision_kind_t` như ba cổng kia. Hai lẽ,
cả hai đều đo được. Thứ nhất, `svc_vision_step()` **chặn 1,5 giây** để chạy spoof rồi recog, mà
`main` chỉ đọc `kind` sau khi step trả về: người báo tin đang bận làm đúng cái việc cần báo, nên
câu "Đang nhận diện..." chỉ tới nơi khi việc đã xong. Thứ hai, lúc ấy phán quyết cũng vừa tới, mà
§4.5.5h.1 lại tắt mọi hướng dẫn từ lúc có bất kỳ phán quyết nào — câu vừa bật đã bị chính phán
quyết dập. Đo trên board 18/09: **gần như không bao giờ thấy "Đang nhận diện..."**, màn nhảy thẳng
từ "Lại gần hơn" sang kết quả.

Nên cổng thứ tư đi bằng **bộ quan sát** của §4.5.5d — thứ vốn đã bắn ngay sau detect và trước hai
model chậm, chính là lý do nó tồn tại. `VisionPipeline` chấm ba phép kiểm hình học (có mặt,
`face_min_px`, ô 1,0× lọt khung) **trước** khi gọi bộ quan sát, rồi gửi kết quả kèm danh sách hộp.
`main` dịch nó sang `ui_kiosk_stage_t`; `svc_vision_kind_t` giữ đúng vai trò phán quyết nghiệp vụ
cho `svc_attendance`. Không tốn thêm một mili giây nào: ba phép kiểm ấy là số học thuần, và chúng
vốn đã chạy ngay sau đó. Bản 13/09 từng để màn tự so hộp mặt với
khung ngắm và báo `Đang nhận diện...` cho một khuôn mặt pipeline đang từ chối vì tràn khung — hai
câu trả lời cho một câu hỏi, và câu của màn sai. Khung ngắm vì thế là **hình vẽ tĩnh** quy từ cổng
`face_min_px` ra pixel panel, không phải một phép kiểm, và không đẻ thêm ngưỡng nghiệp vụ nào cho
§4.9.

**Bản đồ phủ mang chỉ số bảng màu cộng độ phủ, không mang màu.** Mỗi ô là một byte chia đôi:
4 bit thấp là chỉ số trong bảng màu dùng chung (0 = để lọt video), 4 bit cao là **độ phủ** 0–15.
`drv_lcd` tra `palette[idx]` rồi trộn theo độ phủ với cái đang nằm dưới. Ba điều đi ra từ cách
chia ấy. Thứ nhất, vòng gom dải đổi từ chuỗi bốn phép so sang **một phép tra bảng**, nên nó
*nhanh hơn* bảng bốn màu cứng chứ không đắt hơn. Thứ hai, số màu thôi bị trần bốn: bảng hiện
khai nền, mặt nổi, đường kẻ, mực, mực mờ, nhấn, đạt, cảnh báo, nguy hiểm và viền — đủ để một
màn hình có **nền và thẻ nổi** thay vì chỉ có nét vẽ trên video. Thứ ba, chữ **khử được răng
cưa**: bảng glyph 4bpp đưa thẳng độ phủ vào 4 bit cao.

Độ phủ 15 là đặc hoàn toàn và đi đường tắt không trộn; chỉ viền glyph mới trộn thật. Phần trong
nét chữ và mọi mảng đặc vì thế vẫn chỉ tốn một phép tra, và phép trộn RGB565 chỉ chạy trên
đúng những pixel ở rìa.

**Đỏ có mặt, và chỉ cho một việc.** Xoá một người là thao tác không lùi được, nên nó là chỗ
duy nhất dùng màu nguy hiểm. Từ chối chấm công vẫn nói bằng hổ phách cộng câu chữ: người bị
từ chối oan không đáng bị màn hình quát bằng màu đỏ (§4.5.5d, `kUnknownTries`).

**Đã trả lời rồi thì thôi hướng dẫn.** Mọi câu nhắc căn khung — `Đang nhận diện...`, `Lại gần
hơn`, `Lùi lại một chút` — đều tắt từ lúc có **bất kỳ** phán quyết nào, đạt hay từ chối, cho tới
khi **khuôn mặt ấy rời khung** hoặc pipeline bắt sang người khác (`Detecting`). Lý do như nhau:
§4.5.5d không xác thực lại một track đã khớp, và một track bị từ chối chỉ được thử lại theo nhịp
`kRetryDetects` của pipeline, nên bảo người ta "đang nhận diện" giữa hai lần thử là nói sai.

**Và luật ấy chỉ được thi hành ở một nơi: `svc_vision`.** Câu "đang nhận diện" là lời khẳng định
rằng có model đang chạy, mà chỉ pipeline biết điều đó. Cho màn hình tự suy ra từ việc *nó đã
nhận được phán quyết hay chưa* là dựng **nguồn sự thật thứ hai** cho cùng một sự kiện, và hai
nguồn thì sẽ lệch: pipeline đóng sổ một track bằng `matched_`, còn màn hình chỉ biết đóng sổ khi
có phán quyết **đi tới được nó**. Phán quyết ấy đi qua máy trạng thái chấm công, mà máy trạng
thái có quyền không đổi trạng thái — chống chấm trùng là đúng một ca như vậy. Khi đó pipeline đã
thôi nhìn khuôn mặt ấy trong khi màn hình vẫn nói nó đang nhìn, **và không có gì gỡ ra được**.

Nên bảng trạng thái mang thêm một giá trị: **`FACE_SETTLED`** — có mặt trong khung, và máy **đã
xong việc** với nó. Bất biến đi kèm, và nó là điều kiện đủ để câu "đang nhận diện" không bao giờ
treo: **`FACE_OK` chỉ được báo ở đúng những bước mà `may_verify()` cho đi tiếp.** Hễ pipeline
không định chạy model nào nữa trên track này thì nó nói `FACE_SETTLED`, và màn hình im lặng —
không hướng dẫn, không khẳng định. Màn hình không còn suy luận gì về việc máy có đang làm hay
không; nó chỉ chép lại.

**Chỉ phán quyết về một khuôn mặt mới được sửa lời trên dải dưới.** `main` giữ loại phán quyết
cuối để dịch sang câu chữ mỗi khi máy trạng thái đổi trạng thái, nhưng ba loại `NO_FACE`,
`FACE_SMALL`, `FACE_OUT_OF_FRAME` **không phải phán quyết** — chúng là hướng dẫn căn khung và đã
có kênh riêng là `ui_kiosk_stage_t`. Để chúng ghi đè thì lý do từ chối **tự xuống cấp thành câu
mơ hồ**: giơ ảnh giả cho máy nói "Ảnh giả, mời thử lại", rút ảnh ra là pipeline bắn `NO_FACE`,
rồi 2 giây sau `Denied → Cooldown` dịch `verdict_for(Cooldown, NO_FACE)` thành `APP_UI_DENIED` và
màn đổi sang "Chưa nhận được, thử lại" — thay một câu đúng bằng một câu không nói gì. Nên chỉ
`MATCH`, `UNKNOWN` và `SPOOF` được cập nhật loại phán quyết cuối; `APP_UI_DENIED` ở lại làm lưới
cho trạng thái không lường trước chứ không còn là đường đi bình thường.

**"Người khác" phải đi từ pipeline sang màn bằng một con số, không suy ra được từ một cờ.** Màn
chỉ nhận một `bool` "có mặt hay không", nên nó **không phân biệt được** khuôn mặt cũ còn đứng đó
với một khuôn mặt mới vừa thay chỗ. Hậu quả đo được: sau một lượt `SPOOF`, máy trạng thái hết
`Denied` 2 s cộng `Cooldown` 1,5 s rồi về `Idle`, nhưng dòng "Ảnh giả, mời thử lại" **vẫn nằm
nguyên trên kính chừng nào còn bất kỳ khuôn mặt nào trong khung** — kể cả mặt người kế tiếp, vốn
chưa hề bị từ chối. Nó chỉ chịu biến mất khi camera không thấy ai, mà ở kiosk thì người sau
thường bước vào trước khi người trước ra khỏi khung. Cộng thêm `kRetryDetects` = 3 lượt dò mà
người sau phải chờ khi họ đứng trùng chỗ người trước (IoU ≥ 0,5 là cùng một track, §4.5.5d), tổng
cộng khoảng 2,5 giây người mới đứng nhìn lời từ chối của người cũ.

`VisionPipeline` vì thế đánh **số hiệu track**, tăng đúng mỗi lần `follow()` mở một track mới, và
gửi kèm danh sách hộp mặt cho người quan sát. Màn `Scan` giữ dòng từ chối chừng nào số hiệu chưa
đổi, và xoá ngay khi nó đổi. Giữ nguyên được cả hai điều đang đúng: cùng một khuôn mặt thì lời
từ chối không nhấp nháy theo nhịp thử lại, còn người khác bước vào thì màn sạch ngay. Không đụng
tới `kRetryDetects`, tức không nới một chút nào cho ảnh giả giơ lì. Đo
trên board 14/09 khi chốt này chỉ áp cho câu đầu và chỉ cho phán quyết đạt: chấm xong đứng yên
thì màn nhảy sang câu căn khung ngay khi thẻ hết giờ; giơ ảnh giả đứng yên thì `Ảnh giả, mời
thử lại` và `Đang nhận diện...` **đảo nhau mỗi ~2 giây** theo nhịp thử lại (18/09). Vì thế dòng từ
chối **giữ trên kính khi khuôn mặt còn đó**, chỉ hạ khi mặt rời khung, khi có phán quyết mới, hay
khi máy bắt sang người khác; thẻ đạt giữ đồng hồ riêng 1,5 s để một khuôn mặt đã chấm đứng yên
không ghim thẻ mãi. Thẻ của người trước không bao giờ được hiện cho người sau: `Detecting` hạ nó.

**Câu chữ phải đọc được.** `svc_vision` đổi ý mỗi bước, nhanh hơn mắt, nên một câu nhắc giữ tối
thiểu **700 ms** trước khi câu khác thay; riêng "mất mặt" là tin ngay lập tức.

Ba thứ còn lại trên `Scan`: **thanh trên** mang giờ, ngày và dấu Wi-Fi; nút **ba gạch** góc phải
mở `Menu` — ba hình chữ nhật vẽ thẳng, vì bảng chữ 22 px chỉ có ASCII và tiếng Việt nên một ký
tự như `≡` sẽ ra ô trống; **dải dưới** mang kết quả (§4.5.5h). Không có gì che mặt người đang
đứng — mọi thứ nằm ở mép.

**Thẻ kết quả tắt khi *người tiếp theo được phục vụ*, không phải khi hết một đồng hồ.** Kiosk
đặt ở cửa thì phía sau luôn có người chờ, và 2,5 giây thẻ của người trước là 2,5 giây người sau
đứng nhìn kết quả không phải của mình. Máy chuyển sang phục vụ ai đó là một sự kiện đã có sẵn —
trạng thái `Detecting` — nhưng bản đầu **vứt nó đi** vì nó không phải một phán quyết. Nhận lấy
nó: nó hạ thẻ cũ xuống và mở lại phần hướng dẫn cho người mới. Đồng hồ 2,5 giây vẫn còn, nhưng
chỉ để lo trường hợp **không có ai phía sau**. Bản đầu có thêm một cửa sổ im lặng 6 giây chặn cùng một câu hiện lại, để một khuôn mặt
chưa đăng ký khỏi làm nó nhấp nháy. Nhưng cửa sổ ấy **dài hơn** thời gian hiện chữ, nên nó đẻ ra
đúng cái nó định chặn, chỉ chậm hơn: `Chưa có trong hệ thống` sáng 2,5 giây, **tắt 3,5 giây
trong lúc máy vẫn đang từ chối**, rồi sáng lại. Bỏ cửa sổ im lặng; thay bằng: cùng một câu đến
lại **trong lúc nó còn đang hiện** thì chỉ gia hạn đồng hồ chứ không dựng lại. Câu chữ vì thế
đứng yên suốt thời gian người ta còn bị từ chối, và tắt 2,5 giây sau khi họ đi.

Đồng hồ ấy đếm lùi theo **bước tick nguyên**, nên phép kiểm phải là "đã qua 0" chứ không phải
"bằng 0": chỉ cần đổi `UI_TICK_MS` sang một số không chia hết 2.500 là câu chữ **không bao giờ
tắt nữa**.

##### h.2) Màn `Capture` — đăng ký lấy nhiều mẫu, có vạch tiến trình

Máy thương mại lấy nhiều mẫu và hiện vạch phần trăm; người dùng biết còn phải đứng bao lâu.
`Capture` lấy **3 mẫu cách nhau ≥ 400 ms** (chính diện, hơi nghiêng trái, hơi nghiêng phải),
mỗi mẫu là một `template_idx`, và vẽ ba ô vuông sáng dần. Câu nhắc đổi theo mẫu đang chờ.
Bỏ dở giữa chừng thì những mẫu đã lấy **bị xoá**, vì một người chỉ có mẫu chính diện sẽ nhận
kém ở mọi tư thế khác và đó là lỗi khó truy sau này.

**Hai lượt quay đo từ chính hướng nhìn thẳng của người ấy, không đo từ số 0.** `yaw_of()` chiếu
độ lệch mũi lên trục hai mắt, nên số 0 của nó là "mũi nằm giữa hai mắt theo trục ấy" chứ không
phải "người này đang nhìn vào ống kính". Mặt không cân, camera gá hơi chéo, hay đầu hơi nghiêng
đều đẩy mốc đi. Đo 19/09 trên board, ba khung có nhãn "đang nhìn thẳng ống kính": **−0,01 ·
+0,10 · +0,10**, trung bình **+0,063**, trong khi `kFrontalYaw` = 0,10.

Ba khung ấy nói hai điều, và cả hai đều lớn so với `kTurnYaw` = 0,20: **mốc lệch ~+0,06** và
**nhiễu từng lần detect cỡ ±0,05**. Lệch mốc làm một bên quay phải đi xa hơn bên kia — xin
`yaw ≤ −0,20` là đi **0,27**, xin `yaw ≥ +0,20` là đi **0,13**. Nhiễu thì làm mọi phép so trên
một lần detect đơn lẻ thành tung đồng xu, **kể cả phép đo mốc**: lấy mốc bằng đúng một khung là
đổi một thiên lệch cố định lấy một thiên lệch ngẫu nhiên, lần này lệch trái, lần sau lệch phải.

Nên `Capture` dựng mốc bằng **trung bình**. Mọi lần detect trong suốt mẫu chính diện có
`|yaw| < kTurnYaw` đều cộng vào, `origin()` là trung bình cộng ấy. Dải ±0,20 rộng hơn hẳn phân
bố của một người đang nhìn thẳng nên không cắt cụt mẫu — cắt cụt ở ±`kFrontalYaw` mới là thứ kéo
trung bình lệch xuống — mà vẫn loại được một cú quay thật. Và mỗi lần detect đi qua một phép
**bỏ phiếu trung vị trên ba giá trị gần nhất** trước khi tới bất kỳ cổng nào, để một landmark
nhảy một khung không tự mình mở được cổng tư thế. `posed`, `gauge`, `astray` và cửa sổ gửi xuống
`svc_vision_enrol_next` đều đọc giá trị đã lọc và tính trên `yaw − origin()`.

Cửa sổ của **mẫu chính diện** cũng đặt quanh mốc ấy — `origin() ± kFrontalYaw` — chứ không quanh
số 0. Màn hình đã chốt người này đang nhìn thẳng; việc của pipeline chỉ là bắt đúng khung đó, mà
đưa nó một dải hẹp bằng đúng cổng của màn hình thì riêng nhiễu đã đủ làm rơi hết khung và mẫu
không bao giờ được lấy. Mốc sống qua cả ba mẫu và chỉ xoá khi **Thử lại**.

Cách này đúng kể cả khi mốc bằng 0: nó khử lệch của từng khuôn mặt và của từng lần gá camera,
chứ không phải đi bù một con số đo được một lần. Giới hạn còn lại đã biết: cổng chính diện vẫn
là một dải tuyệt đối `|yaw| < kFrontalYaw`, nên một người có độ lệch tự nhiên vượt 0,10 sẽ không
qua nổi mẫu đầu. Chưa gặp trên board, nhưng người đo 19/09 đã nằm sát vạch.

**Câu nhắc tư thế phải là điều kiện, không phải lời đề nghị.** Bản đầu chỉ đổi chữ rồi lấy
**khung verified kế tiếp bất kỳ**, cách nhau tối thiểu 400 ms — không có phép so nào kiểm mặt
có quay hay không. Đứng yên nhìn thẳng suốt cả ba lượt vẫn lấy đủ 3 mẫu và vẫn báo "Đã thêm",
mà thứ ghi xuống flash là **ba mẫu chính diện gần trùng nhau**. Đó đúng là lỗi đoạn trên vừa
mô tả, chỉ khác là nó đến qua đường chạy trọn vẹn chứ không qua đường huỷ giữa chừng.

**Đo góc quay ngang bằng chính 5 điểm mốc YuNet đã trả.** Không thêm model, không thêm phép
chạy: chiếu vectơ *mũi − trung điểm hai mắt* lên **trục hai mắt**, chia cho bình phương độ dài
trục ấy. Chọn phép chiếu chứ không lấy lệch ngang thuần, vì phép chiếu **không đổi khi đầu
nghiêng** — nghiêng đầu mà bị đọc thành quay là kiểu sai làm người dùng phát điên.

**Bẫy dấu, và nó đã sập một lần.** `hmirror` = 1 (§2.1) nên khung đã lật gương trước khi tới cả
model lẫn UI, vì thế dấu **không suy ra bằng lập luận mà phải đo**. Hằng số đặt tạm ban đầu là
`+1` cho "trái"; phép đo trên board 14/09 cho thấy **ngược lại**:

| Tư thế | min | trung vị | max |
|---|---|---|---|
| Nhìn thẳng | −0,035 | −0,017 | +0,051 |
| **Quay trái** | −0,532 | **−0,445** | −0,041 |
| **Quay phải** | +0,442 | **+0,613** | +0,692 |

Khoảng trống giữa hai nhóm rất rộng, nên ngưỡng đặt **rộng rãi về phía dễ**: chính diện trong
**±0,10** (đo được ±0,05) và coi là đã quay khi vượt **0,20** (đo được ≥ 0,44, tức chưa tới một
nửa). Chọn thế vì lỗi đắt ở đây là *quay đúng mà máy không nhận*, chứ không phải nhận hơi dễ.

Cách đo lại nếu đổi camera hoặc đổi `hmirror`: ghi log giá trị này ở `on_seen`, giữ một tư thế
25 giây cho mỗi chiều — nhịp `on_seen` bằng nhịp bước pipeline nên một tư thế thoáng qua chỉ cho
vài mẫu và không đủ kết luận.

**Năm luật giữ cho nó không thành cực hình.** Đây là phần quyết định việc này *xịn* hay *ức
chế*:

1. **Phản hồi sống, không phải đúng/sai.** Một vạch chỉ hướng đầy dần theo góc quay hiện tại.
   Người dùng thấy nó nhúc nhích theo đầu mình thì biết máy đang nghe; đứng đoán xem đã đủ chưa
   mới là thứ gây ức chế.
2. **Giữ 300 ms mới tính.** Quét nhanh qua đúng góc sẽ lấy phải khung nhoè. Giữ một nhịp ngắn
   vừa tránh nhoè vừa làm thao tác có cảm giác dứt khoát.
3. **Có trễ ở ngưỡng nhận**, cùng lý do §4.5.5h.1: điểm mốc rung thì vạch sẽ giật quanh biên.
4. **Quay nhầm bên thì nói ra** — "Quay ngược lại" — chứ không im lặng từ chối. Im lặng là lúc
   người dùng nghĩ máy hỏng.
5. **Không bao giờ nhốt người dùng.** Quá **6 giây** chưa đạt thì lấy **khung quay nhiều nhất
   đã thấy** rồi đi tiếp, không báo gì. Một mẫu hơi thiếu góc vẫn hơn một người bị kẹt ở màn
   đăng ký. Luật này đứng trên bốn luật kia.

Mẫu đầu cũng có điều kiện, ngược lại: **phải đủ chính diện**. Người bắt đầu ở tư thế đã quay mà
không bị chặn thì cả ba mẫu lại cùng một phía.

**Đăng ký thử chống giả trên mọi khung, nên một khung may mắn là đủ để lọt.** Lúc chấm công,
`may_verify()` chỉ mở đường xác thực **một lần cho mỗi vệt mặt**: `matched_` đóng nó lại, và một
phán quyết `SPOOF` phải đợi `kRetryDetects` lần dò nữa. Lúc đăng ký thì `enrol_id_ != 0` mở đường
ấy **trên mọi khung**, liên tục cho tới khi có một mẫu đậu. Bộ lọc chặn 95 % số khung đem thử vài
chục lần thì lọt gần như chắc chắn — đó là phép thử lặp, không phải model yếu, và nó biến lớp
chống giả mạnh nhất của hệ thành lớp yếu nhất đúng ở chỗ hậu quả nặng nhất.

Đo trên board 18/09: giơ ảnh giả trước màn đăng ký, máy từ chối một lúc rồi **vẫn ghi được một
mẫu**. Sau đó kẻ tấn công là người dùng hợp lệ và mọi lớp phía sau mất nghĩa.

Một chốt duy nhất: **`kEnrolSpoofTries` = 3**. Quá ba lần bị chấm giả trong một mẫu thì
`may_verify()` đóng đường xác thực cho tới hết mẫu, nên kẻ tấn công có đúng ba lượt chứ không phải
vô hạn, còn mặt thật đậu ngay lượt đầu và **không trả thêm một giây nào**. Chọn chặn số lượt thay
vì nâng riêng ngưỡng cho đăng ký, vì ngưỡng đã có nguồn duy nhất ở `vision.live_min` (§4.9) và
nâng nó sẽ kéo theo cả đường chấm công.

**Đã thử và loại: đòi nhiều khung liên tiếp vượt sàn.** Nghe hợp lý vì ảnh giả thỉnh thoảng vượt
còn mặt thật vượt liên tục, nhưng con số phải **nhân ra thời gian**: một khung xác thực đầy đủ mất
≈ 1,5 s (§4.5.5d), hạn mỗi mẫu là 15 s, và `follow()` đếm lại từ đầu mỗi khi hộp mặt lệch quá
IoU 0,5 — người đang quay đầu lấy mẫu 2 và 3 lệch liên tục. Đo trên board 18/09: chuỗi 5 khung
**không bao giờ xong**, chuỗi 2 khung vẫn treo ở mẫu quay. Bộ đếm lượt đủ dùng: ba lượt là quá ít
cho một phép thử lặp, và người vận hành thấy từng lượt trên màn (h.2 bên dưới).

Luật này đứng **trên** luật 5 của đoạn trên: hết giờ vì tư thế thì lấy khung quay nhiều nhất đã
thấy, nhưng hết giờ vì chống giả thì không lấy gì hết, kể cả khung tốt nhất đã thấy.

**Hai ngưỡng cho một tư thế: ngưỡng để bắt đầu và ngưỡng để giữ.** Màn hình chỉ xin mẫu khi góc
quay đã vượt **0,20** đúng phía và giữ 300 ms — đó là ngưỡng *bắt đầu*, và nó là của `ui_kiosk`.
Pipeline kiểm lại góc trên **đúng khung nó xác thực**, cách lúc xin tới 1,6 s, mà góc từ điểm mốc
nhiễu theo từng khung: cùng một cái đầu quay trái đo ra từ −0,041 tới −0,532 (bảng trên). Đặt cùng
0,20 cho phép kiểm lại là bắt một số nhiễu vượt ngưỡng lần nữa, và mỗi lần trượt tốn trọn một lượt
xác thực. Đo trên board 18/09: mẫu quay trái **năm lượt, 8 giây**, cả năm đều sống 0,98–0,99, bốn
lượt đầu bị chính phép kiểm góc gạt.

Nên ngưỡng *giữ* của pipeline chỉ hỏi một câu: mặt **còn ở đúng phía và chưa quay về chính diện**,
tức vượt dải ±0,10 (`kFrontalYaw`) về phía đã xin. Ai đã giữ 0,20 được 300 ms mà tụt về dưới 0,10
trong lượt kế là đã quay về nhìn thẳng thật, và khung đó **phải** bị gạt. Khi màn hình đã nới ngưỡng
bắt đầu xuống dưới 0,10 (luật 5, sau 6 giây) thì ngưỡng giữ theo xuống cùng, không thì màn xin một
tư thế mà pipeline không bao giờ chấp nhận.

**Đường đi của con số.** Góc quay tính ở `svc_vision`, nơi duy nhất biết ngữ nghĩa của điểm mốc,
rồi đi theo `svc_vision_box_t` ra ngoài — `main` chuyển tiếp cho `ui_kiosk` đúng như nó đang
chuyển hộp mặt, nên không có luật tầng nào bị phá (§4.5.4). `ui_kiosk` **chỉ vẽ**, không tự tính
tư thế từ toạ độ.

**Đăng ký đã đi qua cổng liveness, và đó là thứ tự bắt buộc.** `verify()` chấm liveness **trước**
`embed()`, nên một tấm ảnh giơ lên lúc đăng ký trả `SPOOF` và thoát sớm — không đường nào ghi
được mẫu vào bảng. Thứ tự ấy không được đảo: một mẫu giả nằm trong `svc_facedb` làm mọi lớp
chống giả phía sau thành vô nghĩa, vì từ đó trở đi kẻ tấn công là người dùng hợp lệ.

**Nhưng ảnh không có nhánh spoof thì đăng ký đang mở toang.** Khối kiểm nằm sau
`liveness_.available()`, nên `models_0` thiếu nhánh spoof là cả khối bị bỏ qua. Bên chấm công có
`attend.allow_no_spoof` và **mặc định từ chối** (quyết định 2 ở §4.5.5f); bên đăng ký không có
cổng tương đương, tức cùng một hoàn cảnh mà cửa thì khoá còn bảng mặt thì ai ghi cũng được.
**Dùng lại đúng khoá ấy, không đẻ khoá mới** (§4.9): nó trả lời đúng một câu — *kiosk này có
được phép hành động khi không có câu trả lời liveness không* — và mở cửa hay ghi mẫu đều là hành
động ấy. Cổng đặt ở **`main`**, nơi đã cầm chính sách và đã làm cầu nối giữa `ui_kiosk` và
`svc_vision`, nên `svc_vision` không phải biết một ngưỡng nghiệp vụ nào.

**Mẫu bị từ chối không được làm màn hình treo.** `Capture` hiện chỉ đi tiếp khi một mẫu **đậu**,
và bỏ qua hoàn toàn phán quyết đi kèm. Bị `SPOOF` liên tục thì màn đứng im **không giới hạn**,
không một dòng giải thích, lối ra duy nhất là nút "Huỷ". Hai luật:

- **Nói ra lý do, và mỗi lúc chỉ một câu.** `SPOOF`, `FACE_SMALL`, `FACE_OUT_OF_FRAME` dùng
  lại đúng chữ của §4.5.5h.1 chứ không đặt bộ chữ thứ hai. Thứ tự ưu tiên: **từ chối** > **căn
  khung** > **tư thế**. Một câu từ chối đang hiện thì câu nhắc tư thế và vạch chỉ hướng **ẩn đi**;
  "Ảnh giả" nằm trên "Quay nhẹ sang trái" là bảo người ta xoay tấm ảnh, và đó là thứ làm màn này
  trông ngớ ngẩn.
- **Từ chối đi theo đường riêng, có đếm.** Phán quyết chấm công đi qua bộ khử trùng của
  `ui_kiosk` (cùng một câu tới lần hai thì giữ chữ, không báo lại), nên lần từ chối thứ hai
  trở đi **không tới được** màn lấy mẫu — màn im trong khi pipeline vẫn đang từ chối. Vì thế
  `main` báo từ chối bằng `ui_kiosk_enrol_refused()`, đối xứng với `ui_kiosk_enrol_kept()`, và
  màn hiện **"Ảnh giả · lần 2/3"** để người vận hành biết còn mấy lượt.
- **Bỏ cuộc ngay khi hết lượt, không đợi đồng hồ.** Lần từ chối thứ `kEnrolSpoofTries` là màn
  chuyển sang thất bại **tức thì**: pipeline đã đóng đường xác thực ở đúng con số ấy, nên chờ thêm
  tới hạn 15 s là mười mấy giây đứng nhìn một câu nhắc tư thế vô nghĩa. Hạn 15 giây vẫn giữ cho
  trường hợp không có từ chối nào mà mẫu cũng không đậu (mặt rời khung, bảng không trả lời).
  Cả hai đường đều xoá những mẫu đã lấy đúng như đường huỷ, báo "Chưa lấy được mẫu" **kèm lý do
  gần nhất**, rồi chờ một lần chạm **"Đã hiểu"** mới về `Menu`. Chờ chạm chứ không hẹn giờ: câu báo lỗi mà tự biến mất thì người
  vận hành giơ ảnh giả bị chặn sẽ không biết vì sao và thử lại mãi, còn nút thì luôn có sẵn nên
  không ai bị nhốt. ⚠️ Khác hẳn luật 5 ở trên: hết giờ vì **tư thế** thì lấy khung tốt nhất đã
  thấy, còn hết giờ vì **liveness** thì **tuyệt đối không được lấy** — nhận đại một mẫu ở đây là
  tự tay ghi khuôn mặt giả vào bảng.

**Người thêm tại kiosk lấy mã số ở đâu.** Kiosk không có server để cấp mã, nên `main` hỏi
`svc_facedb_next_employee_id()` — **một hơn mã lớn nhất còn sống trong bảng** — đúng **một lần
cho cả ba mẫu**, ở mẫu đầu tiên. Màn `Capture` gửi mã **0** nghĩa là "người chưa có mã"; mã thật
do `main` điền, vì §4.5.4 luật 2 cấm `ui_kiosk` gọi thẳng `svc_facedb`. Gán cứng một mã cố định
thì người thứ hai **ghi đè cả ba mẫu** của người thứ nhất, vì `enroll()` thay bản ghi trùng
`(employee_id, template_idx)` — thấy trên board 13/09: thêm người thứ hai xong thì người thứ
nhất biến mất khỏi danh sách. Bảng đọc không được thì hàm trả 0 và luồng thêm người **dừng lại
có báo**, chứ không ghi vào mã của người khác.

**Lấy xong không tự đi đâu cả: người vận hành xác nhận rồi mới rời màn.** Mẫu thứ ba đậu thì
`Capture` hiện tên vừa thêm và một nút **"Xác nhận"**, đứng yên chờ. Chạm nút mới rời, và rời về
**`Menu`** chứ không về `Scan`. Ba lý do, xếp theo sức nặng:

1. **Thêm người là thao tác của người vận hành, không phải của người đi chấm công.** Họ đang
   đứng tại máy và thường làm tiếp: thêm người nữa, hoặc mở `People` soi lại danh sách. Trả họ về
   màn nhận diện là bắt đi lại từ đầu qua `Menu` cho mỗi việc kế tiếp.
2. **Câu xác nhận không được biến mất theo đồng hồ.** Hẹn giờ rồi tự chuyển nghĩa là ai ngẩng lên
   muộn vài giây sẽ không bao giờ biết máy đã ghi tên gì, hay đã ghi chưa.
3. **Một lần chạm là một lần người thật xác nhận.** Đây là thao tác ghi vào bảng khuôn mặt, thứ
   mọi lớp chống giả phía sau dựa vào; kết thúc nó bằng một hành động có chủ ý rẻ hơn nhiều so với
   một bản ghi sai không ai để ý.

Đường **thất bại** cũng dừng lại chờ chạm, nhưng bằng nút **"Đã hiểu"** và kèm lý do: nó mang
thông tin người vận hành cần để quyết định làm gì tiếp, mà một câu chạy qua trong hai giây thì
không mang được gì cả.

**Hướng sắp tới của mã số, chưa làm.** Mã sẽ do server cấp: người quản trị tạo hồ sơ trên hệ
thống trước, kiosk nhập mã ấy rồi mới lấy mẫu, nên `(employee_id, template_idx)` trên thiết bị
khớp thẳng với hồ sơ trên server và không còn phụ thuộc vào bảng cục bộ. Tới lúc đó
`svc_facedb_next_employee_id()` chỉ còn là đường lùi khi mất mạng. Hiện tại giữ nguyên cách cấp
mã cục bộ ở trên.

##### h.3) Màn `People` — xoá người bằng hai lần chạm, không bằng hộp thoại

Thêm được thì phải xoá được, nếu không một lần gõ nhầm tên là vĩnh viễn. `People` liệt kê mỗi
người một dòng (tên và số mẫu); **chạm một dòng** làm nó chuyển hổ phách và hiện `Xoá?`, **chạm
lại chính dòng ấy** mới xoá, chạm chỗ khác thì thôi. Hai lần chạm thay cho một hộp thoại xác
nhận: hộp thoại cần thêm một màn, thêm một đường quay lui, và trên màn 320 px thì nút của nó
nhỏ hơn chính cái dòng vừa chạm.

Việc xoá đi qua `main` như danh sách, vì §4.5.4 luật 2 cấm `ui_kiosk` gọi `svc_facedb`:
`ui_kiosk_take_remove()` trả mã số, `main` gọi `svc_facedb_remove()` rồi `svc_facedb_persist()`
rồi nạp lại danh sách. `persist()` mất **1,8–2,3 s** (§6.2.4) và `ui_task` không đăng ký
watchdog nên nó chỉ đứng màn chừng ấy, không panic — nhưng dòng `Đang xoá…` phải được **vẽ
xong trước** khi `main` chặn, nên `ui_kiosk_tick()` đứng trước phần lấy yêu cầu trong vòng lặp
của `ui_task`, không phải sau.

**Hộp mặt trên preview bám theo khung hình, không bám theo nhịp detect.** Detect ra hộp 3–4 lần/giây và im hẳn 0,93 s trong lúc spoof + recog chạy (§4.5.5d); vẽ hộp theo nhịp đó là hộp khựng. `BoxTracker` (`src/box_tracker.cpp`) nhận hộp mới từ `svc_vision`, lấy một mẫu độ sáng **24×24 điểm bám** dưới tâm hộp — mỗi điểm bám là một pixel khung lấy cách 2 (nửa độ phân giải), tức mẫu phủ 48×48 px khung — rồi trên mỗi khung preview (core 0) đổi cửa sổ 56×56 điểm bám quanh vị trí cũ sang độ sáng một lần, quét **thô rồi tinh** trong bán kính ±16 điểm bám (**±32 px khung**) bằng tổng sai tuyệt đối trên 576 điểm: 17×17 = 289 vị trí cách nhau 2 điểm bám, rồi 3×3 vị trí sát quanh chỗ thắng — **298 phép so, đúng bằng số phép so của lưới dày cũ mà phủ gấp bốn diện tích**. Mỗi phép so **bỏ dở ngay giữa chừng** khi tổng đã vượt chỗ tốt nhất đang giữ, và phần lớn vị trí vượt ngay từ vài hàng đầu. Ba luật giữ nó không nói dối: chỉ dịch khi khớp **tốt hơn đứng yên**; sai lệch trung bình trên 48 mức/điểm là mất dấu, hộp đứng lại; mẫu phẳng (độ tương phản dưới 24 mức) không bám. Hộp mới từ detect **thay thế** hộp đang bám, nên sai số không tích luỹ quá một chu kỳ detect. **Đo trên board 13/09, không phải 1–2 ms như ước lượng cũ**: nối bộ bám vào `cam_task` kéo preview **13,2 → 9,5 fps**, tức ~29 ms mỗi khung ở profile `dev` (`-Og`). Thoát sớm trong phép so đưa về **11,2–12,9 fps**. Bài học: lưới 289 vị trí × 576 điểm là 166 nghìn phép trừ mỗi khung, và ước lượng 1–2 ms cho ngần ấy việc ở `-Og` là sai một bậc. Bộ bám không phát hiện mặt mới và không đưa gì về đường model: nó chỉ là cách mắt không thấy giật mà kết quả chấm công không chậm thêm một mili giây nào. Kết quả chấm công vẽ đè lên khung preview trong cùng đường này, không qua LVGL cho vùng preview.

```
components/ui_kiosk/
├── include/ui_kiosk.h                    # mặt tiền C: init · on_faces · on_verdict · on_touch · tick · overlay
├── priv_include/box_tracker.hpp          # BoxTracker: set(hộp, khung) · update(khung) · box()
├── priv_include/canvas.hpp               # Canvas: bản đồ phủ 1 byte/điểm, hình + chữ + vùng đã vẽ
├── priv_include/theme.hpp                # bảng màu · thang chữ · nấc giãn cách · phép xếp dọc
├── priv_include/widgets.hpp              # nút · dòng · thanh trượt · công tắc · biểu tượng
├── priv_include/screens.hpp              # Screen base + ScreenManager + 8 màn hình
├── priv_include/strings.hpp              # StrId + ui::text() — catalogue Việt/Anh
├── src/box_tracker.cpp
├── src/canvas.cpp
├── src/theme.cpp
├── src/strings.cpp                       # bảng [ngôn ngữ][StrId], nằm trong flash
├── src/widgets.cpp
├── src/screens.cpp                       # Scan · Menu · Enrol · Capture · People · Settings · Wifi · Device
├── src/ui_kiosk.cpp                      # hai ô canvas, hai ô overlay, công bố nguyên tử
└── test_apps/tracker/{main/test_tracker.cpp, CMakeLists.txt, pytest_tracker.py}   # khung tổng hợp, không cần camera
```

**Overlay là dữ liệu, không phải lời gọi vẽ.** `ui_kiosk` (L6) không được gọi xuống `cam_task`
và `drv_lcd` (L2) không được biết màn hình nào đang hiện, nên cái đi giữa hai bên là một struct
phẳng khai ở `drv_lcd.h`: vài **hộp rỗng** (hộp mặt) và vài **ô đặc** kèm con trỏ pixel RGB565
(thẻ thông báo). `drv_lcd_blit_frame` cắt chúng theo từng dải 20 dòng ngay trong vòng gom, nên
overlay đi cùng chuyến với preview chứ không phải một lượt ghi panel thứ hai. Pixel của ô đặc
phải nằm sẵn **theo thứ tự byte của panel** — đường preview không đảo byte, vì khung camera đã
đúng chiều rồi.

`ui_kiosk` giữ **hai ô overlay** và công bố bằng một phép ghi con trỏ nguyên tử: nó chỉ điền vào
ô đang không được công bố rồi mới đổi con trỏ, `cam_task` đọc con trỏ một lần cho cả khung. Không
khoá nào trên đường vẽ, và cái giá đúng bằng **một khung chậm** ở lần đổi thẻ.

##### h.4) Màn `Settings` — trang chỉnh, và là chỗ duy nhất đi vào Wi-Fi

**Menu gốc chỉ mang việc, không mang thiết bị.** Nó có đúng ba dòng — *Thêm người*, *Danh sách*,
*Cài đặt* — vì ba dòng ấy là ba thứ người vận hành mở ra để **làm một việc**. Wi-Fi không phải
một việc, nó là một thuộc tính của máy, nên nó nằm **trong** Cài đặt như mọi điện thoại đặt nó,
không phải một dòng ngang hàng ở menu gốc. Luật chung: cái gì trả lời *"máy đang thế nào"* thì
vào Cài đặt; cái gì trả lời *"tôi muốn làm gì"* mới được đứng ở menu gốc.

**Trang Cài đặt là những thẻ nhóm, không phải một danh sách trơ.** Nền xám nhạt, mỗi nhóm là
một **thẻ trắng bo góc** nổi trên nền ấy, các nhóm cách nhau một khoảng. Đó là cách mọi hệ
điều hành điện thoại xếp trang này, và nó có lý do: mắt đọc bốn nhóm ba dòng nhanh hơn đọc một
cột mười hai dòng, vì khoảng trắng giữa hai thẻ đã làm sẵn việc phân loại.

Mỗi dòng có đúng bốn phần, trái sang phải: **ô biểu tượng vuông bo góc** mang màu riêng của
nhóm, **nhãn**, **giá trị** màu xám, và **mũi tên `>`** khi dòng ấy mở ra một trang. Giá trị
xám là thứ trả lời câu hỏi mà không bắt người ta chạm vào: dòng Wi-Fi hiện luôn tên mạng đang
nối, nên phần lớn lần mở Cài đặt kết thúc ngay ở đó.

| Thẻ | Dòng | Kiểu | Nguồn |
|---|---|---|---|
| Máy | `Ngôn ngữ` / `Language` | công tắc hai nấc `VI` · `EN` | `ui/lang` (§6.2.1) → `ui_kiosk_set_language()` |
| | `Thiết bị của tôi` | mở trang | màn `Device` |
| Mạng | `Wi-Fi` | mở trang, giá trị = tên mạng đang nối | `net_wifi` qua `main` |
| Màn hình và âm thanh | `Độ sáng` | thanh trượt | `ui/brightness` (§6.2.1) → `drv_lcd_backlight` |
| | `Âm lượng` | thanh trượt | `ui/volume` (§6.2.1) → `drv_audio_set_volume` |

**Dòng ngôn ngữ đứng đầu thẻ đầu, và thứ nhận ra được là hai nấc `VI` · `EN`, không phải nhãn.**
Người cần đổi ngôn ngữ là người **không đọc được ngôn ngữ đang hiện**, nên quy tắc xếp trang
thông thường — "ít dùng thì để dưới" — đảo dấu ở đúng dòng này: nó phải tìm thấy được mà không
cần đọc gì. Hai mã hai chữ cái làm việc ấy; nhãn thì đi qua catalogue như mọi dòng khác.

Nhãn **không** mang cả hai thứ tiếng, vì ô chứa nó không đủ rộng: một dòng cài đặt chừa 200 px
cho nhãn cộng giá trị, công tắc chiếm 76 px, nên nhãn còn 110 px — đo trên chính bảng advance
đã sinh thì `Ngôn ngữ` là 93 px và `Language` là 92 px, đều lọt, còn `Ngôn ngữ / Language` là
**205 px** và sẽ bị cắt thành `Ngôn ng…`. Đây là ví dụ đúng của luật ngay dưới: chọn từ ngắn
hơn lúc viết catalogue, không nới ô.

**Catalogue là một bảng hằng trong flash, không phải file nạp lúc chạy.** `strings.cpp` khai
`const char *const table[Lang::Count][StrId::Count]`, tức mọi chuỗi nằm ở `.rodata` và đổi ngôn
ngữ chỉ là đổi một chỉ số — không cấp phát, không đọc flash qua SPI1, nên `ui_task` gọi được
trong chính vòng vẽ (§5.1 cấm đọc flash ở đó). Giá phải trả đo trên `strings.cpp.obj` là
**2.685 B** flash cho 57 chuỗi hai thứ tiếng, rẻ hơn nhiều so với một phân vùng asset và một
đường nạp.

**Bảng phải đủ và phải đúng thứ tự, và trình biên dịch nói điều đó chứ không phải người đọc.**
`strings.cpp` chốt hai `static_assert`: số dòng bằng `StrId::Count`, và dòng thứ `i` mang đúng
`StrId` thứ `i`. Thiếu một chuỗi là không biên dịch được; xếp nhầm chỗ một dòng cũng vậy. Đó là
cách §3.1 luật 1 của `CLAUDE.md` được thi hành ở phía firmware, tương ứng với `tsc` ở phía
dashboard.

**Không sinh lại font khi thêm tiếng Anh.** `gen_font.py` đã rasterise trọn ASCII 0x20–0x7E,
mà tiếng Anh không dùng ký tự nào ngoài dải đó, nên bốn bảng glyph giữ nguyên từng byte. Luật
kèm theo: **chuỗi tiếng Anh không được mang ký tự ngoài ASCII cộng `·…°`** — một dấu gạch dài
hay dấu nháy cong sẽ lặng lẽ biến mất khỏi màn hình chứ không báo lỗi.

**Câu tiếng Anh dài hơn thì bị cắt, không làm vỡ hàng.** `Canvas::text()` đã cắt bằng `…` ở
`max_w`, nên rủi ro duy nhất là một nhãn cụt nghĩa — thứ phải xử lý bằng cách chọn từ ngắn hơn
lúc viết catalogue, không phải bằng cách nới ô.

**Thông tin máy là một trang riêng, không phải mấy dòng nhét cuối trang Cài đặt.** Phiên bản
firmware, mã máy, số người trong bảng, số bản ghi chờ gửi, RAM còn — người ta tìm chúng đúng
một lần mỗi vài tháng, lúc có sự cố. Để chúng nằm thường trực dưới hai thanh trượt là bắt mọi
lần chỉnh độ sáng phải cuộn qua một bảng số không ai đang cần. Màn `Device` giữ chúng, và
dòng *Thiết bị của tôi* là đường vào.

**Thanh trượt ghi NVS khi thả tay, không khi kéo.** Kéo một thanh trượt sinh vài chục lần chạm;
ghi NVS mỗi lần là ghi flash theo nhịp ngón tay, đúng thứ §6 cấm. Nên phần cứng nghe **ngay** ở
mỗi lần chạm — đèn nền và âm lượng đổi tức thì để người ta thấy mình đang chỉnh cái gì — còn NVS
chỉ nhận **một** phép ghi lúc ngón tay rời màn.

Dòng trạng thái vẫn do `main` điền qua `ui_kiosk_set_settings()` từ những gì nó với tới được
**mà không đọc flash**: đọc flash qua SPI1 là tắt cache và ngắt trên cả hai lõi (§5.1).
`ui_kiosk` chỉ hiện chữ và trả về con số người dùng vặn; nó không gọi tầng dịch vụ nào và không
chạm NVS (§4.5.4 luật 2) — `main` cầm cả hai đầu ấy.

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
| `svc_sync` | `UplinkQueue`, `IPersist`, `ILink` | Composition | Thay LittleFS **và** broker bằng fake khi test: luật "con trỏ đi sau ack" của §6.2.6 chỉ kiểm được khi ép được cả hai bên trả lỗi |
| `ui_kiosk` | `Screen` → 6 lớp con, `ScreenManager`, `BoxTracker` | Kế thừa; bộ bám là giá trị thuần | Sáu màn hình cùng vòng đời; hộp mặt theo khung hình, không theo nhịp detect |

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
│   │   ├── ops.cpp                        # MicroMutableOpResolver<10>, đếm trên graph thật; LOGISTIC + MEAN cho khối SE nhập
│   │   └── preproc.cpp                    # crop 2,7× + resize về cạnh graph khai (80 hoặc 81)
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
├── Dockerfile                        # multi-stage: build → node:24-alpine
├── .env.example                      # ✅ commit — mọi biến, giá trị giả
├── .env                              # ❌ gitignore — giá trị thật, không bao giờ commit
├── package.json  ├── tsconfig.json  ├── tsconfig.build.json  ├── nest-cli.json
├── prisma.config.ts                  # ★ url của datasource + lệnh seed (Prisma 7)
├── prisma/{schema.prisma, migrations/, seed.ts}
├── test/*.e2e-spec.ts                # e2e, chạy bằng runner sẵn có của Node
└── src/
    ├── main.ts                       # chỉ mở cổng; mọi cấu hình nằm ở bootstrap.ts
    ├── bootstrap.ts                  # ★ helmet, CORS, cookie, ValidationPipe, Swagger
    ├── app.module.ts
    ├── config/
    │   ├── env.schema.ts             # ★ zod — NƠI DUY NHẤT đọc process.env (§4.4)
    │   └── configuration.ts          # ConfigModule.forRoot, validate lúc boot
    ├── common/
    │   ├── generated/                # ★ sinh từ contracts/schema — commit, KHÔNG sửa tay
    │   ├── guards/{jwt-auth.guard.ts, roles.guard.ts, device-auth.guard.ts}
    │   ├── cache/{cache.module.ts, cache.service.ts, cache-keys.ts}
    │   ├── decorators/  ├── interceptors/  ├── filters/  ├── dto/
    │   └── csv.ts                    # ★ một bộ ghi CSV cho cả ba nơi xuất file
    ├── modules/
    │   ├── auth/     └── strategies/{jwt.strategy.ts, jwt-refresh.strategy.ts, device.strategy.ts}
    │   ├── users/    ├── employees/  ├── devices/   ├── enrollment/
    │   ├── attendance/ ├── shifts/   ├── reports/   ├── models/
    │   ├── mqtt/     ├── realtime/
    │   ├── audit/audit-actions.ts    # ★ §9.24 — tên hành động, khai một chỗ
    │   │                             # ── §9 quản trị nhân sự ──
    │   ├── org/                      # Department (cây), JobTitle, hợp đồng
    │   ├── leave/                    # loại phép, số dư, đơn, luồng duyệt
    │   ├── payroll/                  # kỳ lương, lượt chạy, phiếu, dòng phiếu
    │   ├── compensation/             # lương theo thời hạn, người phụ thuộc
    │   ├── policy/                   # PayrollPolicy + TaxBracket theo ngày hiệu lực
    │   ├── timesheet/                # AttendanceDay: từ lượt quẹt thành ngày công
    │   ├── search/                   # ★ §9.20 — một ô ra người, phòng ban, đơn, phiếu
    │   ├── notifications/            # ★ §9.21.4 — bốn loại, ba kênh, mỗi loại tắt riêng
    │   ├── assets/                   # ★ §9.16 mục 11 — cấp và thu là dòng, không phải ô
    │   └── onboarding/               # ★ §9.16 mục 10 — mẫu theo chức danh, sinh ra bản thể hiện
    ├── queue/
    │   ├── queue.module.ts           # BullMQ, dùng chung kết nối Redis với cache
    │   ├── queues.ts                 # ★ tên hàng đợi + kiểu job, khai một chỗ
    │   └── processors/{image, report, notify, timesheet, payroll}.processor.ts
    └── database/{database.module.ts, prisma.service.ts, redis.service.ts}
```

**Khối này là ESM, không phải CommonJS.** NestJS 12 phát hành `"type": "module"` và không còn
bản CommonJS nào, nên `backend/package.json` cũng phải khai `"type": "module"`. Hệ quả chạm vào
mọi file: import tương đối phải mang đuôi `.js` kể cả khi nguồn là `.ts`, và bộ sinh của
`contracts/` phát đúng dạng ấy. TypeScript ghim ở 6.x vì `ts-jest` chặn trên ở `<7`.

**Cấu hình ứng dụng nằm ở `bootstrap.ts`, không ở `main.ts`.** `main.ts` chạy ngay khi được
nhập, nên một bộ test muốn dựng ứng dụng thật buộc phải dựng lại cấu hình bằng tay — và bản
dựng lại ấy **âm thầm khác bản thật**: thiếu Swagger, thiếu helmet, thiếu đúng một tuỳ chọn nào
đó, rồi test xanh cho một ứng dụng không ai chạy. Một hàm nhận `INestApplication` và gắn đủ mọi
thứ lên nó thì `main.ts` gọi được mà bộ test cũng gọi được, và cái chạy trong test **là cái
chạy trên máy chủ**.

**E2E chạy bằng `node --test`, không phải Jest.** Jest nạp module ESM qua registry riêng của
nó, và `@nestjs/throttler` là CommonJS `require()` vào `@nestjs/common` vốn là ESM — Jest gọi đó
là vòng `require(esm)` và từ chối, trong khi Node chạy được từ v22. Runner của Node không có
tầng ấy. Đổi lại nó **không tự biên dịch TypeScript**: `tsx` dùng esbuild mà esbuild không phát
`emitDecoratorMetadata`, thứ DI của Nest dựa vào để đọc kiểu tham số constructor, nên bộ test
được `tsc` biên dịch ra `dist-test/` rồi mới chạy. Chậm hơn một nhịp biên dịch, đổi lấy việc
**thứ đem ra chạy là thứ trình biên dịch thật sự phát ra**, không phải một bản dịch thứ hai.

**Prisma 7 tách url ra khỏi `schema.prisma`.** Khối `datasource` chỉ còn khai `provider`; chuỗi
kết nối nằm ở `prisma.config.ts`, và `PrismaClient` nhận một driver adapter (`@prisma/adapter-pg`)
thay vì tự mở kết nối. `prisma.config.ts` với `prisma/seed.ts` là **hai tiến trình CLI riêng**,
không bao giờ khởi động Nest, nên chúng tự nạp `.env` — ngoại lệ duy nhất của luật một cửa ở
§4.9. `seed.ts` vẫn gọi `validateEnv()`; `prisma.config.ts` chỉ cần đúng một biến và lấy nó
bằng helper `env()` của chính Prisma, vì file ấy được CLI nạp trước khi mã của khối chạy.

**`search/` là module riêng vì nó cắt ngang, không thuộc về ai.** Nó đọc `Employee`,
`Department`, `Request` và `Payslip`; nhét nó vào `employees/` là bắt module nhân viên biết về
bảng lương, còn chia thành bốn endpoint tìm kiếm là bắt giao diện gọi bốn lần rồi tự ghép. Một
module chỉ đọc, **không sở hữu bảng nào**, và mọi truy vấn của nó đi qua `ScopeService` đúng như
các module khác — tìm kiếm là đường rò rỉ dữ liệu dễ quên nhất, vì nó trả về mẩu thông tin chứ
không trả về bản ghi đầy đủ.

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
| `User` | id, email, passwordHash, role(`ADMIN`/`HR`/`VIEWER`), employeeId, active |
| `Session` | id, userId, tokenHash(unique, băm `jti`), userAgent, ip, lastSeenAt, expiresAt, revokedAt — một dòng mỗi thiết bị (§9.23 luật 5) |
| `Employee` | id, code, fullName, department, active, embeddingVersion |
| `FaceTemplate` | id, employeeId, templateIdx, embedding(`Bytes` int8[512], mã hoá lúc lưu), scale(Float), quality, capturedAt |
| `Device` | id, serial, name, location, status(`PENDING`/`APPROVED`/`REVOKED`), tokenHash, fwVersion, modelVersion, rosterVersion, lastSeenAt, online |
| `DeviceEnrollment` | deviceId, employeeId, state(`ASSIGNED`/`ENROLLED`/`REVOKED`), templateIdx, updatedAt |
| `DeviceCommand` | cmdId(uuid), deviceId, type, payload(json), issuedBy, expiresAt, state, resultNote |
| `DeviceEvent` | id, deviceId, type, severity, employeeId, livenessScore, cmdId, note, ts |
| `AttendanceRecord` | id, localId(unique per device), employeeId, deviceId, ts, direction(`IN`/`OUT`), score, livenessScore, doorOpened, capturedOffline, clockUnsynced, photoUrl |
| `Shift` / `ShiftAssignment` | startTime, endTime, graceMinutes |
| `Release` | releaseId(uuid), target(`FIRMWARE`/`MODELS`/`ASSETS`), version, url, sha256, sizeBytes, minFwVersion, runId, rolloutState |
| `AuditLog` | actorId, action(từ `audit-actions.ts`), subjectType, subjectId, meta(json), ts — §9.24 |

Mười hai bảng. `AttendanceRecord.localId` là khoá chống trùng cho cơ chế at-least-once của
kiosk — unique index `(deviceId, localId)`.

**`Device.status` tồn tại vì §7.3 trả hai mã khác nhau cho cùng một lời gọi.**
`POST /devices/register` trả 202 khi máy còn `PENDING` và 200 khi đã duyệt, nên trạng thái ấy
phải là một cột chứ không suy ra từ chỗ `tokenHash` có rỗng hay không: một máy bị thu hồi cũng
có `tokenHash` rỗng mà ý nghĩa ngược hẳn.

**`Device.rosterVersion` là nửa server của con trỏ hội tụ.** Máy khai số của nó trong mọi
`heartbeat`; server so với số mình giữ rồi đẩy đúng phần còn thiếu (§7.5). Không lưu thì mỗi
lần một máy nối lại đều phải đẩy toàn bộ danh sách.

**`DeviceEnrollment` là một dòng cho mỗi cặp `(employeeId, deviceId)`, không phải một cờ trên
`Employee`.** Một fleet năm kiosk thì "đã thêm" không trả lời được câu "thêm ở đâu", và `ASSIGN`
của §7.5 cần chỗ đứng trước khi có template: máy hiện danh sách chờ từ chính các dòng `ASSIGNED`.

**`DeviceCommand` giữ lệnh đã gửi để kết quả có chỗ nối vào.** `down/cmd` mang `cmdId`, kết quả
quay về `up/event` kèm đúng `cmdId`. Không lưu lệnh thì kết quả là một dòng mồ côi, và câu hỏi
"ai bấm mở cửa lúc chín giờ, lệnh có chạy không" không có nơi nào trả lời.

**`DeviceEvent` tách khỏi `AuditLog` vì hai bảng trả lời hai câu khác nhau.** `AuditLog` ghi việc
**người** làm nên luôn có `actorId`; `up/event` là việc **máy** gặp — `CAMERA_FAULT`,
`STORAGE_FAULT` — và không có actor nào. Trộn chung là đẻ ra một cột `actorId` rỗng ở phân nửa
số dòng, rồi mọi truy vấn phải nhớ lọc nó.

**`Release` mang cả firmware lẫn model vì `ota_manifest.schema.json` có `target` ba giá trị.**
Một bảng riêng cho model thì bản firmware không có chỗ đứng, trong khi hai thứ đi chung đúng một
luồng phát hành và đúng một bản kê khai. `minFwVersion` nằm ở đây vì nó là thuộc tính của bản
phát hành, không phải của thiết bị nhận.

**`FaceTemplate.embedding` là dữ liệu sinh trắc: mã hoá lúc lưu, không bao giờ nằm trong DTO đọc
thường** (§7.5). `templateIdx` đi kèm vì khoá nghiệp vụ là `(employeeId, templateIdx)`, và
`enroll_payload.schema.json` đã mang trường ấy sẵn.

**Ba cờ của `AttendanceRecord` là lời khai của máy về hoàn cảnh, không phải trạng thái đồng bộ.**
`attendance_record.schema.json` gửi lên `doorOpened`, `capturedOffline` và `clockUnsynced`; giữ
cả ba vì mỗi cái trả lời một câu mà cột khác không trả lời được. `clockUnsynced` là cái đắt nhất:
nó nói **dấu thời gian của chính bản ghi ấy không dựa trên NTP** — máy vừa mất điện, pin RTC cạn —
nên một bảng công không đánh dấu nó là một bảng công sai giờ mà không ai biết. Một cột "đã đồng
bộ" thì ngược lại là vô nghĩa ở phía máy chủ: bản ghi nằm trong bảng nghĩa là nó đã tới.

**Thiết bị lạ gặp trên broker được ghi ở `PENDING`.** §7.3 giao việc tạo dòng `Device` cho
`POST /devices/register`, nhưng đường ấy là E13-T9; tới lúc đó một kiosk có credential vẫn phát
lên topic của nó. Máy chủ vì thế tạo dòng ở trạng thái `PENDING` ngay lần đầu thấy — **đúng trạng
thái §7.3 muốn cho một máy chưa ai nhận**, chỉ đến bằng cửa khác — thay vì vứt bản ghi vì khoá
ngoại. Khi E13-T9 tồn tại thì HTTPS là cửa chính, còn cửa này là lưới an toàn.

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

**`heartbeat` dựng ở tầng nối dây, không ở component nào.** Payload của nó gom số từ khắp nơi:
`fwVersion` ở `esp_app_format`, `rssiDbm` ở `net_wifi`, `bootCount` với `activeSlot` ở
`sys_storage`, ba số heap ở bộ cấp phát, `pendingUplinkCount` ở log chấm công. Không component
nào thấy đủ chừng ấy, và §4.5.4 cấm với ngang hoặc với lên — nên **`main` (L7) dựng payload**,
đúng chỗ duy nhất nhìn được cả hệ.

**Và `sync_task` mang nó, không đẻ task mới.** Một nhịp 30 giây không đáng một task: task rẻ
nhất cũng tốn 4–5 KB RAM nội, mà §6.4 đo còn 17.396 B liền. `sync_task` vốn đã thức mỗi 5 s ở
ưu tiên 2 và đã là đường lên của thiết bị; thêm một phép chia thời gian vào vòng lặp của nó là
xong. Chu kỳ đọc từ `GEN_TOPIC_HEARTBEAT_INTERVAL_S` do `mqtt_topics.yaml` sinh ra, không gõ
lại vào code (§4.9).

**QoS 0 nhưng retained — hai lựa chọn ngược nhau và cả hai đều có lý.** QoS 0 vì một nhịp rơi
sẽ có nhịp khác sau 30 giây: trả giá ack cho một mẫu sắp hết hạn là phí. Retained vì một
subscriber nối muộn cần biết **trạng thái hiện tại ngay**, chứ không phải đợi tới 30 giây mới
biết kiosk còn sống. Hai thuộc tính trả lời hai câu hỏi khác nhau.

**`pendingUplinkCount` là trường đáng giá nhất trong đó.** `status` = `online` chỉ nói kiosk
đang nối; nó không phân biệt được máy đang theo kịp với máy **đang tụt lại**. Một kiosk
`online` mà tồn 900 bản ghi là máy có vấn đề, và không trường nào khác trong heartbeat nhìn
thấy điều đó. Đếm bằng **kích thước file**, không đọc bản ghi: log là lưới 48 B cố định sau
header 32 B và xoay vòng ở 256 KB, nên một `stat` mỗi file là đủ — vài chục lần `stat` mỗi 30
giây, không phải vài trăm lần đọc.

**`modelVersion` có đường lui.** §6.2.1 giao nó cho `nvs model/version`, mà khoá ấy chỉ được
đặt khi OTA model A/B (E13-T2) tồn tại. Chưa có thì heartbeat mang **crc32 của header ảnh
`models_0`** — trường ấy phủ cả ba `sha256` của ba model nên nó đổi khi bất kỳ model nào đổi.
Một chuỗi rỗng nói dối nhiều hơn một digest: backend cần biết máy đang chạy bộ model nào, và
câu trả lời ấy luôn có sẵn trên chính thiết bị.

**`down/cmd` — ba luật, và cả ba đều vì QoS 1 là "ít nhất một lần".** Broker được phép giao
lại một gói đã giao, nên **lệnh trùng là chuyện bình thường, không phải tấn công**. Kiosk giữ
vòng 8 `cmdId` gần nhất và **bỏ im lặng** cái nào đã chạy; `expiresAt` quá hạn thì từ chối, vì
một `OPEN_DOOR` kẹt trong hàng đợi broker nửa tiếng rồi mới tới là cánh cửa mở cho người đã đi
khỏi.

**Nhưng `expiresAt` bị bỏ qua khi đồng hồ không đáng tin.** `sys_time_source()` nói giờ có từng
được NTP đặt hay không (§6.2.5); chưa thì phép so sánh thời hạn vô nghĩa. Từ chối lệnh trong
trạng thái ấy là khoá cửa điều khiển từ xa đúng lúc cần nó nhất — máy vừa mất điện, pin RTC
cạn, và người quản trị đang cố với tới nó.

**`sync_task` tiêu thụ, với hai nhịp khác nhau.** Nó thức mỗi 250 ms để lệnh không phải đợi,
nhưng **chỉ xả log mỗi 5 s** hoặc khi `q_uplink` nhắc: `svc_sync_drain()` mở con trỏ trên
LittleFS mỗi lần gọi, nên gọi 4 lần mỗi giây là đọc flash 4 lần/giây để hỏi một câu hầu như
luôn có cùng câu trả lời.

**Lệnh nào chạy được bây giờ là lệnh có sẵn API đã kiểm.** `OPEN_DOOR` (`svc_door_open`),
`REBOOT` (`esp_restart`), `SYNC_TIME` (`sys_time_sync_start`) và `DIAGNOSTICS` — cái cuối phát
ngay một `heartbeat` thay vì đẻ định dạng mới, vì heartbeat **đã là** ảnh chụp sức khoẻ của máy.
Năm lệnh còn lại trả `COMMAND_REJECTED` kèm tên việc sẽ mở chúng: `SET_CONFIG` và
`RELOAD_FACEDB` (chưa có API nạp lại), `CLEAR_LOGS`, `ROTATE_TOKEN` (E13-T4), `SET_ACTIVE_SLOT`
(E13-T2). Từ chối có lý do đọc được hơn hẳn im lặng: server biết lệnh **tới nơi** và biết vì sao
không chạy.

**`device_event` phải mọc thêm chỗ để mang kết quả.** `mqtt_topics.yaml` mô tả `up/event` là
"spoof attempts, hardware faults, manual door opens, **command results**" — nhưng schema không
có `cmdId` lẫn loại sự kiện nào cho kết quả lệnh. Đây là hợp đồng **chưa viết xong**, không phải
hợp đồng bị mở rộng: thêm `cmdId` (tuỳ chọn) cùng hai giá trị `COMMAND_DONE` và
`COMMAND_REJECTED` là viết nốt điều nó đã hứa. Không phá vỡ gì vì chưa có ai tiêu thụ.

**`up/event` — người phát chỉ ghi nhận, `sync_task` mới nói.** Bốn nơi trong firmware đã phát
hiện đúng những tình huống hợp đồng liệt kê, và cả bốn đều **không được phép chờ mạng**:
`ai_task` mất khung (`CAMERA_FAULT`), `tof_task` đọc lỗi khác timeout (`TOF_FAULT`),
`attend_task` thấy `SPOOF`/`UNKNOWN`, và đường ghi log hỏng (`STORAGE_FAULT`). Nên chúng bỏ một
bản ghi 72 B vào `q_event` rồi đi tiếp; `sync_task` gắn `deviceId` với `ts` và phát.

**Và phải có van, vì lỗi phần cứng thì lặp.** Một camera hỏng sinh sự kiện mỗi 2 giây, tức
1.800 gói mỗi giờ cho đúng một sự thật. Mỗi loại sự kiện vì thế có **khoảng cách tối thiểu
riêng**: 60 s cho nhóm hỏng hóc — đủ để server thấy nó dai dẳng mà không bị ngập — và 2 s cho
`SPOOF_DETECTED` với `UNKNOWN_FACE`, vì hai cái đó là **người**, không phải trạng thái, và hai
lần thử cách nhau 5 giây là hai sự kiện thật. Van đặt ở người phát chứ không ở người gửi: chặn
sớm thì hàng đợi không bao giờ đầy vì một sự thật duy nhất.


**JWT — 2 loại token**

| Loại | Thời hạn | Nơi lưu | Payload |
|---|---|---|---|
| Access (web) | 15 phút | memory ở frontend | sub, role |
| Refresh (web) | 7 ngày | cookie `httpOnly; Secure; SameSite=None` trên domain API | sub, jti (hash lưu DB để revoke) |
| Device token (kiosk) | 90 ngày, xoay vòng | NVS mã hoá trên ESP32 | deviceId, serial |

### 4.7 `frontend/` — Next.js trên Vercel

**Stack**: Next.js 16 (App Router) · React 19 · TypeScript · TailwindCSS 4 · next-intl · TanStack Query · Zustand · Recharts · socket.io-client

Primitive giao diện (`button`, `input`, `select`, …) **viết tay trong `components/ui/`**, không
lấy shadcn/ui. shadcn phát code vào repo rồi mình phải nuôi tiếp, nên nó chỉ lời khi dùng nhiều
component; ở đây trang nào cũng là bảng với biểu mẫu, và một `<Button>` 30 dòng đọc hết trong
một phút thì rẻ hơn một cây Radix mang theo mười gói phụ thuộc.

```
frontend/
├── app/
│   ├── globals.css
│   ├── providers.tsx                 # QueryClient dựng một lần mỗi phiên trình duyệt
│   └── [locale]/                     # ★ vi | en — mọi route nằm dưới đây
│       ├── layout.tsx                # layout gốc: <html lang={locale}> + provider
│       ├── (auth)/login/page.tsx
│       └── (dashboard)/
│           ├── layout.tsx            # sidebar + guard
│           ├── overview/page.tsx     # thẻ số liệu + biểu đồ + luồng sự kiện realtime
│           ├── employees/{page.tsx, [id]/page.tsx, new/page.tsx}
│           ├── attendance/{page.tsx, [id]/page.tsx}  # [id] là nhân viên: lịch sử của họ
│           ├── devices/{page.tsx, [id]/page.tsx}      # online, OTA, log
│           ├── shifts/page.tsx  ├── reports/page.tsx  ├── settings/page.tsx
│           │                                          # ── §9 quản trị nhân sự ──
│           ├── me/{page.tsx, attendance/page.tsx, requests/page.tsx, payslips/page.tsx}
│           ├── approvals/page.tsx                     # hộp chờ duyệt của MANAGER
│           ├── org/{page.tsx, departments/page.tsx}   # cây tổ chức
│           ├── leave/{page.tsx, [id]/page.tsx}        # HR nhìn toàn bộ đơn
│           ├── timesheet/page.tsx                     # bảng công tháng, sửa có vết
│           ├── payroll/{page.tsx, [periodId]/page.tsx}
│           └── policy/page.tsx                        # giảm trừ, tỷ lệ, biểu thuế
├── messages/{vi.json, en.json}       # ★ catalogue — vi.json là nguồn kiểu (§3.1 CLAUDE.md)
├── i18n/
│   ├── routing.ts                    # danh sách locale + locale mặc định
│   ├── navigation.ts                 # Link và useRouter có mang locale
│   └── request.ts                    # nạp catalogue cho phía server
├── public/
│   ├── {favicon.ico, logo.svg}
│   ├── manifest.webmanifest          # ★ cài được từ trình duyệt, chạy toàn màn hình
│   ├── icon-{192,512}.png            # ★ biểu tượng màn hình chính
│   └── sw.js                         # ★ service worker — vỏ ứng dụng và lần đọc gần nhất
├── components/
│   ├── ui/                           # primitive: button, input, select, checkbox, sheet,
│   │                                 #   skeleton, empty, money, theme-toggle
│   ├── nav/{sidebar.tsx, tab-bar.tsx, top-bar.tsx, waiting-count.ts}
│   │                                 # ★ rộng thì thanh bên, hẹp thì tab đáy; số đơn
│   │                                 #   đang chờ là một hook dùng chung cho cả ba
│   ├── tables/{data-table.tsx, card-list.tsx}        # ★ một định nghĩa cột, hai hình thức
│   ├── forms/employee-form.tsx
│   ├── requests/{request-card.tsx, request-form.tsx}
│   ├── search/global-search.tsx      # ★ §9.20 — một ô ra người, phòng ban, đơn, phiếu
│   ├── notifications/{bell.tsx, notice-list.tsx, push-switch.tsx}   # ★ §9.21.4
│   └── payroll/{payslip-view.tsx, run-progress.tsx}
├── lib/
│   ├── env.ts                        # ★ zod — NƠI DUY NHẤT đọc process.env (§4.9)
│   ├── api.ts                        # axios + interceptor tự refresh khi 401
│   ├── ws.ts                         # socket.io /feed, và xoá cache query theo tin
│   ├── auth.ts                       # kho phiên zustand + đọc vai từ token
│   ├── cn.ts                         # gộp class Tailwind, lớp sau thắng lớp trước
│   ├── fault.ts                      # ★ mã lỗi API → câu; NƠI DUY NHẤT làm việc đó
│   ├── nav.ts                        # ★ điều hướng theo vai; khoá ràng kiểu vào vi.json
│   ├── theme.ts                      # ★ sáng/tối: mặc định theo hệ điều hành, nhớ lựa chọn
│   └── format.ts                     # ★ tiền, giờ công, ngày — số nào cũng kèm đơn vị
├── types/
│   ├── generated/                    # ★ sinh từ contracts/schema — commit, KHÔNG sửa tay
│   └── messages.d.ts                 # ★ khai Messages = typeof vi.json, chốt en.json đủ khoá
├── .env.example                      # ✅ commit — mọi biến, giá trị giả
├── .env.local                        # ❌ gitignore — giá trị thật
├── proxy.ts                          # `/` → `/vi`, và chặn route không có locale
└── next.config.ts
```

**`components/` chia theo miền nghiệp vụ, không chia theo hình dạng.** Một thư mục `cards/` gom
mọi thứ có viền bo góc lại với nhau chỉ nói được rằng chúng trông giống nhau, và ngày thẻ đơn
từ cần thêm nút duyệt thì người sửa phải đọc cả thẻ thiết bị lẫn thẻ nhân viên để biết mình có
làm vỡ cái nào không. `requests/`, `payroll/`, `search/` đứng riêng vì chúng đổi cùng nhịp với
đúng một module backend; `ui/` là ngoại lệ duy nhất được chia theo hình dạng, vì primitive
không thuộc miền nào.

**Một định nghĩa cột, hai hình thức hiển thị.** `tables/data-table.tsx` và `tables/card-list.tsx`
nhận **cùng một mảng cột**: bảng vẽ chúng thành hàng, danh sách thẻ vẽ ba cột đầu thành một
thẻ và giấu phần còn lại sau một lần chạm (§9.21.1). Viết hai bộ cột riêng cho hai bề ngang là
cách chắc chắn để tháng sau cột *Đi muộn* có trên máy tính mà không có trên điện thoại — thứ
người dùng đọc là **thiếu số liệu**, không phải thiếu một cột.

**Thanh điều hướng cũng có hai hình thức, và chúng đọc chung `lib/nav.ts`.** Màn rộng dựng
`nav/sidebar.tsx`; màn hẹp dựng `nav/tab-bar.tsx` với tối đa năm mục lấy từ chính danh sách ấy,
vì thanh bên 240 px nuốt mất một phần ba bề ngang điện thoại. Hai file, một nguồn: thêm một
trang là sửa `lib/nav.ts`, không phải nhớ ra còn một chỗ thứ hai.

**Service worker viết tay, không dùng thư viện sinh sẵn.** Bộ sinh precache liệt kê từng file
băm của bản build, nên mỗi lần build lại là một danh sách mới và một lớp công cụ nữa phải nuôi.
Ở đây chỉ cần ba quy tắc, và ba quy tắc thì đọc hết trong một phút:

| Loại yêu cầu | Cách xử lý | Vì sao |
|---|---|---|
| `/_next/static/*` | **Cache trước**, không hỏi mạng | Tên có băm nội dung, nên bản cũ không bao giờ sai |
| Điều hướng trang | **Mạng trước**, hỏng thì lấy bản đã lưu | Mất mạng trong hầm gửi xe vẫn mở được trang, không ra trang lỗi trình duyệt |
| `GET` tới API | **Mạng trước**, hỏng thì lấy bản đã lưu | §9.21.3 luật 1: thứ đã xem phải xem lại được — phiếu lương gần nhất, số dư phép |

**Không cache `POST`.** Một đơn gửi lúc mất mạng phải **xếp hàng và nói rõ là đang chờ**
(§9.21.3), chứ không được lặng lẽ trả về một phản hồi cũ làm người gửi tưởng đã xong.

**Mã lỗi thành câu ở đúng một chỗ.** §3.1 luật 2 nói backend phát mã chứ không phát câu; hệ
quả là frontend phải có chỗ đổi mã thành câu, và chỗ ấy là `lib/fault.ts` cùng nhánh `errors`
của catalogue. Trước khi có nó, biểu mẫu đơn từ phải **dò chuỗi tiếng Anh** trong `message` để
đoán chuyện gì xảy ra — đổi một chữ trong câu lỗi là hỏng một nhánh xử lý mà không ai biết, và
nửa số lỗi rơi vào câu chung chung "Không xong được".

**Cỡ chạm là biến thể riêng, không phải phép chỉnh cỡ đang dùng.** `size="md"` cao 40 px là
đúng cho chuột — con trỏ chính xác tới từng điểm ảnh. Ngón tay thì không, nên §9.21.2 đòi
44 × 44 px, và cách đáp ứng là thêm `size="touch"` rồi cho `ui/` tự chọn theo `pointer: coarse`,
chứ không nâng `md` lên 44 px cho tất cả. Nâng tất cả thì mọi bảng dày thêm 10% chiều cao trên
màn hình mà người dùng đang dùng chuột, đổi lấy một lợi ích họ không nhận được.

**Bản ghi chấm công có đường đọc riêng, không chỉ có bản tổng hợp.** `GET /reports/attendance`
trả số lượt theo người — đủ cho biểu đồ và bảng công, **không đủ để tra một lượt**. Nên
`attendance` của backend có controller riêng trả chính các bản ghi, lọc theo người, theo máy và
theo khoảng, phân trang chặn ở 200 dòng. Thiếu nó thì một lượt chấm công chỉ nhìn thấy được
đúng một lần, lúc nó chạy qua feed realtime, và sau đó không ai tra lại được — trong khi dữ
liệu vẫn nằm nguyên trong bảng. Hai chỉ mục `@@index([employeeId, ts])` và `@@index([ts])` của
§6 có sẵn cho đúng hai phép lọc này.

**Locale nằm trên URL chứ không nằm trong cookie.** Giá phải trả là mọi route thụt vào một cấp
và mọi `<Link>` phải đi qua `i18n/navigation.ts`; đổi lại, một link gửi cho người khác mở ra
đúng thứ tiếng người gửi đang thấy, và trang render sẵn ở phía server đã đúng ngôn ngữ ngay
lần vẽ đầu — cookie thì server không biết trước, nên hoặc chớp một nhịp tiếng sai hoặc phải bỏ
render sẵn. `proxy.ts` đẩy `/` về `/vi` để địa chỉ trần vẫn mở được — tên file là quy ước
Next 16 đặt cho thứ vẫn gọi là middleware, chạy trong chính tiến trình Next; lớp proxy thật
của hệ là Traefik ở §11, hai thứ không dính nhau.

**Không có `app/layout.tsx`.** Layout gốc là `app/[locale]/layout.tsx`, vì `<html lang>` phải
mang đúng mã ngôn ngữ đang hiện: một layout đứng trên `[locale]` thì chưa biết locale, nên nó
chỉ có thể ghi cứng một giá trị và sẽ khai sai với nửa số người dùng — trình đọc màn hình chọn
giọng theo thuộc tính ấy.

**`vi.json` là nguồn kiểu, `en.json` là bản phải theo.** `types/messages.d.ts` khai
`Messages = typeof vi.json` để gọi sai khoá là lỗi ngay tại chỗ gọi; còn việc `en.json` có đủ
khoá hay không thì `i18n/request.ts` chốt bằng một phép so tập khoá hai chiều — thiếu một khoá
hoặc thừa một khoá đều không biên dịch được, và thông báo lỗi gọi thẳng tên khoá (§3.1 luật 1).

**`npm run typecheck` xoá `tsconfig.tsbuildinfo` trước khi chạy, và đó không phải thói quen
thừa.** `incremental` của TypeScript **không** theo dõi nội dung file `.json`, nên lượt chạy
nóng sai cả hai chiều — đo 20/09: nó bỏ qua khoá vừa bị xoá khỏi `en.json`, rồi sau khi khoá
được trả lại vẫn tiếp tục báo thiếu, tức vừa âm tính giả vừa dương tính giả. Bỏ hẳn
`incremental` không được vì `next build` tự ghi lại nó vào `tsconfig.json`, nên chỗ sửa nằm ở
chính lệnh kiểm. Một lượt kiểm lạnh tốn 0,25 s, nên không mất gì.

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
├── emqx/{emqx.conf, acl.conf, gen_certs.sh, certs/}   # listener MQTTS, auth và ACL
├── postgres/{init.sql, archive.conf}      # ★ archive.conf bật lưu trữ WAL liên tục
└── backup/{Dockerfile, backup.sh, restore-drill.sh, wal-push.sh}   # ★ §9.22.2
```

CI **không** nằm ở đây — workflow ở `/.github/workflows/`, vì GitHub Actions chỉ đọc đúng chỗ đó.

| Service | Image | Cổng | Ghi chú |
|---|---|---|---|
| `traefik` | traefik:v3 | 80, 443, 8883 | TLS tự động, reverse proxy, TCP passthrough cho MQTTS |
| `api` | build từ `backend/` | 3000 (nội bộ) | NestJS |
| `postgres` | postgres:16-alpine | 5432 (nội bộ) | volume `pgdata` |
| `redis` | redis:7-alpine | 6379 (nội bộ) | BullMQ |
| `emqx` | emqx/emqx:6.3.1 | 8883, 18083 **nội bộ** | auth và ACL hỏi `api` qua HTTP; dashboard không ra ngoài |
| `minio` (tùy chọn) | minio/minio | 9000 | ảnh chấm công |
| `backup` | postgres + cron | — | dump hằng đêm |

Frontend **không nằm trong Docker** — deploy thẳng lên Vercel, trỏ `NEXT_PUBLIC_API_URL=https://api.<domain>`.

**Sao lưu: bốn luật, và luật thứ tư là luật duy nhất chứng minh được ba luật kia.**

1. **Bản đầy đủ hằng đêm cộng WAL liên tục.** Chỉ có bản đêm thì mất tối đa một ngày; WAL đẩy
   liên tục kéo con số ấy xuống còn phút. `archive_mode = on` và `archive_command` đẩy từng
   segment ngay khi nó đầy.
2. **Mã hoá trước khi rời máy, bằng khoá công khai.** Máy chạy sao lưu chỉ giữ **khoá công
   khai** của `age`; nó ghi được bản sao lưu nhưng **không đọc lại được bản cũ**. Ai chiếm được
   máy chủ vẫn không mở được lịch sử. Khoá riêng cất ngoài hệ thống, và nơi cất nó là một quyết
   định vận hành chứ không phải một dòng trong compose.
3. **Không nằm cùng đĩa với bản đang chạy.** Sao lưu ở cùng volume là bản sao, không phải sao
   lưu — ổ chết là mất cả hai. Thư mục `backup/` trỏ ra một volume khác, và trên VPS thật là một
   nơi lưu trữ ngoài máy.
4. **Kiểm phục hồi định kỳ, có số đo.** `restore-drill.sh` dựng bản sao lưu mới nhất vào một cơ
   sở dữ liệu vứt đi, **đếm dòng từng bảng** và **bấm giờ**. Một bản sao lưu chưa từng phục hồi
   thử không phải bản sao lưu — nó là một file người ta tin là bản sao lưu, và khác biệt chỉ lộ
   ra đúng vào ngày tệ nhất.

**Con số phải trả lời được, không phải lời hứa** (§9.22.2): mất tối đa bao nhiêu phút dữ liệu,
mất bao lâu để dựng lại, và lần kiểm phục hồi gần nhất là khi nào. Hai số đầu do thiết kế quyết,
số thứ ba do `restore-drill.sh` ghi ra.

**Vì sao EMQX chứ không phải mosquitto.** Bảy topic của `contracts/mqtt_topics.yaml` chỉ đòi
QoS 1, retained và LWT — mosquitto làm đủ, và nó tốn ~5 MB RAM so với **382 MB** đo được của
EMQX. Chỗ quyết định nằm ở **§7.2**: device token là JWT xoay vòng khi còn 7 ngày, và ACL phải
chặn mỗi kiosk trong đúng `kiosk/{chính nó}/#`. Với mosquitto, cả hai thứ ấy sống trong file
`passwd` và `acl`, nên mỗi lần xoay token là backend phải ghi lại file rồi bắt broker nạp lại —
một đường điều khiển thứ hai nằm ngoài backend, trong khi backend mới là nguồn sự thật của
token. EMQX hỏi thẳng `api` qua HTTP cho cả auth lẫn ACL, nên xoay token **không đụng tới
broker**. Đổi lại 382 MB RAM trên VPS và một cổng dashboard `18083` **bắt buộc không được ra
ngoài** — traefik chỉ cho nó qua sau xác thực, hoặc không map ra ngoài Docker network.

**Vì sao ghim đúng `6.3.1`.** Repo `emqx/emqx` không có tag trôi nổi cho dòng 5 — `emqx/emqx:5`
không tồn tại, dòng 5 chỉ phát hành bản đầy đủ kiểu `5.10.5`, nên ghim số đầy đủ là bắt buộc chứ
không phải lựa chọn. Cả hai dòng đều đóng gói **bản Enterprise kèm license `community`** (10 triệu
session, TPS vô hạn, hết hạn 2029-03-01), nên lùi về 5.x không đổi được điều khoản license, mà còn
tốn thêm RAM: 5.10.5 đo được **484 MB lúc nhàn rỗi** so với 382 MB của 6.3.1 sau khi đã chạy test.
Dòng 6 vừa mới hơn vừa nhẹ hơn.

**Trạng thái mặc định của image là mở, và đó là việc của E13-T4.** Container vừa dựng có
`authentication = []` (cho nặc danh vào) và ACL mặc định `{allow, {security_profile, legacy}}`
(mở mọi topic trừ `$SYS/#`). Listener `8883` chạy được ngay bằng cert demo nằm sẵn trong image,
nhưng khoá riêng của cert đó công khai trong mọi bản EMQX nên nó **chỉ dùng được ở bàn thí
nghiệm**. Ba thứ ấy — authn gọi `api`, ACL theo `kiosk/{chính nó}/#`, cert thật — là nội dung
của `emqx/emqx.conf` và `emqx/certs/`, làm ở E13-T4. Image còn bật sẵn listener `ws:8083` và
`wss:8084` bên trong container; compose không map chúng ra ngoài và không có kế hoạch map.

**Retained phải ghi xuống đĩa, không để mặc định.** EMQX mặc định
`retainer.backend.storage_type = ram`, nên restart broker là mất sạch retained — đo được 0 bản
ghi còn lại sau `docker compose restart`. `contracts/mqtt_topics.yaml` hứa retained cho
`up/status` và `up/heartbeat`, và chỗ hứa ấy vỡ đúng vào ca tệ nhất: kiosk **đang bật** nối lại
rồi tự đăng `online` nên tự lành, còn kiosk **đang tắt** không đăng gì cả, nên `offline` do LWT
để lại biến mất và dashboard §4.7 không phân biệt nổi "đang tắt" với "chưa từng tồn tại" — một
kiosk hỏng cả tuần trông y như chưa bao giờ được lắp. `docker-compose.yml` vì thế đặt
`EMQX_RETAINER__BACKEND__STORAGE_TYPE=disc`, và đã đo lại: retained sống qua restart.

Firmware **không biết và không cần biết** đầu kia là broker nào: `net_mqtt` nói MQTT chuẩn qua
`esp-mqtt`, nên đổi broker là việc của `deploy/` và cert, không sửa một dòng firmware nào.

**Broker gọi bằng tên, không bao giờ bằng IP.** Một địa chỉ `192.168.x.x` chỉ định tuyến được
trong đúng một LAN, nên kiosk cắm IP vào `device/mqtt_uri` là kiosk chết ngay khi ai đó đổi
router — mà §7.6 vừa cho người vận hành đổi Wi-Fi ngay trên màn hình. Tên còn giữ cho **TLS**
đúng nghĩa: `esp-tls` đối chiếu host trong URI với SAN của chứng thư, và đó là thứ chặn kiosk
bị bẻ sang broker giả, nên tắt phép kiểm ấy cho tiện là bỏ luôn lớp bảo vệ.

**Ba thứ bất biến, mọi thứ còn lại thay được.** CA nằm trong ảnh firmware (`broker_ca.crt`, hạn
10 năm), **tên** broker, và `device/mqtt_uri`. Chứng thư máy chủ do chính CA ấy ký và sống
ngắn hơn nhiều; dời broker sang VPS khác, đổi IP, cấp lại sau khi hết hạn — tất cả chỉ là ký
lại một chứng thư và sửa một bản ghi DNS. **Không con kiosk nào phải nạp lại.** Điều ngược lại
mới đắt: sinh CA mới là phải nạp lại toàn bộ đội máy, nên `gen_certs.sh` **dùng lại CA sẵn có**
và chỉ tạo CA khi chưa có cái nào.

`gen_certs.sh` nhận danh sách tên và IP làm tham số, đưa hết vào SAN. Một chứng thư phủ cả tên
dùng sau này lẫn IP dùng ở bàn thí nghiệm thì không phải cấp lại lúc chuyển sang VPS — chỉ đổi
`mqtt_uri` sang tên, còn chứng thư đã khai sẵn tên ấy từ đầu. Khoá riêng của cả CA lẫn máy chủ
không rời `deploy/emqx/certs/`, và `.gitignore` chặn cả thư mục.

`ci/contracts.yml` là workflow quan trọng nhất: chạy lại generator từ `contracts/`, fail nếu code sinh ra khác code đã commit. Đây là thứ chặn 3 khối trôi khỏi nhau.

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
| URL, host, port, secret, chuỗi kết nối — backend và frontend | biến môi trường, khai ở `.env.example` | `config/env.schema.ts` · `lib/env.ts` |
| URL và credential trên kiosk | NVS `device/*` (§6.2.1), giá trị lùi khai ở `Kconfig` của component | đọc qua `sys_storage`, **không gõ vào `.c`** |
| Số hiệu firmware | `PROJECT_VER` trong `firmware/CMakeLists.txt` | `esp_app_get_description()->version`, **không gõ lại ở đâu** |
| Tên khoá cache, TTL | `backend/src/common/cache/cache-keys.ts` | import |
| Tên hàng đợi, kiểu job | `backend/src/queue/queues.ts` | import |
| Ngưỡng nghiệp vụ (**tin cậy phát hiện mặt**, khớp mặt, liveness, chống trùng) | NVS trên kiosk, `SET_CONFIG` từ server | đọc cấu hình lúc chạy |
| Giảm trừ gia cảnh, tỷ lệ BHXH/BHYT/BHTN, trần đóng | bảng `PayrollPolicy`, có `effectiveFrom` (§9.7) | đọc chính sách **hiệu lực tại ngày cuối kỳ**, không đọc "hiện tại" |
| Biểu thuế luỹ tiến từng phần | bảng `TaxBracket`, có `effectiveFrom` (§9.7) | như trên |
| Lương cơ bản, lương đóng bảo hiểm, phụ cấp | `CompensationRecord`, có `effectiveFrom` (§9.6) | **thêm dòng mới**, không sửa đè dòng cũ |
| Chuỗi hiển thị trên kiosk | `ui_kiosk/priv_include/strings.hpp` (`enum class StrId`) | `ui::text(StrId::X)`, **không gõ chuỗi vào `screens.cpp`** |
| Chuỗi hiển thị trên dashboard | `frontend/messages/{vi,en}.json` | `useTranslations()` của next-intl |
| Ngôn ngữ đang chọn | kiosk: NVS `ui/lang` (§6.2.1) · dashboard: đoạn locale đầu URL | `ui_kiosk_set_language()` · `params.locale` |

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
| `cam_task` | `drv_camera` | 0 | 7 | 4 KB | mỗi frame (~15 fps) | `esp_camera_fb_get()` → vẽ preview kèm overlay của `ui_kiosk` → đẩy con trỏ vào `q_frame_ai` (overwrite) |
| `tof_task` | `drv_tof` | 0 | 6 | 3 KB | ngắt GPIO3 / poll 100 ms | Đọc khoảng cách → phát `EVT_PRESENCE_ON/OFF`, đánh thức hệ thống |
| `audio_task` | `drv_audio` | 0 | 6 | 4 KB | chờ `q_audio` | Nạp `snd/ok.wav` từ partition `assets` **một lần lúc lên**, giữ PCM trong PSRAM rồi phát khi có `APP_SOUND_OK`: mở cửa xong không phải đọc file |
| `touch_task` | `drv_touch` | 0 | 5 | 3 KB | poll 40 ms | Đọc GT911 → ô `s_touch` của `ui_kiosk` (§5.3) |
| **`ai_task`** | `svc_vision` | **1** | 5 | 8 KB | chờ `q_frame_ai` | mỗi khung một `svc_vision_step()`: detect, và khi mặt đã ổn định thì spoof → recog → tra bảng ngay trong bước đó (§4.5.5d); kết quả khác `NONE` → `q_result`; `esp_task_wdt_reset()` sau mỗi step (§5.1) |
| `ui_task` | `ui_kiosk` | 0 | 4 | 4 KB | tick 20 ms | Chạy `ScreenManager`, dựng ảnh overlay cho `cam_task`, đọc điểm chạm ở `s_touch`, đọc `eg_system`. Cầm `m_spi_lcd` **chỉ cho màn không có video** |
| `attend_task` | `attendance` | 0 | 4 | 4 KB | chờ `q_result` | State machine, chống trùng, ghi LittleFS, mở cửa, đẩy `q_audio` + `q_uplink` |
| `mqtt_task` | `net_mqtt` | 0 | 3 | 6 KB **ở PSRAM** | esp-mqtt tự tạo | pub/sub, TLS |
| `ota_task` | `net_ota` | 0 | 3 | 8 KB | khi có lệnh `down/ota` | Tải firmware / models, verify sha256, ghi partition |
| `sync_task` | `svc_sync` | 0 | 2 | 5 KB | 5 s hoặc khi `q_uplink` có dữ liệu | Đẩy bản ghi offline lên MQTT, chờ ack, đẩy con trỏ; và **phát `up/heartbeat` mỗi `GEN_TOPIC_HEARTBEAT_INTERVAL_S`** |
| `net_task` | `net_wifi` | 0 | 3 | 4 KB | một nhịp lúc boot | Chờ link rồi giương `WIFI_OK`, để `app_main` không bị giữ 30 s chỉ để biết là không có sóng. **Tạm**: tách thành `mqtt_task` và `sync_task` ở E10-T6 |
| `wifi` / `lwip` | hệ thống IDF | 0 | 18–23 | — | — | Do IDF quản lý, không tự tạo |

**Ngăn xếp `mqtt_task` nằm ở PSRAM.** `CONFIG_MQTT_TASK_STACK_ON_EXTERNAL_MEMORY` đẩy 6 KB ấy
ra bộ nhớ ngoài; khối điều khiển task vẫn ở RAM nội. Không phải chọn cho nhanh mà là chọn cho
chạy được: heap nội đo trên `dev` còn **1.848 B trong vùng chính 225 KB**, và mảnh liền lớn nhất
của cả hệ là 5.620 B — esp-mqtt xin 6.144 B nên nó không khởi động nổi. Đây không phải phân
mảnh: vùng giữ mảnh ấy có **đúng một** khối trống. RAM nội đơn giản là đã hết, mà 92 KB trong đó
là hai bộ đệm DMA của màn hình và camera, thứ **bắt buộc** phải ở RAM nội.

Luật kèm theo của IDF là ngăn xếp ở PSRAM không được chạm khi cache flash tắt. Điều kiện ấy
thoả về mặt cấu trúc: `spi_flash_disable_interrupts_caches_and_other_cpu()` đỗ hẳn lõi kia và
tắt ngắt suốt lượt ghi flash, nên không task nào chạy được lúc đó. Cùng chính sách với
`MBEDTLS_EXTERNAL_MEM_ALLOC` và hai arena TFLM: **RAM nội để dành cho DMA**.

`ota_task` 8 KB **chưa có chỗ** trên `dev` — không vùng nào còn 8 KB liền. Nới thật thì phải hạ
đệm bounce LCD, không phải đẩy thêm ngăn xếp sang PSRAM.

**`ui_task` lấy 4 KB chứ không 8 KB.** `ram.md` §3.1 đo trên `bench` thấy nó còn trống 6.772 B
trên 8.192 B cấp, tức cả vòng đời chỉ chạm **1.420 B**; 4.096 B để lại biên 2.676 B. Bốn KB thu
về đi thẳng cho ngăn xếp mà esp-mqtt tự xin lúc `mqtt_task` lên, thứ mà bản `dev` không còn chỗ
liền mạch để cấp (§6.4). `ai_task` **không** cắt được dù cùng cấp 8 KB: nó chỉ còn 1.284 B trống,
và đó là lúc mới chạy detect — spoof với recog đi sâu hơn.

> **Quy tắc priority**: mọi task ứng dụng phải < 18 để không chèn Wi-Fi stack. Task có deadline cứng (cam, tof, audio) đặt cao hơn task chỉ cần "mượt mắt" (ui) và task nền (sync).

### 5.3 Bảng Queue / Mutex / Semaphore / EventGroup

| Đối tượng | Kiểu | Kích thước | Gửi | Nhận | Vì sao đặt ở đây |
|---|---|---|---|---|---|
| `q_frame_ai` | Queue, **depth 1**, `camera_fb_t*` | 1 × 4 B | `cam_task` | `ai_task` | Depth 1, **luôn xử lý frame mới nhất** → không dồn RAM, không trễ tích luỹ. Người gửi **nhận trước rồi mới gửi**, không dùng `xQueueOverwrite`: khung bị đẩy ra phải được trả về pool bằng tay, mà `xQueueOverwrite` vứt con trỏ đi lặng lẽ và pool rỉ máu sau vài giây |

**Không có hàng đợi preview, và đó là một quyết định đo được.** Ý cũ — `cam_task` đẩy khung
sang `ui_task` để `ui_task` vẽ — thêm **một task nữa giữ khung**, mà `fb_count` = 4 hiện chỉ vừa
đủ cho `ai_task` giữ một và `cam_task` giữ một: thiếu một ô để lấp là chu kỳ thành *lấp + xử lý*
thay vì `max(lấp, xử lý)`, đúng cơ chế đã kéo preview **14,18 → 8,1 fps** (§6.3, `latency.md` §6).
Nên khung **không đi đâu cả**: `cam_task` vẽ ngay tại chỗ nó đang cầm khung, và `ui_kiosk` chỉ
đưa xuống một **ảnh overlay** để đè lên từng dải 20 dòng đúng lúc dải ấy đang được gom (§4.5.5h).
Overlay vì thế không tốn thêm một byte nào trên SPI và không tốn thêm một lượt quét PSRAM nào.
`ui_task` vẫn cầm panel qua `m_spi_lcd`, nhưng chỉ cho màn hình **không có video**.

**Không có semaphore giữa ISR camera và `cam_task`.** `esp_camera_fb_get()` đã tự chặn cho tới khi có khung, nên một binary semaphore nữa chỉ là tầng chờ thứ hai chờ đúng thứ mà tầng dưới đã chờ.

| `q_result` | Queue, depth 4, `svc_vision_result_t` | 4 × ~104 B | `ai_task` | `attend_task` | Tách hẳn tính toán khỏi nghiệp vụ |
| `s_touch` | **`std::atomic<int32_t>`** trong `ui_kiosk`, không phải queue | 4 B | `touch_task` | `ui_task` | Điểm chạm là **mức, không phải chuỗi sự kiện**: `ui_task` chỉ cần biết ngón tay *đang* ở đâu tại mỗi nhịp 20 ms. Hàng đợi ở đây phát lại những điểm đã cũ và làm nút bấm trễ theo độ sâu hàng đợi. Một người ghi, một người đọc, `release`/`acquire` — không khoá, không mất, không cũ. Ngón nhấc lên lưu `-1` và `ui_task` dựng lại cú thả từ điểm cuối |
| `q_audio` | Queue, depth 4, `sound_id_t` | 4 × 4 B | `attend_task`, `ui_task` | `audio_task` | Phát âm không được chặn nghiệp vụ |
| `q_uplink` | Queue, depth 16, `attendance_rec_t` | 16 × ~96 B | `attend_task` | `sync_task` | **Chỉ là lời nhắc, không phải hàng đợi thật**: bản ghi đã nằm trên LittleFS kèm con trỏ trước khi chạm vào đây (§6.2.6), nên đầy là chuyện bình thường chứ không phải lỗi — nhất là khi `sync_task` chưa tồn tại. Vì vậy chỉ log **một lần** ở cạnh đầy, không log mỗi bản ghi |
| `q_cmd` | Queue, depth 4, `device_command_t` | 4 × ~160 B | task của esp-mqtt | `sync_task` | `on_broker_message` chạy trên task của esp-mqtt và header của `net_mqtt` cấm chặn ở đó, mà `OPEN_DOOR` giữ cửa 3 s còn `REBOOT` thì không trả về. Nên callback chỉ **phân tích** payload rồi bỏ vào đây. Đầy thì **rơi lệnh và ghi log**: chờ ở đó là chặn cả đường MQTT, kể cả `attendance` đang lên |
| `q_event` | Queue, depth 8, `app_event_t` | 8 × 72 B | `ai_task`, `tof_task`, `attend_task` | `sync_task` | Người phát sự kiện **không được publish**: `net_mqtt_publish` ở QoS 1 chờ PUBACK, mà `ai_task` đứng lại chờ mạng là mất khung. Item là bản rút gọn 72 B chứ không phải `device_event_t` 304 B — người phát biết **lỗi gì**, `sync_task` mới biết `deviceId` với giờ |
| `q_ota` | Queue, depth 1, `ota_manifest_t` | 1 × ~1,8 KB | task của esp-mqtt | `ota_task` | Cùng lý do `q_cmd`: callback chỉ phân tích rồi bỏ vào đây, vì tải một ảnh firmware mất hàng chục giây và chặn ở đó là chặn cả đường MQTT. **Sâu đúng 1**: hai bản kê khai cùng lúc thì bản thứ hai là thừa — máy chỉ cài được một ảnh, và bản mới hơn sẽ được phát lại. Đầy thì rơi và ghi log |
| `q_presence` | Queue, depth 2, `app_presence_t` | 2 × 4 B | `tof_task` | `attend_task` | Máy trạng thái cần **cạnh**, không cần khoảng cách. Depth 2 đủ cho một lần vào và một lần ra chưa kịp xử lý. Cạnh rơi thì **phải log**: mất một `PresenceOff` là máy nằm lại ở `Detecting` cho tới khi có phán quyết thị giác, và im lặng thì không ai lần ra được |
| **`m_i2c`** | Mutex | — | GT911, VL53L1X, PCF8574, DS3231 | — | **Bắt buộc** — 4 thiết bị 1 bus, 3 task khác nhau truy cập |
| **`m_spi_lcd`** | Mutex | — | `ui_task`, `ota_task` (màn hình tiến trình) | — | 1 bus SPI, tránh xé khung hình |
| **`m_facedb`** | Mutex | — | `ai_task` (đọc), `mqtt_task` (ghi khi enroll) | — | Bảng embedding bị sửa giữa lúc đang so khớp = kết quả sai |
| **`m_facedb_io`** | Mutex | — | `mqtt_task` / `ui_task` (mọi đường ghi bảng) | — | Ghi 552 KB xuống LittleFS mất 1,8–2,3 s, mà `m_facedb` chỉ chờ 200 ms: giữ `m_facedb` suốt phép ghi thì `lookup` hết giờ và người thật bị từ chối. Khoá này xếp hàng **người ghi với người ghi**, để phép ghi dài chạy ngoài `m_facedb` mà ảnh bảng vẫn không bị sửa giữa chừng |
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
Thứ tự lấy khoá cố định trên toàn dự án: `m_facedb_io` → `m_facedb` → `m_littlefs` → `m_i2c` → `m_spi_lcd`. Không bao giờ lấy ngược. Mọi `xSemaphoreTake` đều có timeout, không dùng `portMAX_DELAY` cho mutex.

**Vùng khoá của `m_facedb` phải ngắn hơn hạn chờ của chính nó.** `lookup` chờ 200 ms, nên mọi
đường giữ `m_facedb` lâu hơn thế đều là lỗi, kể cả khi thứ tự khoá đúng. Phép ghi bảng xuống
flash là đường duy nhất như vậy, và nó ra ngoài bằng `m_facedb_io`: lấy `m_facedb_io`, lấy
`m_facedb` đúng lúc nén và đóng dấu header rồi thả ngay, ghi flash dưới một mình `m_facedb_io`.
Người ghi khác chờ ở cửa `m_facedb_io`; `ai_task` không chờ gì cả.

### 5.4 Các mức nghỉ và đường đánh thức

Ý đồ này trước nay nằm rải rác — §2.3D chọn GPIO3 cho ngắt VL53L1X **vì nó là RTC GPIO, dùng
được làm nguồn đánh thức**; §2.6 bỏ luôn chân SQW của DS3231 với lý do "đánh thức đã có ngắt
VL53L1X"; §3 lớp 5 đòi "ToF không thấy người → không chạy model nào, tiết kiệm ~70%". Không mục
nào đặc tả **máy nghỉ thế nào**, nên mục này làm việc đó.

**Vì sao đáng làm.** Bảng §2.5 lúc rảnh, chưa tính loa và servo: ESP32-S3 ~100 mA, OV5640 đang
stream **120 mA**, LCD cộng đèn nền ~100 mA, VL53L1X 20 mA, GT911 5 mA — tổng ~345 mA. Tắt mỗi
đèn nền là cắt được chưa tới một phần ba. Hai khoản còn lại, **camera và CPU**, mới là phần
§3 lớp 5 nhắm tới.

**Một mốc thời gian, hai ngưỡng, ba mức.** Mốc là `esp_timer_get_time()` — đơn điệu, vì SNTP
chỉnh đồng hồ tường và một đồng hồ bị chỉnh từng làm màn nháy. Mọi nguồn đánh thức chỉ làm đúng
một việc: ghi lại mốc ấy.

| Mức | Điều kiện | Tắt gì | Cắt được (§2.5, 🔬 chưa đo trên board này) |
|---|---|---|---|
| **Thức** | vừa có nguồn đánh thức, hoặc màn phủ kín đang mở, hoặc đang lấy mẫu đăng ký | — | 0 |
| **Nghỉ** | **60 s** không nguồn nào | `ai_task` bỏ `svc_vision_step`, xoá hộp mặt trên kính và báo `NO_FACE` một lần; thêm: đèn nền tắt, **ST7796 vào `SLPIN`**, **OV5640 vào standby mềm**, `cam_task` thôi lấy khung, `touch_task` giãn 40 → 160 ms, `ui_task` giãn 20 → 200 ms, `attend_task` thôi dựng trang cài đặt | ~100 mA đèn + ~120 mA camera + phần bộ điều khiển panel và số lần đánh thức CPU |

**Đúng hai mức, không ba.** Bản đầu cho model nghỉ sớm ở 4 giây rồi mới tắt màn ở phút thứ nhất,
và khoảng giữa ấy là một vùng chết: màn sáng, preview chạy, người dùng thấy một cái máy đang
sống, mà **không model nào nhìn khung hình**. Tệ hơn, model đã ngủ thì nó không thấy được mặt
nữa, nên nguồn "mặt giữ thức" mất tác dụng và việc chấm công quay về phụ thuộc mỗi ToF — đúng
cái §4.5.5f cấm. Đổi lại chỉ được **CPU của core 1**, khoản nhỏ nhất trong ba, trong khi camera
120 mA và đèn nền 100 mA vẫn bật suốt vùng chết ấy. Không đáng, nên bỏ: **màn sáng thì máy làm
việc đầy đủ, màn tắt thì mọi thứ nghỉ cùng lúc.**

Ngưỡng nghỉ là **một phút** chứ không phải hai chục giây: người đứng đọc màn hình, quay đi lấy thẻ
rồi quay lại vẫn nằm trong cùng một lượt, và mỗi lần vào L2 phải trả lại 120 ms của `SLPOUT` cộng
thời gian camera khoá lại PLL. Nghỉ quá sớm là trả giá đánh thức nhiều hơn phần điện tiết kiệm.

**Danh sách nguồn đánh thức là danh sách đóng.** Chỉ năm thứ dưới đây được ghi lại mốc:

1. ToF đọc được khoảng cách trong `vision.present_mm` — **mỗi lượt poll**, không chỉ lúc qua cạnh
2. Chạm màn GT911
3. Màn lấy mẫu đăng ký đang mở (`ui_kiosk_enrolling()`)
4. Một màn phủ kín đang mở
5. `drv_tof_read_mm` trả lỗi **thật** — khác `ESP_ERR_TIMEOUT`, vốn chỉ là "chưa tới lượt đo" và
   xảy ra mỗi 100 ms. Lưới an toàn: cảm biến hỏng thì máy phải thức, không phải ngủ vĩnh viễn

**Đầu ra của model không nằm trong danh sách, và đây là luật.** Lấy `result.faces > 0` làm nguồn
đánh thức là vòng tự nuôi: bộ dò còn báo thấy mặt thì máy không bao giờ nghỉ, đúng hay sai cũng
vậy. Việc phát hiện có người là của cảm biến khoảng cách và của ngón tay, không phải của model.

**Bộ dò không được giữ thức, và đây là số đo nói ra điều đó.** Ý tưởng cho khuôn mặt gia hạn
mốc nghỉ đã thử và đã bỏ trong cùng ngày 18/09. Bản đầu nhận mọi ứng viên: 92 giây không ai đứng
trước máy, ToF không ra một dòng `presence on`, mà kiosk không hề nghỉ vì bộ dò nhấp nháy ra ứng
viên `FACE_SMALL` và `FACE_OUT_OF_FRAME`. Bản sau siết lại, chỉ nhận khuôn mặt qua cổng
`face_min_px`: **80 giây, đúng một dòng `face in` và không bao giờ `face out`** — bộ dò bám một
vật trong khung đủ lớn để qua cổng và giữ máy thức liên tục. Kết luận: ở bố trí này camera
**không phân biệt được người với vật giống khuôn mặt** đủ tin để đem gác nguồn điện, còn cảm
biến khoảng cách thì có. Nên danh sách nguồn ở trên là danh sách đầy đủ, không có ngoại lệ cho
model — cả đánh thức lẫn giữ thức.

**Đổi lại, ToF phải chịu được nhiễu.** Lý do người ta muốn cho khuôn mặt giữ thức là một lỗi
thật: đo 18/09, `presence on at 228 mm` rồi `presence off at 65535 mm` **0,9 giây sau**, trong
khi camera còn nhận diện đúng người ấy thêm bốn giây — và 65535 là số `main` tự gán khi range
status khác 0, chứ không phải khoảng cách đo được. VL53L1X trả một **range status** cho từng
lượt đo: 0 hợp lệ, 1 sigma fail (có vật nhưng nhiễu), 2 signal fail (thường là trống), 4 ngoài
dải, 5 wraparound. Lấy **một mẫu** status khác 0 làm bằng chứng "hết người" là sai cỡ bài toán:
cổng này quyết định **có ai đứng đó hay không**, không phải đo khoảng cách chính xác. Vì vậy
`tof_task` đòi **`PRESENCE_AWAY_SAMPLES` mẫu liên tiếp** không thấy gì trong tầm rồi mới hạ cờ,
tức nửa giây ở nhịp 100 ms; dải trễ 60 mm của §5.3 lo chuyện khoảng cách dao động quanh ngưỡng,
còn bộ đếm này lo chuyện mẫu rớt.

**Giới hạn đã biết, và cách đỡ.** Nón nhìn của VL53L1X là 27°, hẹp hơn góc camera. Người đứng
lệch trục hoặc ngoài `present_mm` thì ToF không thấy, và ở L2 thì camera cũng đang ngủ nên không
ai thấy họ. Đường đỡ là **chạm màn** — nguồn đánh thức số 2 — và đó là lý do GT911 không được
ngủ theo. Với người thật sự đến chấm công thì ca này không xảy ra: đứng trước kiosk trong 70 cm
là nằm gọn trong nón. Ca hỏng thật đã gặp là **màn lấy mẫu đăng ký**, nơi người vận hành đứng
lùi ra — đã đỡ bằng nguồn số 3.

**Màn nghỉ sâu hơn mức tắt đèn.** Tắt đèn nền chỉ cắt dãy LED; bộ điều khiển ST7796 vẫn chạy dao
động, bơm điện tích VCOM và các tầng lái hàng/cột. `SLPIN` (0x10) tắt hẳn những thứ đó. Thành
phần `esp_lcd_st7796` trong `managed_components` **chỉ cài `disp_on_off`, không cài `disp_sleep`**,
nên `esp_lcd_panel_disp_sleep()` trả `ESP_ERR_NOT_SUPPORTED`; `drv_lcd` gửi thẳng `SLPIN`/`SLPOUT`
qua `esp_lcd_panel_io_tx_param`, đúng cách nó đã gửi VCOM và tần số khung ở §2.3A. Sửa
`managed_components` là cấm (CLAUDE.md §6). Trình tự theo datasheet: ngủ là `DISPOFF` → `SLPIN`,
thức là `SLPOUT` → **chờ 120 ms** → `DISPON`. 120 ms đó **trùng với lúc camera khoá lại PLL** nên
không cộng dồn vào thời gian đánh thức thấy được.

**Camera nghỉ bằng thanh ghi, không bằng `esp_camera_deinit()`.** Chân PWDN của OV5640 **không
nối vào GPIO nào** (§2.3), nên đường duy nhất là ghi `0x3008` bit 6 qua SCCB. Không được gỡ hẳn
driver: `deinit` trả lại hai đệm DMA 15.360 B ở RAM nội, mà §6.4 đo được mảnh liền lớn nhất của
heap chính chỉ còn **4 KB** — xin lại rất có thể trượt, và lúc đó camera chết hẳn chứ không phải
chậm. Lúc thức lại phải **bỏ vài khung đầu**: cảm biến cần khoá lại PLL và AEC, khung đầu ra
trong lúc đó không dùng được.

**Không dùng deep sleep, và chưa dùng light sleep.** Deep sleep mất phiên Wi-Fi và boot lại mất
~3 s, mà kiosk phải nhận lệnh từ server bất cứ lúc nào — loại. Light sleep tự động cần
`CONFIG_PM_ENABLE` với DFS, mà DFS đổi tần số APB, còn XCLK của camera lấy từ LEDC, SPI của LCD
và I2S của loa đều dẫn xuất từ APB: **chưa thử, chưa đo**, để riêng một lượt. Chân GPIO3 của
§2.3D vẫn giữ nguyên vai trò nguồn đánh thức RTC cho bản chạy pin sau này.

🔬 **Phải đo, chưa có số**: dòng thật ở bốn trạng thái (L0 sáng, L0 tối, L1, L2); thời gian
camera ra khỏi standby cho tới khung dùng được. Thời gian bật lại đèn nền **đã đo: 22 ms** kể từ
lúc ToF thấy người ở 52 mm.

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
| `device` | `serial`, `jwt`, `jwt_exp`, `mqtt_uri`, `mqtt_user`, `mqtt_pass`, `sntp_host`, `tz`, `roster_ver` | str / u32 | token xoay vòng khi còn 7 ngày; `sntp_host` là host hiệu chỉnh giờ, §4.9 xếp host vào loại một nguồn duy nhất nên `sys_time` **nhận qua tham số**, không gõ vào code; `tz` là chuỗi POSIX (`ICT-7`) đi cùng đường đó; `roster_ver` (u32) là con trỏ hội tụ của §7.5, ghi **sau khi** áp xong một lệnh roster nên mất điện giữa chừng chỉ tốn một lần đẩy lại |
| `model` | `active_slot` (u8: 0/1), `version` (str), `sha256` (blob 32B) | | chọn `models_0` hay `models_1` |
| `sys` | `boot_count` (u32), `last_ota_result` (u8), `fw_valid` (u8), `rtc_ntp_set` (u8), `seed_ver` (u32) | | `boot_count` dùng sinh `local_id`; `last_ota_result` là **cái chốt chống lặp** của A/B model — 0 không có gì đang thử, **1 vừa đổi `active_slot` và chưa được chứng minh**, 2 slot ấy nạp được, 3 nó hỏng và máy đã quay về. Không có chốt này thì hai slot cùng hỏng sẽ đá qua đá lại mãi mãi, vì mỗi lần boot đều thấy "model không nạp được" và đều kết luận "chắc slot kia tốt hơn". `rtc_ntp_set` = 1 khi DS3231 đã từng được một lần SNTP đặt lại. **Tầng nối dây ghi khoá này, không phải `sys_time`**: §4.5.4 cấm phụ thuộc ngang tầng nên L2 `sys_time` không gọi được L2 `sys_storage` (§6.2.5). `seed_ver` là số hiệu bộ gieo đang nằm trên thiết bị, xem luật ngay dưới bảng |
| `ui` | `brightness` (u8), `volume` (u8), `lang` (str: `vi` / `en`) | | không nhạy cảm, cho phép sửa từ màn hình cài đặt. `lang` vắng mặt, rỗng, hay mang giá trị lạ đều rơi về `vi` (§3.1 CLAUDE.md luật 4) — một mã ngôn ngữ gõ sai phải ra màn hình đọc được, không phải màn hình trống |
| `vision` | `detect_min` (u32, ‰), `live_min` (u32, ‰), `match_min` (u32, ‰), `face_min_px` (u32), `present_mm` (u32, mm) | | bốn ngưỡng của §4.5.5d cộng ngưỡng "có người" của §2.3D; boot đầu gieo từ `Kconfig` của `svc_vision`, đổi bằng `SET_CONFIG` |
| `attend` | `dedup_min` (u32, phút), `allow_no_spoof` (u8) | | hai quyết định nghiệp vụ của §4.5.5f; boot đầu gieo từ `Kconfig` của `svc_attendance` theo đúng luật của `vision`, đổi bằng `SET_CONFIG`. `allow_no_spoof` chỉ để bàn thử chạy khi ảnh model chưa có nhánh spoof, mặc định 0 |

**`device/serial` là danh tính, không phải bí mật.** Thiếu khoá thì `sys_storage` dựng
`deviceId` từ MAC nhà máy: `kiosk-` cộng 12 hex thường của `esp_efuse_mac_get_default`, 18 ký
tự, lọt `^[A-Za-z0-9_-]{4,32}$` mà `attendance_record.schema.json` đòi; NVS có khoá thì khoá
thắng, đúng đường `device/tz` đè lên `CONFIG_SYS_TIME_TZ`.

Chỗ khác `wifi/pass` nằm ở hậu quả khi sai. Server khử trùng bằng `unique(deviceId, localId)`
(§4.6), nên `deviceId` đổi một lần là mọi bản ghi cũ mồ côi — không trùng, không mất, chỉ là
không ai nối được chúng với thiết bị nữa. eFuse do Espressif nung sẵn và **`erase-flash` không
chạm tới**, nên một board giữ nguyên tên qua cả lần xoá sạch NVS. Cái giá là
`kiosk-a1b2c3d4e5f6` không đọc ra nghĩa; tên cho người đọc nằm ở bảng device của backend (§4.6),
vì tên đổi được còn khoá khử trùng thì không.

**`device/mqtt_uri` mang cả scheme trong một chuỗi.** `esp-mqtt` nhận thẳng URI, nên đổi môi
trường là đổi một giá trị chứ không sửa dòng code nào:

```
bàn      mqtt://192.168.x.x:1883     không TLS
thật     mqtts://mqtt.<domain>:8883  TLS, cert CA nhúng trong firmware (§7.2)
```

Hai dòng ấy khác nhau **cả scheme**, nên một cặp địa chỉ với cổng sẽ đẩy scheme sang khoá thứ ba
hoặc bắt suy ra từ số cổng — suy từ cổng là lỗi âm thầm đắt nhất ở đây: gõ nhầm một chữ số là
kiosk gửi dữ liệu chấm công **không mã hoá** mà không gì kêu lên. Hai chốt chặn đi kèm đều nằm
ở lúc biên dịch: giá trị lùi là `Kconfig` của `net_mqtt`, vì máy chủ là của bên bán nên mọi máy
xuất xưởng trỏ về cùng một chỗ và NVS chỉ ghi đè khi khách tự dựng server riêng (§7.3); và bản
`prod` **từ chối mọi URI không bắt đầu bằng `mqtts://`**.

**Chuỗi rỗng tính là vắng mặt.** Mọi nơi đọc một khoá `str` của bảng trên phải coi độ dài 0
giống hệt `ESP_ERR_NVS_NOT_FOUND` rồi rơi về giá trị lùi. NVS giữ được chuỗi rỗng, nên phân biệt
"có khoá" với "có giá trị" là phân biệt sai: `net_provision` hỏi `device/jwt` để biết còn phải
đăng ký hay không (§7.3), và một khoá rỗng đọc ra `ESP_OK` sẽ khiến nó tưởng đã có token rồi
**bỏ hẳn bước đăng ký, không một dòng log**.

**Ghi NVS trên bàn đi qua console, không qua ảnh phân vùng.** `main/app_console.c` nhận
`set`/`get`/`del` trên USB rồi ghi qua `sys_storage`, nên không giá trị bí mật nào phải tồn tại
dưới dạng file. `del` có mặt vì thiếu nó thì cách duy nhất để dọn một khoá là đặt chuỗi rỗng,
tức tạo ra đúng trạng thái mà luật ngay trên phải đi vá. `Kconfig` của nó mặc định tắt và chỉ
bật ở `sdkconfig.dev` với `sdkconfig.bench`, nên bản `prod` không biên dịch một dòng nào — một
cờ lúc chạy thì không đủ, vì cờ ấy nằm trong chính NVS mà console ghi được.

`nvs_partition_gen.py` bị loại vì nó ghi đè **cả phân vùng**, cuốn theo `sys/boot_count` — nửa
cao của mọi `local_id`. Nạp lại địa chỉ broker bằng đường ấy là thiết bị sinh lại những
`local_id` đã gửi đi, và server khử trùng bằng đúng khoá đó sẽ nuốt bản ghi mới như bản trùng:
mất bản ghi chấm công, im lặng. Đường nạp ngoài hiện trường không dùng console — xem §7.3.

**Gieo một lần là không đủ: bộ gieo phải có số hiệu.** Luật "boot đầu gieo, sau đó NVS sở hữu"
đúng cho giá trị người vận hành đã đặt, nhưng nó khoá luôn cả những thiết bị **chưa ai đặt gì**:
một phép đo mới đổi `Kconfig` thì thiết bị đã boot một lần vẫn giữ số cũ, im lặng, mãi mãi.
Đây không phải giả định — board dev giữ `vision.live_min` = 500‰ suốt từ trước E8-T12 trong khi
firmware gieo 750‰, tức ngưỡng chống giả mạo thấp hơn số đo được **250‰** mà không log nào kêu.

Nên `main` giữ một hằng `APP_SEED_VER` cạnh bảng gieo và so với `sys.seed_ver` của thiết bị:
thiếu khoá hoặc số của thiết bị nhỏ hơn thì **gieo đè toàn bộ bảng** rồi ghi số mới; bằng nhau
thì giữ nguyên đúng như luật cũ. Nâng `APP_SEED_VER` là cách duy nhất một phép đo mới đi tới
thiết bị đã chạy, và cái giá của nó là **mọi giá trị `SET_CONFIG` đã đặt bị ghi đè một lần** —
vì vậy chỉ nâng khi con số trong `Kconfig` thật sự đổi, không nâng theo phiên bản firmware.

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

**`fwVersion` phải so sánh được, nên nó là `MAJOR.MINOR.PATCH`.** Không đặt `PROJECT_VER`
thì ESP-IDF lấy `git describe`, ra chuỗi kiểu `4a98339-dirty` — chuỗi ấy **nói được máy đang
chạy commit nào nhưng không nói được cái nào mới hơn**, mà `minFwVersion` của
`ota_manifest.schema.json` tồn tại đúng để trả lời câu ấy: chặn một ảnh model mới rơi xuống
firmware quá cũ để đọc nó. So hai chuỗi băm thì không chặn được gì.

Nguồn duy nhất là `PROJECT_VER` trong `firmware/CMakeLists.txt` (§4.9), từ đó `esp_app_desc_t`
mang đi khắp nơi: heartbeat, trang *Thiết bị của tôi*, và phép so của OTA. **Truy vết vẫn còn
nguyên mà không cần nhét băm git vào chuỗi version**: `esp_app_get_elf_sha256()` định danh
chính xác bản build, và nó không phải là thứ đem ra so lớn bé nên hai vai không giẫm nhau.

**`modelVersion` thì ngược lại — nó là danh tính, không phải thứ tự.** §6.2.2 đã chốt: gặp
embedding của model khác thì **từ chối**, chứ không so xem cái nào mới hơn, vì hai không gian
vector khác nhau thì không có "mới hơn". Nên `modelVersion` giữ nguyên dạng băm; chỉ `fwVersion`
mang số hiệu có thứ tự.

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

#### 6.2.4 `db/faces.bin` — header 32 B + bản ghi 576 B

**Header file (32 B, ở đầu file)** — có `format_ver` để sau này còn migrate được:

| Offset | Kích thước | Trường |
|---|---|---|
| 0 | 4 | `magic` = `'FDB1'` |
| 4 | 2 | `format_ver` u16 |
| 6 | 2 | `record_size` u16 = 576 |
| 8 | 4 | `record_count` u32 (kể cả bản ghi đã xoá mềm) |
| 12 | 8 | `updated_at` i64 epoch ms |
| 20 | 8 | `reserved` |
| 28 | 4 | `crc32` của byte 0..27 |

**Bản ghi (576 B mỗi cái, `format_ver` = 2)**

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
| 536 | 32 | `name` char[32] | UTF-8, có `\0` cuối; rỗng thì màn hình hiện mã số |
| 568 | 4 | `reserved` | chừa chỗ để thêm trường mà không phá format |
| 572 | 4 | `crc32` | băm byte 0..571 |

500 người × 2 template = 1.000 bản ghi = **576 KB**, thoải mái trong 4 MB.

**Vì sao tên nằm trên thiết bị, không chỉ ở server.** Kiosk phải nói được "Chào anh Việt" ngay
lúc mở cửa, kể cả khi mất mạng — mà mất mạng là trạng thái §6.2.6 coi là bình thường. Một mã số
trên kính không nói với ai điều gì. 32 byte UTF-8 đủ cho một tên tiếng Việt viết đủ dấu, và
`record_size` vẫn chia hết cho 8 nên embedding giữ nguyên căn lề 8 byte mà kernel PIE cần
(§4.5.5g). Tên **không** vào phép so khớp: nó chỉ là nhãn đi kèm bản ghi.

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
└── snd/ok.wav                                    # 16 kHz, 16-bit, mono
```

Mount **read-only**, không bao giờ ghi lúc chạy → dùng SPIFFS là đủ, nhẹ hơn LittleFS. Cập nhật bằng cách ghi đè cả partition qua OTA. Ảnh do `assets/build_assets.py` dựng bằng `spiffsgen.py` của IDF; script giữ **bảng ánh xạ** từ tên file nguồn sang tên trên thiết bị, nên đổi file âm thanh không phải sửa một dòng firmware nào.

**Máy chỉ lên tiếng khi nó mở cửa.** Bảng ban đầu có bốn tiếng `ok / denied / spoof / enroll`; giờ chỉ còn `ok.wav`. Một lần từ chối đã hiện chữ và đổi màu khung ngắm ngay trước mặt người đứng đó (§4.5.5h.1), còn phát tiếng cho nó thì **thông báo cái trượt của người ta ra cả phòng** — kiosk đặt ở cửa, người xung quanh nghe được. Tiếng nói "xong rồi, đi được" là thứ duy nhất người dùng cần nghe mà không phải nhìn màn. `attend_task` vì thế chỉ đẩy `APP_SOUND_OK` vào `q_audio`, và bảng `app_sound_t` giữ nguyên bốn giá trị để không phá hợp đồng của `app_events.h`.

Font không nằm ở đây: bốn bảng chữ 4bpp của kiosk biên dịch thẳng vào ảnh firmware (`assets/fonts/kiosk_ui_{15,20,24,28}.c`, §4.5.5h), vì chúng phải vẽ được trước khi mount xong bất cứ thứ gì.

### 6.3 Bảng dữ liệu — nằm ở đâu và vì sao

| Dữ liệu | Kích thước | Vùng | Cách cấp phát | Vì sao |
|---|---|---|---|---|
| Camera FB ×4 (480×320 RGB565) | 4 × 300 KB = 1.200 KB | **PSRAM** | `fb_location = CAMERA_FB_IN_PSRAM`, `fb_count = 4`, `grab_mode = CAMERA_GRAB_LATEST` | Quá lớn cho SRAM. Một cấu hình cho cả preview và AI (§2.1), nên không có buffer riêng cho nhánh AI. **Cần 4 chứ không phải 3**: `ai_task` giữ một khung tới 2 giây và `cam_task` giữ một khung suốt lúc vẽ, nên với 3 khung cảm biến không còn chỗ để lấp khung kế tiếp và chu kỳ thành *lấp + xử lý* thay vì `max(lấp, xử lý)` — đo 11/09: preview **8,1 fps** với 3 khung, **14,18 fps** với 4, cùng phòng cùng bản (`docs/measurements/latency.md` §6) |
| LCD frame buffer 320×480 RGB565 | 300 KB | **PSRAM** | `heap_caps_malloc(..., MALLOC_CAP_SPIRAM)` | |
| LCD bounce buffer (2 × 32 dòng) | 2 × 20.480 B = **40.960 B** | **SRAM (DMA)** | `MALLOC_CAP_DMA \| MALLOC_CAP_INTERNAL` | SPI DMA đọc trực tiếp từ PSRAM bị giới hạn → bắt buộc bounce qua RAM nội. Hai đệm chứ không một: nạp lại cái đang chờ truyền là thứ vẽ ra sọc dọc (E7-T5). **32 dòng chốt bằng bảng đo 19/09** — xem luật ngay dưới §6.4 |
| **`arena_fast`** — detect một mình @160×120 | **189.628 B** đo thật | **PSRAM** | `heap_caps_aligned_alloc(16, n, MALLOC_CAP_SPIRAM)` | Không nhánh nào nằm vừa SRAM nội (§6.4); `ai_engine` cấp theo `arena_hint` rồi làm tròn lên bội KB |
| **`arena_big`** — anti-spoof @80×80 và recognition @113×113 **chung một `MicroAllocator`** | **748.524 B** đo thật 18/09 (V1SE nhập); 422.764 B với student width 32 | **PSRAM** | như trên | `Σ tail + max(head)` theo §3.8, không phải tổng hai arena. Bản hai backbone từng chiếm 823.148 B |
| Trọng số 3 model `.tflite` | ~1.7 MB | **Flash mmap** | `esp_partition_mmap` | Không tốn RAM |
| Ảnh crop 113×113×3 int8 (recog input) | 38.3 KB | **SRAM** | static buffer | Vào thẳng `Invoke()` |
| Ảnh crop 81×81×3 int8 (spoof input) | 19.7 KB | **SRAM** | static buffer | |
| Bảng embedding (500 người × 512 chiều) | 1 MB nếu float32 — **256 KB nếu int8** | **PSRAM** (cache) + `storage` (bản gốc) | `MALLOC_CAP_SPIRAM` | Cosine search quét toàn bảng → phải ở RAM. **Khuyến nghị int8 + scale**, mất < 0.3% accuracy |
| Log chấm công offline | tới 4 MB | **Flash LittleFS** | append-only | Chịu được mất điện |
| Cert TLS + device JWT | ~4 KB | **NVS mã hoá** | `nvs_flash` + NVS encryption | |
| Cover map của `ui_kiosk` | 320×104 + 168×46 + 320×480 (màn không video) | **PSRAM** | `heap_caps_malloc` | 1 byte mỗi pixel: 4 bit chỉ số bảng màu (0 để lọt video) + 4 bit độ phủ (§4.5.5h) |
| Wi-Fi + lwIP buffer | ~55 KB | **SRAM (bắt buộc)** | IDF tự quản | Không thể để PSRAM |
| Stack 10 task | ~53 KB | **SRAM (bắt buộc)** | FreeRTOS | |

### 6.4 Ngân sách SRAM 512 KB

| Mục | Ước tính |
|---|---|
| `.data` + `.bss` firmware (LVGL, TFLM, driver) | ~70 KB |
| Wi-Fi + lwIP (BT tắt) | ~55 KB |
| Stack 10 task | ~53 KB |
| LCD bounce + DMA descriptor | **~42 KB** |
| Buffer ảnh crop (spoof + recog) | ~57 KB |
| Heap dự phòng (malloc lặt vặt, TLS handshake ~30 KB) | ~60 KB |
| **Còn lại cho arena** | **≈ 175 KB** |

**Đệm bounce 40.960 B là khoản lớn thứ hai của RAM nội.** `drv_lcd` cấp hai đệm 20.480 B. Con
số cũ là 48 dòng — đúng 1/10 khung 307.200 B, một lựa chọn tròn ở E7-T5 không kèm số đo — và
32 dòng thu về **20.480 B**, đủ cho `ota_task` 8 KB cộng biên tử tế cho `sync_task` (§5.2), với
giá là 15 lượt DMA mỗi khung thay vì 10.

Ràng buộc phải giữ khi đụng vào là điều kiện của §2.3A: **`T_w < 2·T_s`**. Panel chạy **24 Hz**
(`drv_lcd` ghi `0xB1`) nên `T_s` = 41,7 ms và trần là **83,4 ms** — tia quét chạy trước con trỏ
ghi suốt vòng đầu và chỉ đuổi kịp ở vòng sau, nên phép ghi được phép dài hơn một khung, chỉ
không được dài hơn hai.

Quét 19/09, mỗi mức 5 mẫu preview, `T_w` đo từ sau khoá pha tới strip cuối:

| Dòng | Strip mỗi khung | `T_w` median | `T_w` max | Biên tới 83,4 ms | fps | Hai đệm |
|---|---|---|---|---|---|---|
| 48 | 10 | 37,8 ms | 42,5 ms | 40,9 ms | 11,58–13,61 | 61.440 B |
| **32** | 15 | **38,9 ms** | 41,6 ms | 41,8 ms | 12,30–13,48 | **40.960 B** |
| 20 | 24 | 44,2 ms | 49,2 ms | 34,2 ms | 11,47–12,98 | 25.600 B |

**Cả ba đều thừa biên, và mắt không thấy khấc ở mức nào** — chủ repo nhìn kính từng mức. Chốt
**32**: thu về 20.480 B với giá 1,1 ms, trong khi 20 dòng đòi thêm 6,4 ms để lấy thêm 15 KB.
6,4 ms ấy không miễn phí dù không xé: nó là thời gian CPU của `cam_task` trên **core 0**, nơi
§5.2 đã ghi là core đông. 20 dòng vẫn còn đó, đã đo và đã nhìn, nếu sau này cần thêm RAM.

🔬 **Bảng này so ba mức được, nhưng không so chính xác được.** `T_w` đo bằng đồng hồ tường nên
nó gồm cả lúc `cam_task` bị chiếm chỗ trên core 0, và phép quét không khoá tải AI lẫn ánh sáng.
Bằng chứng: chính bản 32 dòng ấy, đo lại lúc có mặt người và gain 64/16, cho `T_w` **43,7–51,2 ms**
thay vì 37,3–41,6 ms của lượt quét, và fps 11,0–11,5 thay vì 12,3–13,5. Chênh lệch giữa ba mức
nhỏ hơn chênh lệch do tải gây ra, nên **thứ bảng này chốt được là "cả ba đều dưới trần 83,4 ms",
không phải "mức nào nhanh hơn mức nào bao nhiêu"**. fps thì trần camera 14,19 đã chặn trước rồi.

Muốn con số sạch thì phải đo trong `test_apps` không có AI và ánh sáng cố định — chưa cần, vì
quyết định chỉ dựa vào trần.

**Hệ quả, sau khi E8-T7 đo thật** (`docs/measurements/arena.md`):

| Arena | Dùng | Cấp | Ở đâu | So với bảng trên |
|---|---|---|---|---|
| `arena_fast` — detect một mình | 189.628 B | 224 KB | SRAM nội | vượt **49 KB** |
| `arena_big` — spoof + recog chung | 748.524 B | 466 KB | PSRAM | bảng này không tính, vì chỉ tính SRAM |

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
detect, tức 2,0% của một lượt 1.159 ms. Trong 267 KB kia có 40.960 B bounce buffer LCD bắt
buộc là DMA nội, nên không có cách nào giữ `arena_fast` ở SRAM mà vẫn đủ chỗ cho LCD.

Đường quay lại khi model nhỏ đi: **thu nhỏ model trước, bật `AI_ARENA_FAST_INTERNAL=y` sau**.
`arena_big` đã nhỏ đi hai lần và cả hai đều là số đo: hạ `width` của recognition xuống 32
đưa 823.148 B về 476.188 B, bỏ nhánh ngữ cảnh của anti-spoof đưa tiếp về 422.764 B; rồi lên lại
**748.524 B** khi V1SE nhập thay student (ADR-0004), vì đầu spoof 675 KB lớn hơn đầu recog 412 KB.
`arena_fast` chỉ nhỏ đi khi chính detect nhỏ đi.

Bảng trên là ngân sách **tổng**, mà thứ chặn `arena_fast` lại là dải liền mạch (§3.8).

**E8-T9 đã đo, 13/09** (`docs/measurements/arena.md` §9), kiosk chạy thật với ngoại vi cắm đủ:

| Mốc | RAM nội trống | PSRAM trống |
|---|---|---|
| trước `app_boot` | 249 KB | 8.189 KB |
| sau `app_boot` (ba model đã nạp) | 95 KB | 5.844 KB |
| kiosk chạy, đáy qua 6 mẫu | **71 KB** | 5.844 KB |

Hệ chi **260 KB** cho năm dòng chưa tính, sát con số ước 267 KB. Đáy đứng yên qua cả sáu mẫu
nên không có chỗ nào rò. Hai khoản **chưa** trả đồng nào: LVGL chưa tồn tại, và lượt đo ấy
Wi-Fi không vào được mạng nên chưa có phiên TCP lẫn 30 KB bắt tay TLS.

Con số phải mang sang E10-T1 không phải 71 KB mà là **mảnh liền mạch lớn nhất: 32 KB**. Đệm vẽ
LVGL xin quá mức đó ở RAM nội sẽ trượt dù tổng còn trống, đúng cơ chế đã hạ `arena_fast` xuống
PSRAM; heap LVGL vì thế nằm ở PSRAM, nơi còn 5,8 MB.

**Đo lại 18/09 khi hai khoản kia đã trả** (`arena.md` §13): giao diện tám màn hình, `audio_task`
và một phiên Wi-Fi vào mạng thật đều đã lên.

| Mốc | 13/09 | **18/09** |
|---|---|---|
| đáy RAM nội, kiosk chạy | 71 KB | **40 KB** |
| mảnh liền mạch lớn nhất | 32 KB | **31 KB** |
| đáy PSRAM | 5.844 KB | 5.070 KB |

Đáy vẫn phẳng qua sáu mẫu nên không có chỗ rò; hệ chỉ đơn giản đã chi thêm 31 KB cho những thứ
mới. **Bảng chi tiết từng thành phần — tĩnh theo component, ngăn xếp từng task, các khối DMA
lớn, và sổ PSRAM khép được tới 0,24 % — nằm ở `docs/measurements/ram.md`.** Hai điều bảng ước tính ở đầu §6.4 không nói ra mà số
đo nói: **đệm bounce của LCD 61.440 B cộng đệm DMA của camera 30.720 B là 92 KB, hơn một nửa
heap lúc boot, và không có đường nào đẩy sang PSRAM**; còn heap nội **không phải một khối** —
heap chính 244 KB đã đầy (mảnh lớn nhất 4 KB, đáy 1.708 B), toàn bộ 31 KB liền mạch nằm ở một
vùng riêng chưa ai từng xin. Nên "còn 40 KB" không có nghĩa là xin được một khối 40 KB.

**Khoản duy nhất của bảng trên còn chưa trả là bắt tay TLS**, và đó là chỗ chật: mặc định
mbedTLS của IDF là đệm vào 16 KB cộng đệm ra 4 KB **mỗi phiên**, trong đó đệm vào phải là một
dải liền 16 KB lấy từ đúng mảnh 31 KB; cộng ngăn xếp `mqtt_task` 6 KB và `sync_task` 5 KB của
§5.2, 40 KB tiêu gần hết trước khi phân tích chuỗi chứng thư. **Đã chốt 18/09: `MBEDTLS_EXTERNAL_MEM_ALLOC=y`**, khai ở
`sdkconfig.defaults.esp32s3` vì đây là quyết định của board chứ không của một profile. Chọn nó
thay vì hạ `MBEDTLS_SSL_IN_CONTENT_LEN` hay bật đệm động vì cả hai cách kia **vẫn giữ TLS trong
RAM nội** — chỉ giảm bớt phần ăn — trong khi cách này đưa hẳn sang nơi còn 5 MB và trả lại
nguyên vẹn lưới an toàn 32 KB của DMA. Hạ ngưỡng còn thêm một rủi ro không đáng: bản tin bắt tay
lớn hơn đệm là **hỏng tay bắt**, mà kích thước chuỗi chứng thư thì do broker quyết. Cái giá là
bắt tay chạy trên PSRAM nên chậm hơn, 🔬 chưa đo — bắt tay chỉ xảy ra lúc nối lại, không phải
mỗi bản ghi. Nghiệm trên board sau khi gạt: Wi-Fi vẫn nối được và SNTP vẫn chỉnh được giờ.

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
│          └─► EMQX (MQTTS, auth+ACL hỏi API)          │
└──────────────────────┬────────────────────────────────┘
                       │ HTTPS + WebSocket
                       ▼
              Next.js trên Vercel (dashboard)
```

### 7.2 Bảo mật — checklist

| Hạng mục | Cách làm |
|---|---|
| Kiosk ↔ broker | MQTTS 8883, cert CA nhúng trong firmware, user/pass riêng từng device; EMQX hỏi `api` qua HTTP để chấm auth và ACL, ACL chỉ mở `kiosk/{chính nó}/#` — xem §7.4 cho phần đã dựng được trước khi có `api` |
| Device token | JWT 90 ngày lưu **NVS encrypted**, xoay vòng tự động khi còn 7 ngày |
| Web ↔ API | Access JWT 15 phút (memory) + refresh httpOnly cookie 7 ngày, có bảng revoke |
| Dashboard EMQX | Cổng `18083` **không map ra ngoài**; muốn xem thì qua traefik có xác thực, và đổi mật khẩu mặc định `admin/public` ngay lần chạy đầu |
| Flash | Bật **Flash Encryption** + **Secure Boot v2** ở bản production |
| OTA | Verify sha256 + chữ ký; rollback tự động nếu boot lỗi (`esp_ota_mark_app_valid_cancel_rollback`) |
| Dữ liệu sinh trắc | Chỉ lưu **embedding**, không lưu ảnh gốc trên kiosk. Ảnh chấm công lưu server có TTL |
| Rate limit | `@nestjs/throttler` cho `/auth/login` |

### 7.3 Vòng đời thiết bị — từ dây chuyền tới lúc thu hồi

§7.2 nói JWT xoay vòng khi còn 7 ngày, nhưng **không nói cái JWT đầu tiên ở đâu ra**. Mục này
lấp chỗ đó, và ràng buộc thiết kế của nó là: **một máy xuất xưởng không được đòi ai gõ gì vào
nó**. Mọi giá trị riêng từng máy hoặc do phần cứng sinh ra, hoặc do máy tự xin, chứ không do
người cắm USB nhập tay — cách ấy không nhân lên được quá vài chục máy, và `app_console` vốn đã
bị `Kconfig` loại khỏi bản `prod`.

| Giá trị | Mỗi máy một khác | Tới thiết bị bằng cách nào |
|---|---|---|
| `deviceId` | Có | **eFuse MAC**, 0 thao tác (§6.2.1) |
| Cert CA của server | Không | Nhúng trong firmware |
| `device/mqtt_uri` | Không | **`Kconfig` của bản build**, NVS chỉ ghi đè khi khách tự dựng server (§6.2.1) |
| Token bootstrap | Không, theo **lô firmware** | Nhúng trong firmware |
| `wifi/ssid`, `wifi/pass` | Có, theo nơi lắp | Người lắp gõ **trên màn kiosk** (E10-T5 còn nợ) |
| `device/jwt`, `mqtt_user`, `mqtt_pass` | Có | Máy **tự xin** ở bước 3 dưới đây |

**Sáu bước:**

1. **Xuất xưởng** — nạp firmware có Secure Boot v2 và Flash Encryption (§7.2). Không ai gõ gì
   riêng cho từng máy; hai máy cạnh nhau nhận đúng cùng một ảnh nhị phân.
2. **Lắp đặt** — cấp điện. Không có `wifi/ssid` thì kiosk mở thẳng màn hình chọn Wi-Fi.
3. **Đăng ký** — có mạng nhưng chưa có `device/jwt`, kiosk gọi `POST /devices/register` qua
   HTTPS, kèm token bootstrap và `deviceId`. Máy chủ tạo bản ghi trạng thái `pending` và trả
   **202**, chưa cấp token. Kiosk hiện `deviceId` của chính nó lên màn rồi hỏi lại theo chu kỳ
   lùi bậc.
4. **Nhận máy** — admin thấy máy `pending` trong dashboard, đối chiếu `deviceId` in trên màn,
   bấm duyệt rồi đặt tên người đọc được và vị trí. Lần hỏi kế tiếp trả **200** kèm JWT 90 ngày
   và cặp `mqtt_user`/`mqtt_pass`; kiosk ghi NVS và **không bao giờ dùng lại token bootstrap**.
5. **Chạy** — MQTTS bằng credential riêng, xoay vòng theo §7.2.
6. **Thu hồi** — admin gỡ máy: API từ chối token, ACL của EMQX đóng, kiosk nhận lỗi xác thực
   rồi **quay về bước 3**.

**Vì sao cấp token sau khi duyệt chứ không trước.** Cấp trước thì một máy chưa ai nhận vẫn nối
được broker và đẩy dữ liệu vào, nên máy chủ phải chứa bản ghi của một thiết bị không ai chịu
trách nhiệm — hoặc phải đẻ thêm một tầng ACL riêng cho trạng thái `pending`. Giữ nó ở `202` thì
thiết bị chưa được nhận **không có gì để nối bằng**, và không cần ACL đặc biệt nào.

**`deviceId` quay lại sau factory reset là chuyện bình thường, không phải lỗi.** Nút BOOT giữ 5 s
(§2) xoá `wifi`, `device` và bảng khuôn mặt, nhưng eFuse thì không xoá được, nên máy trở lại
bước 3 với **đúng cái tên cũ**. Máy chủ vì thế phải cho một `deviceId` đã biết đăng ký lại, đánh
dấu bản ghi cũ là đã thu hồi và đòi duyệt lại từ đầu. Bản ghi chấm công cũ giữ nguyên `deviceId`
ấy và nằm trong lịch sử của chính thiết bị đó.

**Token bootstrap là mắt xích yếu nhất, và ghi ra đây để không ai tưởng nó mạnh.** Nó dùng chung
cho cả lô nên rò một máy là rò cả lô. Ba thứ giữ thiệt hại ở mức chấp nhận được: nó **chỉ gọi
được `POST /devices/register`** chứ không mở gì khác; máy đăng ký trộm nằm ở `pending` vĩnh viễn
cho tới khi một con người bấm duyệt; và Flash Encryption khiến không đọc được nó ra khỏi flash.
Xoay vòng nó là một bản OTA. Muốn chắc hơn thì phải **cấp cert riêng từng máy ngay trên dây
chuyền và dùng mTLS** — mạnh hơn hẳn, nhưng đòi một trạm nạp có CA riêng, nên để khi sản lượng
đủ lớn mới đáng.

### 7.4 Broker trước khi có `api`

§7.2 giao cho EMQX hỏi `api` qua HTTP mỗi lần một kiosk nối, nhưng `api` là E11 và chưa tồn tại.
Phần dựng được ngay là **hình dạng phía thiết bị**, và nó là bản cuối:

| Thứ | Giá trị | Đổi gì khi E13-T4 tới |
|---|---|---|
| Cổng | `8883`, TLS | không |
| Cert CA | tự ký, nhúng trong firmware | thay bằng CA thật, firmware nạp lại |
| Username | `deviceId` | không |
| Password | token của máy | không |
| ACL | `kiosk/{username}/#`, ngoài ra cấm | không |
| **Nơi EMQX tra cứu** | `built_in_database` | **đổi sang `http` gọi `api`** |

Chỉ hàng cuối đổi.

**ACL phải có hai vai, không phải một.** Luật `kiosk/${username}/#` nhốt mỗi máy trong nhánh
của chính nó, và đó đúng là thứ cần cho thiết bị. Nhưng `api` của E11 phải đọc bản ghi của
**mọi** kiosk — `kiosk/+/up/#` — và đẩy lệnh xuống **mọi** kiosk — `kiosk/+/down/#`. Không luật
nào trong hai luật hiện có cho phép chuyện đó, nên `{deny, all}` chặn backend ngay từ gói
SUBSCRIBE đầu tiên. Đây là lỗ hổng lộ ra khi viết `svc_sync`, không phải khi làm E11: nếu để
tới lúc ấy mới phát hiện thì nó xuất hiện dưới dạng "backend không nhận được gì" với broker
lặng thinh.

| Vai | Tên đăng nhập | Được đọc | Được ghi |
|---|---|---|---|
| Thiết bị | `kiosk-<12 hex>` hoặc serial do vận hành đặt | `kiosk/{chính nó}/#` | `kiosk/{chính nó}/#` |
| Dịch vụ | **`svc-<tên>`** | `kiosk/+/up/#` | `kiosk/+/down/#` |

**Vai dịch vụ bị cấm ghi lên `up/` một cách tường minh**, dù nó chẳng cần tới. Lý do là bất
đối xứng của hai chiều: một bản ghi trên `up/` là **lời khai của thiết bị** — nó đi vào bảng
chấm công và trở thành bằng chứng ai có mặt lúc mấy giờ. Một tiến trình phía máy chủ bị chiếm
mà vẫn giả được `up/attendance` thì bảng chấm công không còn nói lên điều gì. Luật `deny` đặt
**trước** hai luật `allow`, vì EMQX đọc file ACL từ trên xuống và dừng ở luật khớp đầu tiên.

**Tiền tố `svc-` là tên dành riêng, và thứ thực thi nó là việc cấp tài khoản chứ không phải
thiết bị.** Thiết bị khai tên nào cũng được, nhưng nó chỉ nối được nếu `built_in_database` có
đúng tài khoản ấy — mà tài khoản chỉ do người vận hành tạo. Nên một kiosk lỡ đặt serial
`svc-sanh` không tự leo quyền được; phải có người vừa đặt tên ấy **vừa** tạo tài khoản ấy. Vì
vậy không thêm phép kiểm nào trong firmware: nó sẽ là code phòng thủ không phòng được gì.

Khi E13-T4 chuyển sang backend `http`, hai vai này thành hai câu trả lời của `api` thay vì hai
khối trong file — hình dạng quyền giữ nguyên, chỉ nơi tra cứu đổi.

**`deploy/watch.sh` là vai dịch vụ ấy dùng bằng tay.** Nó đăng nhập `svc-ops` với
`EMQX_OPS_PASSWORD` trong `deploy/.env` rồi nghe `kiosk/+/up/#`. Đường thay thế — bật
`emqx ctl trace` theo client — **chết cùng container**: một lần `docker compose up -d
--force-recreate` để đổi ACL là trace biến mất mà không báo gì, và người đang `tail -f` chỉ thấy
một file đứng im. Tài khoản thì nằm trong `built_in_database` trên volume `emqx-data`, nên nó
sống qua restart. `net_mqtt` gửi đúng một bộ `deviceId` cộng token cộng CA trong cả hai trường
hợp, nên nó viết một lần và không sửa lại — đó là lý do dựng TLS với xác thực ngay từ đầu thay
vì chạy nặc danh rồi quay lại.

**Cái mất khi chưa có `api`**: thu hồi một máy phải sửa `built_in_database` bằng tay thay vì
admin bấm một nút, và token không tự xoay vòng được (§7.2). Hai thứ ấy đều là việc của `api`,
không phải của broker.

**`gen_certs.sh` sinh CA và cert máy chủ, `certs/` không bao giờ commit.** `.gitignore` chặn
`*.pem`, `*.key`, `*.crt`. Ngoại lệ đúng một file: **cert CA là công khai** và firmware cần nó
lúc biên dịch để nhúng, nên bản sao ấy nằm trong cây firmware và được commit; khoá riêng của CA
cùng cặp khoá máy chủ thì không rời `deploy/emqx/certs/`.


### 7.6 Đổi Wi-Fi trên màn hình, không qua dây

**Console USB là công cụ bàn thí nghiệm, không phải sản phẩm.** `set wifi ssid` đổi được mạng mà
không phải nạp lại firmware, và điều đó đúng — nhưng nó đòi cắm cáp vào một máy tính có ESP-IDF.
Kiosk treo trên tường trong phòng khác thì không ai làm được thao tác ấy, và đó là lúc cần đổi
mạng nhất: công ty đổi router, đổi mật khẩu, dọn sang phòng mới.

Màn hình **Wi-Fi** làm đúng việc một chiếc điện thoại làm: quét, liệt kê theo cường độ sóng,
chạm chọn, gõ mật khẩu, kết nối. Bàn phím ở đây **không dùng chung với bàn phím nhập tên** — tên
người chỉ cần chữ cái, còn mật khẩu Wi-Fi cần cả hoa, thường, số và ký hiệu, nên nó có ba bộ ký
tự đổi bằng một phím chuyển.

**Nó vào từ Cài đặt, không từ menu gốc** (§4.5.5h.4): Wi-Fi là thuộc tính của máy, không phải
một việc người vận hành mở máy ra để làm.

**Cường độ sóng vẽ bằng vạch, không bằng số.** `-67` là đơn vị của người làm radio; bốn vạch cao
dần là thứ mọi người đã đọc được sẵn từ điện thoại. Ngưỡng chia vạch là chuyện **hiển thị**, không
phải ngưỡng nghiệp vụ, nên nó không sinh khoá nào cho §4.9. Mạng có khoá mang thêm hình ổ khoá.

**Danh sách tự làm mới trong lúc đang mở.** Đứng nhìn một danh sách chết cho tới khi bấm "Quét
lại" là thứ chỉ có trên thiết bị nhúng; điện thoại quét lại nền và danh sách tự đổi. Màn này
xin quét lại mỗi `WIFI_RESCAN_MS` chừng nào nó còn đang hiện danh sách, và **dừng hẳn** khi
người dùng đã chuyển sang gõ mật khẩu — quét thả link, nên quét trong lúc đang nối là tự phá.

**Quét chạy ở `sync_task`, không ở `ui_task`.** `esp_wifi_scan_start(NULL, true)` chặn 2–4 giây
và thả link trong lúc quét; đặt nó trên task vẽ màn hình là **màn hình đứng hình** đúng lúc người
dùng vừa bấm. `ui_kiosk` chỉ giương cờ xin quét, `sync_task` quét rồi trả danh sách về — cùng
đường mà `People` đã dùng cho danh sách người.

**Chỉ ghi NVS khi mạng thật sự trả lời.** `net_wifi_join` đặt cấu hình, gọi `esp_wifi_connect`,
chờ tới `WIFI_JOIN_WAIT_MS`, và **chỉ khi vào được** mới ghi `wifi/ssid` với `wifi/pass`. Ghi
trước rồi mới thử là cách một lỗi gõ mật khẩu khoá kiosk khỏi đúng cái mạng nó vẫn đang dùng
được — sau lần khởi động kế tiếp thì không còn đường nào vào nữa.

**Hai kiểu struct cho một danh sách mạng, có chủ ý.** `net_wifi_ap_t` là của radio,
`ui_kiosk_ap_t` là của màn hình; tầng nối dây chuyển đổi. Cho `ui_kiosk` (L6) gọi thẳng
`net_wifi` (L3) thì màn hình biết về sóng radio, và §4.5.4 dựng ra để chặn đúng chuyện đó.

---

### 7.5 Vòng đời nhân viên — server giữ danh tính, máy giữ khuôn mặt

**Hiện tại kiosk tự bịa `employee_id`.** `svc_facedb_next_employee_id()` lấy id lớn nhất trong
bảng rồi cộng một. Với một máy thì chạy; với hai máy thì **cả hai cùng sinh ra id 1 cho hai
người khác nhau**, và lúc gộp dữ liệu lên server không có cách nào tách ra. Đây là lỗi phải sửa
trước khi có máy thứ hai, không phải tính năng còn thiếu.

**Chia vai theo vòng đời, không theo nơi bấm nút.** Một nhân viên tồn tại trong công ty nhiều
năm; một template khuôn mặt tồn tại trên **một máy cụ thể** và mất khi máy hỏng. Hai thứ vòng
đời khác nhau thì không được chung một bản ghi:

| Thứ | Chủ sở hữu | Khoá |
|---|---|---|
| Nhân viên tồn tại, tên, mã nhân sự | **server** | `employeeId` do server cấp |
| Khuôn mặt đã có trên máy nào chưa | **server**, một dòng cho mỗi cặp | `(employeeId, deviceId)` |
| Template thật | máy, và bản sao ở server | `(employeeId, templateIdx)` |

**Trạng thái "đã thêm" phải theo từng máy, không phải một cờ.** Một fleet 5 kiosk thì "đã thêm"
không trả lời được câu "thêm ở đâu". Dựng nó thành cờ boolean là thứ sẽ phải đập đi ngay khi
gắn máy thứ hai.

**Người vận hành *chọn* nhân viên, không *gõ* UID.** Gõ tay một mã dài trên bàn phím cảm ứng là
mời gọi gõ nhầm — mà gõ nhầm ở đây nghĩa là **buộc khuôn mặt người này vào hồ sơ người kia**, một
lỗi im lặng và nghiêm trọng: người A chấm công ra tên người B, và không ai phát hiện cho tới khi
đối chiếu bảng lương. Nên server đẩy xuống **danh sách đang chờ đăng ký ở chính máy này**, màn
hình hiện tên, người vận hành bấm chọn. Nếu buộc phải gõ thì gõ **mã ngắn** rồi màn hình **hiện
tên lấy về để xác nhận trước khi chụp** — mấu chốt là con người phải thấy tên trước khi khuôn
mặt bị gắn vào đó.

**Tên hiển thị lấy từ server, không gõ lại ở máy.** Server đã có tên. Gõ lại là tạo hai cách
viết cho một người, mà cái hiện trên màn hình sau khi khớp lại là cái gõ ở máy. Chỉ khi mất mạng
mới cho gõ tay.

**Báo "đã thêm" phải đi đường ít nhất một lần.** Máy có thể đăng ký lúc rớt mạng. Nếu tin báo
ấy là một `publish` bắn đi rồi quên thì trạng thái trên server **lặng lẽ lệch** với thực tế dưới
máy, và không ai biết cho tới khi ai đó không chấm được. Dùng lại đúng bộ máy của `svc_sync`:
ghi xuống flash, gửi, đẩy con trỏ **sau** ack.

**Xoá là chiều nguy hiểm nhất, và nó phải *hội tụ* chứ không *áp delta*.** Một lệnh xoá gửi lúc
máy đang mất mạng mà chỉ gửi một lần thì **không bao giờ tới**, và hậu quả là khuôn mặt người đã
nghỉ việc vẫn mở được cửa — hỏng nặng nhất mà hệ này có thể hỏng. Nên máy không chỉ nghe lệnh
xoá: nó mang **số hiệu phiên bản danh sách** trong `heartbeat`, server thấy số cũ thì đẩy phần
còn thiếu xuống, **kể cả các lượt xoá**. Máy mất mạng một tuần rồi nối lại vẫn tự về đúng trạng
thái.

`storage_face_record_t` đã có `STORAGE_FACE_FLAG_DELETED`, nên bia mộ có sẵn ở tầng lưu trữ:
xoá mềm giữ được `employeeId` để đối chiếu, và `compact()` dọn khi quá 30% (§6.2.4).

**Xoá ở màn hình máy là một *yêu cầu*, không phải sự thật.** Nếu máy tự xoá rồi coi như xong,
lần hội tụ kế tiếp server sẽ đẩy người đó **quay lại**. Nên thao tác ấy gửi lên server, server
quyết, rồi kết quả chảy xuống theo đúng đường hội tụ.

**Template có rời khỏi máy không — đây là quyết định về quyền riêng tư, không phải kỹ thuật.**
Nếu có: máy thứ hai nhận được người mà không phải chụp lại, và máy cháy flash thì khôi phục
được. Nếu không: mỗi người phải đứng chụp ở từng máy, và một lần hỏng flash là mất sạch. Bản
thân `enroll_payload.schema.json` đã có `embedding` cùng `updatedAt` — người viết schema đã giả
định template có đi. **Chốt: template đi lên**, và vì nó là **dữ liệu sinh trắc**, server phải
mã hoá lúc lưu và không bao giờ trả nó ra API đọc thường.

**Đăng ký cần mạng, chấm công thì không.** Đăng ký là việc hành chính làm một lần, có người
đứng cạnh; chấm công là việc hàng ngày phải chạy khi mất mạng. Bắt đăng ký phải có server là
cách duy nhất giữ không gian id sạch — và nó xoá luôn chỗ `next_employee_id()` tự bịa ở trên.

**Hai luật khó nhất đã nằm sẵn trong `enroll_payload.schema.json` từ trước**, và chúng đúng:
`embeddingVersion` — *"A kiosk running a different model must refuse the template rather than
compare across models"* — và `updatedAt` — *"the kiosk keeps the newer of two conflicting
pushes"*. Cùng với `REPLACE_ALL` cho đường resync toàn phần, ba thứ ấy là xương sống của đồng bộ
và không phải nghĩ lại.

**Ba thứ hợp đồng còn thiếu, nay chốt:**

| Thêm | Ở đâu | Làm gì |
|---|---|---|
| Topic `kiosk/{deviceId}/up/enroll` | `mqtt_topics.yaml`, QoS 1 | Chiều lên: máy báo đã chụp được ai, hoặc người vận hành xin xoá ai |
| `rosterVersion` | `enroll_payload` **và** `heartbeat` | Con trỏ hội tụ |
| `ASSIGN` / `REVOKE` | enum `op` | Server báo trước "máy này sắp đăng ký người X, tên là Y" |

**`rosterVersion` là con trỏ, không phải số phiên bản để so sánh chơi.** Mỗi lệnh server đẩy
xuống mang theo **số mà máy sẽ đứng ở đó sau khi áp xong**; máy lưu lại và khai trong mọi
`heartbeat`. Server thấy số cũ hơn số nó giữ cho máy ấy thì đẩy đúng phần còn thiếu. **Không cần
ack riêng cho từng lệnh**: chính heartbeat là ack, và nó lặp mỗi 30 giây nên một lần rơi gói tự
lành. Đây đúng hình dạng con trỏ `cursor.bin` của §6.2.5, chỉ chạy ngược chiều.

**`ASSIGN` là thứ bỏ được phép gõ UID.** Server đẩy xuống `employeeId` kèm `fullName` mà không
kèm embedding; máy hiện thành danh sách chờ, người vận hành bấm chọn rồi chụp. `REVOKE` rút lại
khi phân công đổi. Nhờ vậy id **luôn do server cấp**, và chỗ `svc_facedb_next_employee_id()` tự
bịa biến mất.

**Thứ tự làm, vì không phải phần nào cũng đợi được backend.** Chuyển tải làm trước: máy áp được
`UPSERT` với `DELETE_EMPLOYEE` từ `down/enroll`, khai `rosterVersion` trong heartbeat, và báo
lên `up/enroll` sau mỗi lần đăng ký tại chỗ. `ASSIGN` cần một màn hình danh sách chờ (E10-T1),
`DELETE` một template và `REPLACE_ALL` cần `svc_facedb` mọc thêm API — ba thứ ấy đi sau.

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

---

## 9. Quản trị nhân sự — từ bảng chấm công thành hệ HR

### 9.1 Ranh giới: cái gì thuộc phần này, cái gì không

Phần §1–§8 dựng một **thiết bị chấm công** và một bảng điều khiển cho nó. Phần này dựng thứ
dùng dữ liệu ấy: hồ sơ nhân sự, nghỉ phép, lương, và cổng cho chính người lao động. Ranh giới
đặt ở đúng một chỗ: **kiosk không biết gì về lương**. Nó gửi lượt chấm công và nhận danh sách
người cần nhận diện, hết. Mọi thứ trong §9 sống ở server.

Lý do không chỉ là gọn: firmware đi qua OTA và một board ngoài hiện trường có thể chạy bản cũ
hàng tháng. Cho nó biết quy tắc tính công là chấp nhận việc hai máy cạnh nhau tính khác nhau
cùng một ngày.

**Ngoài phạm vi, có chủ ý**: tuyển dụng, đánh giá năng lực, đào tạo. Ba thứ ấy là hệ riêng,
gắn vào HR qua `employeeId` chứ không chia bảng, và không có cái nào chặn việc trả lương.

### 9.2 Ba chỗ hệ hiện tại không đỡ nổi quy mô này

Không phải phỏng đoán — cả ba đọc ra được từ code đang chạy.

**Bảng tổng hợp nạp toàn bộ bản ghi vào Node.** `reports.service.ts` gọi `findMany` trên cả
dải thời gian rồi gom bằng một `Map` trong JavaScript. Ở 30 nghìn nhân viên, hai lượt mỗi ngày,
một tháng là **1,8 triệu dòng** phải qua mạng, qua bộ giải mã, rồi nằm trong heap Node cùng lúc.
Đây là chỗ gãy trước tiên và gãy dứt khoát.

**`User` và `Employee` không nối với nhau.** Hai bảng rời, không khoá ngoại nào. Nghĩa là
**người lao động hiện không đăng nhập được** — chỉ có tài khoản quản trị. Không có cổng nhân
viên nào dựng được trước khi sửa chỗ này.

**`Employee.department` là một chuỗi.** Không có cây tổ chức, không có người quản lý trực tiếp,
nên câu hỏi "ai duyệt đơn này" và "trưởng phòng thấy được những ai" không có đường trả lời.

### 9.3 Mô hình dữ liệu

Nhóm theo việc, không theo bảng. Mọi bảng dưới đây nằm ở `backend/prisma/schema.prisma`.

**Tổ chức**

| Bảng | Giữ gì | Ghi chú thiết kế |
|---|---|---|
| `Department` | mã, tên, `parentId`, trung tâm chi phí, trưởng đơn vị | cây tự tham chiếu; truy vấn con cháu bằng CTE đệ quy |
| `JobTitle` | mã, tên, bậc | tách khỏi phòng ban: một chức danh tồn tại ở nhiều phòng |
| `EmploymentContract` | loại, ngày bắt đầu, ngày kết thúc, trạng thái | **nhiều bản một người**, vì tái ký là hợp đồng mới chứ không phải sửa hợp đồng cũ |

**Nhân sự** — `Employee` mở rộng: `departmentId`, `jobTitleId`, `managerId` (tự tham chiếu),
`hireDate`, `dateOfBirth`, `personalEmail`, `phone`, `taxCode`, `bankAccount`, `photoUrl`,
`locale`. `department` dạng chuỗi **bỏ đi**, dữ liệu cũ đổ sang `Department` theo tên.

`locale` mặc định `vi` và tồn tại vì **thư hệ thống gửi đi không có chỗ nào để hỏi người nhận
muốn đọc thứ tiếng gì**. Dashboard lấy ngôn ngữ từ URL, kiosk lấy từ NVS; một job chạy lúc hai
giờ sáng thì không có cả hai. Không có cột này thì hoặc mọi người nhận tiếng Việt, hoặc người
gửi phải đoán.

**Đăng nhập** — `User` thêm `employeeId` (tuỳ chọn, duy nhất). Tài khoản quản trị thuần vẫn để
trống ô ấy; tài khoản của người lao động trỏ về hồ sơ của họ. **Không gộp hai bảng**: một người
nghỉ việc thì hồ sơ phải ở lại vĩnh viễn cho bảng lương năm cũ, còn tài khoản thì phải tắt ngay.
Hai vòng đời khác nhau là hai bảng.

**Nghỉ phép** — `LeaveType`, `LeaveBalance`, `Request`, `ApprovalDelegation`. Nghỉ phép, tăng
ca, sửa công, công tác và làm từ xa dùng **chung một bảng `Request`**: chúng có cùng máy trạng
thái, cùng hộp chờ duyệt và cùng đường tới người duyệt, nên tách thành năm bảng là chép năm lần
cùng một logic. Xem §9.5.

**Lương** — `CompensationRecord`, `CompensationAllowance`, `PayrollPeriod`, `PayrollRun`,
`Payslip`, `PayslipLine`, `Dependent`, `RetroAdjustment`, `SalaryAdvance`, `BonusItem`.

Ba bảng trong số đó tồn tại vì một câu hỏi mà bảng khác không trả lời được:

| Bảng | Câu hỏi nó trả lời | Vì sao không gộp |
|---|---|---|
| `CompensationAllowance` | "quý này công ty trả bao nhiêu tiền ăn trưa" | một ô `allowances` tổng thì câu hỏi ấy phải mở từng bản ghi ra đọc |
| `RetroAdjustment` | "khoản này thuộc kỳ nào, trả ở kỳ nào" | kỳ đã chốt không được mở lại (§9.6), nên khoản tới muộn phải có chỗ đứng riêng |
| `SalaryAdvance` | "ai đang nợ tạm ứng, khấu trừ vào phiếu nào" | việc này vẫn xảy ra; không có bảng thì nó xảy ra trong tin nhắn |
| `BonusItem` | "khoản thưởng này thuộc lượt nào, của ai, bao nhiêu" | lượt thưởng cần đầu vào riêng; nhét vào `CompensationRecord` là biến một khoản một lần thành mức lương thường xuyên |

**Thông báo** — `Notification`, `NotificationPreference`, `PushSubscription`. Xem §9.21.4.

**Chính sách** — `PayrollPolicy`, `TaxBracket`. Xem §9.7. Mọi tỷ lệ lưu bằng **điểm cơ bản
kiểu nguyên** (`800` là 8%), không lưu số thực: một phép nhân dấu phẩy động trong bảng lương là
một đồng lệch mà không ai truy ra được nguồn.

**Ngày công** — `AttendanceDay`. Xem §9.8.

**Nhận việc và nghỉ việc** — `ChecklistTemplate`, `ChecklistTemplateItem`, `ChecklistRun`,
`ChecklistTask`. Xem §9.16 mục 10. Mẫu khai theo **chức danh và phòng ban**; lúc một người vào
hoặc ra thì **sinh ra một bản thể hiện** và từ đó hai bên không còn dính nhau nữa.

Tách mẫu khỏi bản thể hiện vì sửa mẫu **không được** đổi việc đã giao cho người đang làm dở.
Hạn khai bằng **số ngày lệch so với mốc** chứ không phải ngày tuyệt đối — mốc là ngày vào làm
hoặc ngày nghỉ, và số âm là hợp lệ: "thu lại thẻ ra vào" phải xong **trước** ngày cuối.

Người phụ trách giải ra lúc sinh: `MANAGER` thành cấp trên của chính người đó, `SELF` thành họ,
`HR` **để trống ô người** và chỉ giữ vai — một việc thuộc về một quầy chứ không thuộc về một
người là sự thật, và gán bừa cho một ai đó là làm hỏng sự thật ấy.

| Bảng | Câu hỏi nó trả lời | Vì sao không gộp |
|---|---|---|
| `ChecklistTemplate` | "người mới ở vị trí này cần làm những gì" | mẫu sống lâu hơn từng lượt và sửa được mà không đụng lượt đang chạy |
| `ChecklistTask` | "việc này của ai, hạn nào, xong chưa" | một ô JSON trong `Employee` thì không lọc được "ai đang trễ" |

**Tài sản** — `Asset`, `AssetTransfer`. Xem §9.16 mục 11. `Asset` giữ **hiện trạng** (mã, loại,
mô tả, số sê-ri, ai đang giữ); `AssetTransfer` giữ **lịch sử**, một dòng cho mỗi lần cấp và mỗi
lần thu, kèm người thao tác và tình trạng lúc giao nhận.

Hai bảng chứ không một, và ô `holderId` trên `Asset` **không phải là sự thật gốc** — nó là bản
tóm tắt của dòng chuyển giao mới nhất, giữ ở đó vì câu hỏi "ai đang cầm" được hỏi nhiều lần hơn
câu hỏi "từng qua tay ai". Sửa ô ấy mà không ghi dòng là làm mất lịch sử, nên mọi đường ghi đi
qua một phép duy nhất viết cả hai trong một giao dịch.

| Bảng | Câu hỏi nó trả lời | Vì sao không gộp |
|---|---|---|
| `Asset` | "cái máy mã TS0142 giờ ai cầm, còn dùng được không" | không có ô tóm tắt thì mỗi lần hỏi phải đọc hết lịch sử |
| `AssetTransfer` | "cái máy này từng qua tay ai, hỏng từ lần giao nào" | một ô `holder` bị ghi đè không trả lời được câu nào trong hai câu đó |

### 9.4 Vai trò và phạm vi nhìn thấy

`Role` hiện có `ADMIN`, `HR`, `VIEWER`. Bộ đó không tả nổi bài toán này, vì **quyền ở đây không
phải chỉ là "gọi được endpoint nào", mà là "thấy được dòng nào"**.

| Vai | Thấy | Sửa |
|---|---|---|
| `EMPLOYEE` | hồ sơ của **chính mình**, chấm công của mình, phép của mình, phiếu lương của mình | đơn nghỉ phép của mình, vài ô liên lạc |
| `MANAGER` | mọi thứ của `EMPLOYEE`, cộng **cây dưới quyền mình** | duyệt hoặc từ chối đơn của cấp dưới |
| `HR` | toàn bộ hồ sơ, chấm công, nghỉ phép | hồ sơ, hợp đồng, phép, phân ca |
| `PAYROLL` | như `HR`, cộng **lương và phiếu lương** | chạy kỳ lương, chốt kỳ |
| `ADMIN` | tất cả, cộng thiết bị và người dùng | tất cả |

**Tách `PAYROLL` khỏi `HR` là quyết định có chủ ý.** Người sửa hồ sơ và người chốt bảng lương
không nên là cùng một tài khoản: ai đổi được lương cơ bản rồi tự chạy kỳ lương thì không còn
ai đối chiếu. Tách ra là bước rẻ nhất để có được điều đó.

**Phạm vi dòng thi hành ở tầng service, không ở tầng controller.** Guard chỉ trả lời "vai này
được gọi đường này không"; câu hỏi "được thấy dòng nào" phải đi vào chính mệnh đề `where`. Đặt
nó ở controller là sớm muộn có một endpoint quên lọc và trả cả bảng lương công ty cho một người.
Nên mọi service của §9 nhận một **`Viewer`** (id người gọi, vai, id nhân viên, tập phòng ban
dưới quyền) và tự thu hẹp truy vấn.

Cây dưới quyền tính bằng **CTE đệ quy trên `managerId`**, có nhớ đệm, vì một trưởng bộ phận ở
công ty mười nghìn người có thể có vài nghìn cấp dưới và hỏi lại mỗi request là tự phạt.

### 9.5 Nghỉ phép

`LeaveType` khai từng loại: phép năm, nghỉ ốm, nghỉ không lương, nghỉ chế độ. Mỗi loại mang
**có trả lương hay không**, số ngày tích luỹ một năm, và trần chuyển sang năm sau.

`LeaveBalance` giữ **một dòng mỗi người mỗi loại mỗi năm**: số ngày được hưởng, đã dùng, chuyển
từ năm trước. Không tính lại từ đầu mỗi lần hỏi — một phép cộng trên cả lịch sử là thứ chậm dần
đều theo tuổi hệ thống.

`LeaveRequest` đi qua máy trạng thái `DRAFT → PENDING → APPROVED | REJECTED | CANCELLED`.

**Số dư trừ lúc duyệt, không trừ lúc gửi đơn.** Gửi đơn mà trừ ngay thì một đơn bị từ chối phải
hoàn lại, và mọi phép hoàn lại đều là chỗ để lệch. Nhưng **số dư phải được giữ chỗ** lúc gửi,
nếu không một người gửi ba đơn chồng nhau sẽ được duyệt cả ba. Nên `LeaveBalance` mang hai ô:
`taken` (đã duyệt) và `pending` (đang chờ), và phép kiểm là `entitled - taken - pending >= xin`.

**Đơn chồng ngày bị chặn ở tầng dữ liệu**, bằng ràng buộc loại trừ trên khoảng ngày, chứ không
chỉ kiểm trong code — hai request song song thì phép kiểm trong code cho qua cả hai.

Một ngày nghỉ đã duyệt **ghi vào `AttendanceDay`** của ngày đó với trạng thái tương ứng, nên
bảng công và bảng lương không phải hỏi hai nguồn rồi tự hoà giải.

### 9.6 Lương

**Lương là dữ liệu có thời hạn, không phải một ô để sửa đè.** `CompensationRecord` mang
`effectiveFrom` và không bao giờ bị sửa tại chỗ: tăng lương là **thêm một dòng**. Phiếu lương
tháng Ba phải tính bằng mức của tháng Ba kể cả khi tháng Tư đã tăng, và cách duy nhất giữ được
điều đó sau hai năm là không bao giờ đánh mất mức cũ.

Mỗi dòng giữ: lương cơ bản, **lương đóng bảo hiểm** (khác lương cơ bản ở rất nhiều nơi), phụ
cấp cố định, và lý do thay đổi.

**Kỳ lương và lượt chạy tách nhau.** `PayrollPeriod` là tháng lương, có trạng thái
`OPEN → LOCKED → PAID`. `PayrollRun` là **một lần tính**, và một kỳ có thể có nhiều lượt: chạy
nháp, xem, sửa, chạy lại. Chỉ khi kỳ `LOCKED` thì phiếu mới là bản chính thức.

**Chốt kỳ đóng băng đầu vào.** Sau khi `LOCKED`, một lượt chấm công gửi muộn hoặc một đơn nghỉ
duyệt muộn **không** đổi phiếu đã phát. Nó vào kỳ sau như một khoản truy lĩnh. Không có luật này
thì con số đã gửi cho nhân viên có thể tự đổi sau lưng họ.

`Payslip` giữ tổng; `PayslipLine` giữ từng khoản, mỗi khoản một dòng với mã, nhãn và số tiền,
phân loại thành khoản cộng và khoản trừ. **Không nhét vào một ô JSON**: câu hỏi "quý này trả
bao nhiêu tiền tăng ca toàn công ty" phải trả lời được bằng một phép gộp SQL.

Tiền lưu bằng **số nguyên đơn vị đồng**, không dùng dấu phẩy động. `Decimal` của Postgres cho
cột tổng.

### 9.7 Thuế và bảo hiểm là dữ liệu, không phải hằng số trong code

Đây là chỗ §4.9 áp dụng mạnh nhất, vì các con số này **đổi theo nghị quyết**, không theo ý
người viết code. Mức giảm trừ gia cảnh vừa tăng 40% từ 01/01/2026 theo Nghị quyết
110/2025/UBTVQH15 — **15.500.000 đ/tháng** cho bản thân và **6.200.000 đ** mỗi người phụ thuộc,
thay cho 11 triệu và 4,4 triệu. Một hệ gõ 11.000.000 vào một hàm sẽ trả sai lương cho cả công
ty vào đúng kỳ đầu năm, và không ai biết cho tới khi có người khiếu nại.

Nên hai bảng, cả hai có `effectiveFrom`:

- `PayrollPolicy` — giảm trừ bản thân, giảm trừ người phụ thuộc, tỷ lệ BHXH **8%**, BHYT
  **1,5%**, BHTN **1%** phía người lao động, tỷ lệ phía công ty, **trần đóng bằng 20 lần mức
  tham chiếu**, ngày công chuẩn mỗi tháng, hệ số tăng ca, và **ngưỡng ngày không lương miễn
  đóng**.
- `TaxBracket` — biểu thuế luỹ tiến từng phần, mỗi bậc một dòng.

**Số 2026, tra ngày 20/09/2026, kèm nguồn.** Đây là bảng phải đối chiếu lại mỗi khi có nghị
quyết mới; đừng tin trí nhớ của ai, kể cả của người viết chỗ này.

| Đại lượng | Giá trị | Văn bản |
|---|---|---|
| Giảm trừ bản thân | **15.500.000 đ/tháng** từ 01/01/2026 | Nghị quyết 110/2025/UBTVQH15 |
| Giảm trừ người phụ thuộc | **6.200.000 đ/tháng** | như trên |
| Biểu thuế | **5 bậc: 5% · 10% · 20% · 30% · 35%** tại các mốc 10 / 30 / 60 / 100 triệu | Luật Thuế TNCN 2025, áp dụng cho kỳ tính thuế từ 01/01/2026 |
| Người lao động đóng | BHXH **8%**, BHYT **1,5%**, BHTN **1%** | Luật BHXH 2024 |
| Công ty đóng | BHXH **17,5%** (14 hưu trí + 3 ốm đau thai sản + 0,5 tai nạn lao động), BHYT **3%**, BHTN **1%** | như trên |
| Mức tham chiếu | **2.340.000 đ** đến 30/06/2026, **2.530.000 đ** từ 01/07/2026 | Nghị định 73/2024/NĐ-CP và bản thay thế |
| Trần đóng BHXH/BHYT | 20 × mức tham chiếu: **46,8 tr** rồi **50,6 tr** | như trên |
| Lương tối thiểu vùng I | **5.310.000 đ** từ 01/01/2026 | Nghị định 293/2025/NĐ-CP |

**Mức tham chiếu đổi giữa năm, và đó là bài kiểm cho chính thiết kế này.** Một hệ gõ 2.340.000
vào hằng số sẽ trả sai bảo hiểm cho nửa sau của năm. Ở đây nó là **hai dòng `PayrollPolicy`**,
một hiệu lực 01/01 và một hiệu lực 01/07, và phép tính hỏi chính sách tại **ngày cuối kỳ** —
nên kỳ tháng Sáu tự lấy trần 46,8 triệu còn kỳ tháng Bảy tự lấy 50,6 triệu, không ai phải nhớ.

**Cách kiểm một biểu thuế mà không cần tin ai.** Cơ quan thuế công bố kèm **công thức rút gọn**
cho từng bậc — bậc 5 là `35% × TNTT − 14,5 triệu`. Hai phép kiểm độc lập rơi ra từ đó, và bộ
test dùng cả hai:

1. **Liên tục tại mọi ranh giới**: giá trị bậc dưới tại mốc phải bằng giá trị bậc trên tại
   chính mốc đó. Sai một thuế suất là gãy ngay, ví dụ `10%×30 − 0,5 = 20%×30 − 3,5 = 2,5tr`.
2. **Khớp với công thức rút gọn** ở vài điểm bất kỳ. Phép cộng từng lát của hàm luỹ tiến và
   phép trừ một lần của công thức rút gọn là hai đường tính khác nhau cho cùng một con số.

**Tháng không đi làm thì không đóng bảo hiểm, và đó là một cột chứ không phải một số trong
hàm.** Luật BHXH miễn đóng cho tháng người lao động **không làm việc và không hưởng lương từ
14 ngày làm việc trở lên**. Bỏ quy tắc này thì phiếu lương của người nghỉ không lương cả tháng
ra **thực nhận âm**: thu nhập bằng 0 mà vẫn trừ 10,5% của lương đóng bảo hiểm. Con số 14 nằm ở
`PayrollPolicy.noContributionUnpaidDays` vì nó do luật đặt, và ngày luật đổi thì thêm một dòng
chính sách là xong.

Phép tính lương **luôn hỏi chính sách có hiệu lực tại ngày cuối kỳ**, không hỏi "chính sách hiện
tại". Tính lại một kỳ cũ vì thế ra đúng con số cũ.

### 9.8 Từ lượt chấm công thành ngày công

`AttendanceRecord` là sự kiện thô: người này quẹt mặt lúc này ở máy này. Bảng lương cần thứ
khác hẳn: **ngày này người này làm bao nhiêu phút, muộn bao nhiêu, tăng ca bao nhiêu**.

`AttendanceDay` giữ đúng thứ ấy, một dòng mỗi người mỗi ngày: giờ vào đầu, giờ ra cuối, phút
làm việc, phút muộn, phút về sớm, phút tăng ca, trạng thái (`WORKED`, `LEAVE`, `HOLIDAY`,
`ABSENT`, `WEEKEND`), và ca áp dụng.

**Một bảng, hai việc, và đó là lý do nó đáng có.** Nó vừa là đầu vào của bảng lương, vừa là thứ
chữa chỗ gãy ở §9.2: báo cáo đọc **ba mươi nghìn dòng một ngày** thay vì một triệu tám trăm
nghìn lượt quẹt.

Dựng bằng một job chạy đêm cho ngày hôm trước, cộng một lượt dựng lại theo yêu cầu khi có sửa
chữa thủ công. **Ngày hôm nay không nằm trong bảng** — nó tính trực tiếp từ lượt quẹt, vì hôm
nay còn đang diễn ra và một dòng tổng kết giữa chừng là một dòng sai.

Sửa tay được, nhưng **phải để lại vết**: `AttendanceDay` mang `adjustedBy` và `adjustReason`.
Một bảng công mà HR sửa được không dấu vết thì không dùng để trả lương được.

### 9.9 Truy vấn khi số nhân viên lên hàng chục nghìn

Sáu luật, mỗi luật chữa một chỗ gãy cụ thể.

**1. Không bao giờ gom ở Node.** Mọi con số tổng hợp đi bằng `groupBy` hoặc SQL gộp. Luật này
tồn tại vì §9.2 cho thấy chính hệ này đã vi phạm nó, và cái giá đo được ngày 20/09 trên
**5.002 nhân viên với 300.001 lượt quẹt một tháng**: gom ở Node mất **3.245 ms** và kéo heap từ
15 lên **586 MB**; gộp ở Postgres mất **82 ms** và heap nhích 3 MB. Nhanh hơn **40 lần**, và
chỗ khác biệt thật không phải tốc độ mà là bộ nhớ — nhân tuyến tính lên 30.000 nhân viên thì
cách cũ cần ~3,5 GB heap cho một báo cáo, tức là chết chứ không phải chậm.

**2. `AttendanceRecord` chia mảnh theo tháng.** Phân mảnh dải trên `ts`, một mảnh một tháng.
Truy vấn một tháng chỉ chạm một mảnh, và dọn dữ liệu quá hạn là `DROP` một mảnh chứ không phải
`DELETE` vài triệu dòng. Chỉ làm khi bảng thật sự lớn — phân mảnh sớm là tự thêm việc vận hành
mà chưa được gì.

**3. Danh sách dài đi bằng con trỏ, không bằng `OFFSET`.** `OFFSET 50000` bắt Postgres đếm qua
50 nghìn dòng rồi vứt đi, và cái giá đi thẳng theo độ sâu — đo trên **300.001 lượt quẹt**: trang
đầu **3,0 ms**, `OFFSET 49950` **18,8 ms**, `OFFSET 249950` **118,1 ms**.

Nhưng tiền không phải lý do chính. `OFFSET` **trả sai** khi có người ghi vào giữa hai trang: một
lượt quẹt mới rơi lên đầu danh sách thì mọi thứ dịch xuống một ô, và trang sau lặp lại đúng một
dòng trang trước đã hiện. Đo thật: chèn một lượt quẹt giữa trang 1 và trang 2 thì `OFFSET` lặp
**1 dòng**, con trỏ lặp **0**. Một bảng chấm công của công ty đang chạy thì **luôn** có người ghi
vào giữa hai trang — đó là điều kiện bình thường, không phải ngoại lệ.

Khoá con trỏ phải là **một cặp có thứ tự toàn phần**: `(ts, id)` cho lượt quẹt, `(code, id)` cho
nhân viên. Thiếu vế `id` thì hàng nghìn dòng cùng `ts` không có thứ tự xác định nào giữa chúng,
và mỗi lượt chạy có quyền xếp khác đi. Con trỏ là **chuỗi mờ** phía client: nó mã hoá cặp khoá
ấy, để không ai dựng con trỏ bằng tay rồi phụ thuộc vào hình dạng bên trong.

`OFFSET` không bị bỏ hẳn — phân trang nông vẫn rẻ và giao diện số trang cần nó — nhưng bị **chặn
trần** ở `MAX_OFFSET`. Quá trần thì từ chối kèm mã, và câu trả lời là dùng con trỏ. Một giới hạn
từ chối thẳng tốt hơn một truy vấn chậm dần mà không ai thấy nó chậm từ lúc nào.

**Hai cái bẫy khiến con trỏ chỉ trông giống con trỏ.** Thứ nhất, chỉ mục phải phủ **đúng cặp
khoá**: với chỉ mục chỉ trên `ts`, câu lệnh con trỏ vẫn quét ngược từ đầu rồi *lọc bỏ* — đo ở độ
sâu 50.000 thì `Rows Removed by Filter: 50001`, tức vẫn tuyến tính theo độ sâu, chỉ là mặc áo
con trỏ. Thứ hai, **phép so sánh phải thành chặn chỉ mục chứ không thành bộ lọc**: dạng
`(ts, id) < (x, y)` thì Postgres cho `Index Cond` (0,49 ms), còn dạng `ts < x OR (ts = x AND
id < y)` — thứ duy nhất ORM phát ra được — thì cho `Filter` (14,98 ms). Cách giữ cả hai: thêm
một vế `ts <= x` **trông thừa** bên cạnh, vì đó là vế duy nhất thành `Index Cond`; khi ấy phần
bị lọc chỉ còn bằng **số dòng trùng `ts`**, không còn theo độ sâu (0,99 ms). Vế thừa ấy không
được phép bị ai dọn đi vì tưởng nó lặp lại điều kiện phía sau.

Đo sau khi làm, 300.001 lượt quẹt, trang 50 dòng: con trỏ **2,23 → 2,19 → 1,47 → 1,36 ms** ở
trang 1, 100, 500, 1.000; `OFFSET` **1,08 → 2,24 → 4,98 → 7,26 ms**. Con trỏ đắt hơn ở trang
đầu và phẳng từ đó trở đi — đúng thứ cần: trang thứ 1.000 rẻ ngang trang đầu.

**4. Tìm tên có dấu đi bằng chỉ mục ba chữ.** `ILIKE '%nguyen%'` không dùng được chỉ mục B-tree.
Cần `pg_trgm` với chỉ mục GIN trên tên và mã.

**5. Việc sống lâu hơn một request thì vào hàng đợi.** Chạy lương cho ba mươi nghìn người không
phải là một lượt HTTP. `PayrollRun` chia lô theo phòng ban, mỗi lô một job BullMQ, có `attempts`
và `backoff`, và **idempotent theo `(runId, employeeId)`** để giao hai lần không đẻ hai phiếu.

**6. Đếm chính xác chỉ khi cần chính xác.** `COUNT(*)` trên bảng vài triệu dòng là quét toàn
bảng. Phân trang hiển thị "hơn 10.000" thay vì con số đúng khi vượt ngưỡng.

Chỉ mục đi kèm: `Employee(departmentId, active)`, `Employee(managerId)`,
`AttendanceDay(employeeId, date)`, `AttendanceDay(date)`, `LeaveRequest(employeeId, state)`,
`LeaveRequest(state, from)`, `Payslip(runId)`, `Payslip(employeeId, periodId)`.

### 9.10 Cổng nhân viên và cổng quản lý

**Một ứng dụng, ba khuôn mặt, không phải ba ứng dụng.** Cùng một bản Next.js, và trang chủ đổi
theo vai. Dựng riêng một cổng nhân viên nghĩa là nuôi hai bản đăng nhập, hai bộ gọi API và hai
chỗ để quên vá.

| Vai | Trang chủ mở ra cái gì |
|---|---|
| `EMPLOYEE` | chấm công tháng này của mình, số phép còn lại, phiếu lương gần nhất, nút xin nghỉ |
| `MANAGER` | **hộp chờ duyệt**, ai vắng hôm nay, lịch nghỉ của nhóm |
| `HR` / `PAYROLL` | nhân sự biến động, chấm công bất thường, tình trạng kỳ lương |
| `ADMIN` | như trên, cộng sức khoẻ thiết bị |

**Hộp chờ duyệt là màn hình quan trọng nhất của `MANAGER`.** Nó phải trả lời một câu trong hai
giây: *còn gì đang đợi tôi*. Không phải một bảng để lọc, mà một danh sách việc, mỗi dòng có đủ
ngữ cảnh để quyết ngay tại chỗ — ai, loại phép gì, mấy ngày, còn bao nhiêu dư, ai khác trong
nhóm cũng nghỉ hôm đó.

### 9.11 Phiếu lương gửi đi bằng đường nào

**Mặc định gửi thông báo kèm đường dẫn, không đính kèm phiếu.** Một phiếu lương PDF trong hộp
thư là một phiếu lương nằm trong bản sao lưu của nhà cung cấp mail, trong máy chủ trung chuyển,
và trong mọi lần chuyển tiếp nhầm. Đường dẫn vào cổng nhân viên thì đòi đăng nhập và để lại
nhật ký ai đã xem.

Vẫn có đường đính kèm cho nơi bắt buộc phải làm vậy, nhưng nó là **một lựa chọn phải bật**, và
khi bật thì PDF đặt mật khẩu. Không đặt nó làm mặc định.

Gửi đi qua hàng đợi riêng `payroll`, một job một người, **idempotent theo `payslipId`** —
hàng đợi giao ít nhất một lần, và không ai muốn nhận phiếu lương hai lần. Tính idempotent nằm
ở **cột `sentAt` của `Payslip`**, không nằm ở bộ nhớ của worker: worker khởi động lại thì bộ
nhớ mất, còn cột thì không.

Tách khỏi `notify` vì hai việc có hậu quả khác nhau khi hỏng: một webhook thiết bị gửi trượt
là mất một dòng cảnh báo, một phiếu lương gửi trượt là một người không biết tháng này mình
được trả bao nhiêu. Chúng đáng có số lần thử lại và hàng chờ riêng.

**Thư gửi theo `Employee.locale`, và nội dung thư nằm ở đúng một chỗ.** Thư là bề mặt thứ tư
có chữ cho người đọc, ngoài ba bề mặt ở CLAUDE.md §3.1; nó không đi qua catalogue của kiosk hay
của dashboard, vì cả hai đều ở phía client còn thư thì sinh ở server. Nên nó có bảng chữ riêng
trong khối backend, hai ngôn ngữ, và **mặc định tiếng Việt** đúng như luật 4.

| Biến môi trường | Dùng làm gì | Thiếu thì sao |
|---|---|---|
| `MAIL_HOST`, `MAIL_PORT` | máy chủ SMTP | không gửi, chỉ ghi log và bỏ qua |
| `MAIL_USER`, `MAIL_PASSWORD` | đăng nhập SMTP | gửi không xác thực |
| `MAIL_FROM` | địa chỉ người gửi | dùng `MAIL_USER` |
| `APP_PUBLIC_URL` | gốc của đường dẫn trong thư | không sinh được link, coi như thiếu cấu hình |

**Đính kèm PDF chưa dựng.** §9.11 cho phép nó như một lựa chọn phải bật kèm mật khẩu; chừng nào
đường sinh PDF và đặt mật khẩu chưa có thì lựa chọn ấy **không tồn tại trong API**, chứ không
phải có mà không làm gì.

### 9.12 Giao diện: nhịp của một hệ quản trị nhân sự

Đây là phần mềm người ta mở tám tiếng một ngày, không phải trang giới thiệu. Nên nhịp của nó là
**dày mà đọc được**, không phải thoáng mà rỗng.

**Bốn luật hình thức**

1. **Dẫn bằng việc, không dẫn bằng số.** Trang chủ của người duyệt mở ra danh sách việc đang
   đợi, không mở ra bốn thẻ số liệu to. Thẻ số liệu to chỉ đúng khi con số ấy là thứ người ta
   vào để xem, và với HR thì hiếm khi vậy.
2. **Trạng thái mang hình dạng, không chỉ mang màu.** Đang chờ, đã duyệt, từ chối, quá hạn —
   mỗi thứ một viên nhãn có chữ. Màu là lớp thứ hai, vì một phần trăm nam giới không phân biệt
   được đỏ với lục.
3. **Bảng là công cụ, không phải bản in.** Cột số căn phải và dùng chữ số đều bề ngang; hàng
   giữ nguyên chiều cao; cột quan trọng đứng yên khi cuộn ngang.
4. **Tiền và giờ không bao giờ hiện trần.** Một con số lương luôn đi kèm đơn vị và kỳ; một con
   số giờ luôn nói rõ là giờ làm hay giờ tăng ca.

**Bảng màu** giữ nguyên bộ đã có ở `globals.css` và thêm đúng những gì trạng thái đòi. Vai trò
của màu nhấn không đổi: nó dành cho hành động chính, không rải khắp nơi.

**Màn hình tối thiểu để chạy được**: danh bạ nhân viên, hồ sơ một người, cây tổ chức, đơn nghỉ
phép, hộp chờ duyệt, bảng công tháng, phiếu lương của tôi, chạy kỳ lương, cấu hình chính sách.
Chín màn ấy là ranh giới giữa "chạy được" và "trình diễn được".

### 9.13 Bản đồ phân hệ đầy đủ

Mười sáu phân hệ. Cột *giai đoạn* không phải để hoãn việc — nó nói **cái gì chặn cái gì**: một
phân hệ chỉ vào được giai đoạn sau khi thứ nó đứng trên đã có thật.

| # | Phân hệ | Giữ gì | GĐ |
|---|---|---|---|
| 1 | **Hồ sơ và tổ chức** | nhân viên, phòng ban (cây), chức danh, hợp đồng, người phụ thuộc | 1 |
| 2 | **Quyền và phạm vi** | vai, phạm vi dòng, nhật ký thay đổi | 1 |
| 3 | **Chấm công** | lượt quẹt, ngày công, ca, ngày lễ, sửa tay có vết | 1 |
| 4 | **Nghỉ phép** | loại phép, số dư, đơn, luồng duyệt | 1 |
| 5 | **Lương** | mức lương theo thời hạn, kỳ, lượt chạy, phiếu, dòng phiếu | 2 |
| 6 | **Chính sách pháp lý** | giảm trừ, tỷ lệ bảo hiểm, biểu thuế — đều có ngày hiệu lực | 2 |
| 7 | **Cổng nhân viên** | hồ sơ của tôi, công của tôi, phép của tôi, phiếu lương của tôi | 2 |
| 8 | **Cổng quản lý** | hộp chờ duyệt, nhóm của tôi, lịch nghỉ nhóm | 2 |
| 9 | **Tài liệu và chính sách nội bộ** | văn bản có phiên bản, xác nhận đã đọc | 3 |
| 10 | **Onboarding / offboarding** | danh sách việc theo mẫu, bàn giao, thu hồi quyền | 3 |
| 11 | **Tài sản cấp phát** | máy móc, thẻ, đồng phục — cấp, thu, mất | 3 |
| 12 | **Đánh giá và mục tiêu** | chu kỳ đánh giá, mục tiêu OKR/KPI, phản hồi | 3 |
| 13 | **Đào tạo** | khoá, ghi danh, kết quả, chứng chỉ có hạn | 4 |
| 14 | **Tuyển dụng** | tin tuyển, ứng viên, vòng phỏng vấn, thư mời | 4 |
| 15 | **Khảo sát và ghi nhận** | khảo sát nhanh, ghi nhận đóng góp, thông báo nội bộ | 4 |
| 16 | **Phân tích nhân sự** | biến động, nghỉ việc, chi phí lương, chuyên cần | 4 |

**Giai đoạn 1 là thứ không có thì không có gì khác chạy được.** Không có cây tổ chức thì không
có người duyệt; không có ngày công thì không có lương. Giai đoạn 2 biến nó thành thứ nhân viên
mở ra hằng ngày. Giai đoạn 3 và 4 là bề rộng.

**Một luật chung cho cả mười sáu**: phân hệ nào cũng gắn vào `employeeId` và **không phân hệ
nào sở hữu bản sao hồ sơ nhân viên**. Chép tên và phòng ban sang bảng tuyển dụng hay bảng đánh
giá là tạo ra hai sự thật, và cái sai sẽ luôn là cái không ai nhớ tới (cùng nguyên tắc §4.9).

### 9.14 Vòng đời nhân viên là xương sống nối các phân hệ

Các phân hệ không đứng cạnh nhau, chúng nối vào một trục:

```
ứng viên ──► nhận việc ──► đang làm ──────────────► nghỉ việc
   │            │             │                        │
 tuyển       onboarding    chấm công                offboarding
 dụng        tài sản       nghỉ phép                thu hồi quyền
 (14)        tài liệu      lương                    thu tài sản
             (10, 11, 9)   đánh giá, đào tạo        lương chốt cuối
                           (3,4,5,12,13)            (10, 11, 5)
```

**Chuyển trạng thái là sự kiện, không phải một ô để sửa.** Nhận việc sinh hợp đồng, sinh số dư
phép theo tỷ lệ còn lại của năm, sinh danh sách việc onboarding, và mở tài khoản. Nghỉ việc
khoá tài khoản **ngay**, nhưng giữ hồ sơ vĩnh viễn, chạy lương chốt cuối, và mở danh sách thu
hồi. Viết mỗi việc ấy thành một chỗ bấm riêng là bảo đảm có ngày ai đó quên một bước.

**Một người nghỉ việc không bao giờ bị xoá.** Bảng lương năm ngoái phải tra ra được họ. Cờ
`active` tắt, tài khoản khoá, dữ liệu sinh trắc **xoá** (§7.5 — mẫu khuôn mặt là thứ duy nhất
bị xoá thật), hồ sơ ở lại.

### 9.15 Kiến trúc thông tin: ba loại màn hình, không phải một danh sách dài

Phần mềm HR chết vì thanh bên hai mươi mục ngang hàng nhau. Chữa bằng cách phân loại **theo
việc người ta đang làm**, không theo tên phân hệ:

| Loại | Trả lời câu hỏi | Ví dụ |
|---|---|---|
| **Việc** | *tôi phải làm gì bây giờ* | hộp chờ duyệt, danh sách onboarding, kỳ lương đang mở |
| **Tra cứu** | *tình hình thế nào* | danh bạ, bảng công, lịch nghỉ, cây tổ chức |
| **Cấu hình** | *hệ thống chạy theo luật nào* | loại phép, ca, chính sách thuế, mẫu onboarding |
| **Báo cáo** | *xu hướng ra sao* | biến động nhân sự, chi phí lương, chuyên cần |

**Bốn loại này ở bốn nơi khác nhau trên màn hình.** Việc nằm ở trang chủ và mang số đếm trên
thanh bên. Tra cứu nằm ở thanh bên chính. Cấu hình nằm sau một mục *Thiết lập* riêng, vì người
ta mở nó vài lần một quý. Báo cáo nằm riêng vì nó là chỗ người ta ngồi lâu.

**Thanh bên chia nhóm và gập được, có số đếm.** Số đếm trên *Chờ duyệt* là thứ cho phép một
trưởng phòng biết có việc mà **không phải mở trang** — và nó là lý do người ta quay lại mỗi
ngày. Không có nó thì mọi thứ đều phải nhớ.

```
Tôi            ▸ Trang của tôi · Công của tôi · Phép của tôi · Phiếu lương
Chờ duyệt (3)  ▸ Nghỉ phép (2) · Tăng ca (1)
Nhân sự        ▸ Danh bạ · Cây tổ chức · Hợp đồng · Onboarding
Thời gian      ▸ Bảng công · Ca làm · Nghỉ phép · Ngày lễ
Lương          ▸ Kỳ lương · Phiếu lương · Bảng lương ngân hàng
Thiết bị       ▸ Kiosk · Bản phát hành
Báo cáo        ▸ Chuyên cần · Biến động · Chi phí lương
Thiết lập      ▸ Chính sách · Loại phép · Vai trò · Tài liệu
```

**Nhóm nào rỗng với vai của người đang xem thì không hiện.** Một nhân viên thường thấy đúng hai
nhóm đầu. Làm mờ đi thay vì ẩn là cố ý khoe những gì họ không được đụng.

**Mỗi phân hệ có đúng một màn hình "về một người".** Hồ sơ nhân viên là trang có tab: thông tin,
hợp đồng, chấm công, nghỉ phép, lương, tài sản, đào tạo. Không rải mỗi thứ một trang rồi bắt HR
tìm lại người đó bảy lần.

### 9.16 Các phân hệ mở rộng: quyết định đáng ghi trước

Không mô tả lại từng tính năng — chỉ ghi chỗ dễ làm sai.

**Tài liệu và chính sách (9).** Văn bản có **phiên bản**, và xác nhận đã đọc gắn vào **đúng
phiên bản** người ta đã đọc. Gắn vào tên tài liệu là mất khả năng chứng minh ai đã đọc bản nào
— thứ duy nhất có giá trị khi có tranh chấp.

**Onboarding / offboarding (10).** Mẫu danh sách việc theo chức danh và phòng ban, sinh ra bản
thể hiện có người phụ trách và hạn. **Offboarding chạy ngược lại và phải chặn được**: chưa thu
tài sản, chưa bàn giao thì kỳ lương cuối không chốt được.

**Tài sản (11).** Mỗi lần cấp và thu là một **bản ghi chuyển giao**, không phải sửa ô `holder`.
Câu hỏi "cái máy này từng qua tay ai" chỉ trả lời được nếu lịch sử là dòng chứ không phải ô.

**Đánh giá và mục tiêu (12).** Chu kỳ đánh giá **đóng băng** bảng lương và chức danh tại thời
điểm chốt, vì một bản đánh giá đọc lại sau hai năm phải nói đúng bối cảnh lúc đó.

**Đào tạo (13).** Chứng chỉ có **hạn**, và hạn phải sinh ra nhắc nhở. Một chứng chỉ an toàn lao
động hết hạn mà không ai biết là rủi ro pháp lý, không phải thiếu sót dữ liệu.

**Tuyển dụng (14).** Ứng viên **không phải** nhân viên và không nằm chung bảng. Chuyển thành
nhân viên là một phép chuyển có chủ đích, sinh `Employee` mới và để lại liên kết ngược.

**Khảo sát (15).** Khảo sát ẩn danh phải **thật sự** ẩn danh: lưu câu trả lời tách khỏi người
trả lời, và không lưu thứ gì đủ để ghép lại. Nửa vời ở đây tệ hơn không làm, vì nó hứa một điều
không giữ được.

**Phân tích (16).** Mọi con số đọc từ bảng tổng hợp đã dựng sẵn, không đọc từ bảng giao dịch.
Đây là §9.9 luật 1 nói lại ở tầng báo cáo.

### 9.17 Mười hai việc người lao động thật sự cần

Danh sách này không suy từ bảng tính năng của phần mềm khác. Nó là những câu người ta hỏi HR
qua tin nhắn, và mỗi câu chưa có chỗ trả lời là một lần HR phải trả lời tay.

**1. Giải trình công.** Máy hỏng, quên quẹt, đứng sai góc, đi công tác — ngày đó thành vắng mặt
và **trừ vào lương**. Đây là thiếu sót nặng nhất của một hệ chấm công không có cổng: người bị
trừ không có đường tự sửa. Cần đơn giải trình có ảnh hoặc lý do, gửi tới cấp trên, duyệt xong
thì ghi vào `AttendanceDay` **kèm dấu là đã sửa** (§9.8) — không bao giờ ghi đè con số máy đo.

**2. Đăng ký tăng ca trước, không xin sau.** Luật lao động đòi tăng ca có sự đồng ý; thực tế
phần mềm đòi nó có **duyệt trước**, nếu không thì mọi phút ở lại muộn đều thành tăng ca và bảng
lương mất kiểm soát. Nên phút ngoài ca chỉ thành tiền khi khớp một đăng ký đã duyệt.

**Khớp thế nào, nói rõ bằng một công thức.** Mỗi ngày trả **`min(phút máy đo, phút được duyệt
cho ngày đó)`**, và một đăng ký trải nhiều ngày thì số phút của nó **chia đều cho số ngày nó
phủ**. Hai vế của phép `min` chặn hai chiều lạm dụng khác nhau: không ai được trả nhiều hơn số
đã duyệt, và cũng không ai được trả cho giờ mình không thật sự ở lại. Ngày không có đăng ký nào
phủ thì **tăng ca bằng không**, dù máy có đo được bao nhiêu.

Chia đều là một lựa chọn, không phải sự thật — người ta có thể ở lại bốn tiếng hôm thứ Hai và
không tiếng nào hôm thứ Ba. Nhưng cách còn lại là bắt người duyệt nhập số phút cho từng ngày,
và một biểu mẫu như vậy thì không ai điền. Ai cần chính xác theo ngày thì gửi mỗi ngày một
đăng ký, và công thức trên tự ra đúng.

**3. Công tác và làm từ xa.** Cùng lý do với mục 1, nhưng đăng ký **trước** chứ không giải trình
sau. Ngày đã đăng ký thì kiosk không thấy mặt cũng không tính vắng.

**4. Phiếu lương phải tự giải thích được.** Câu hỏi thật không phải "tháng này bao nhiêu" mà
*"sao tháng này ít hơn tháng trước"*. Nên phiếu lương hiện **chênh lệch so với kỳ trước theo
từng khoản**, và khoản nào đổi thì nói vì sao: nghỉ không lương ba ngày, thêm một người phụ
thuộc, chạm trần bảo hiểm. Không có phần này thì mỗi kỳ lương là một đợt tin nhắn cho HR.

**5. Giấy xác nhận công tác và xác nhận thu nhập.** Vay ngân hàng, làm visa, đăng ký học. Tự
xin trong cổng, HR duyệt, hệ sinh văn bản có số hiệu và lưu lại đã cấp cho ai.

**6. Đổi thông tin cá nhân phải qua duyệt — nhất là số tài khoản.** Cho sửa thẳng số tài khoản
là mở đúng cánh cửa mà kẻ chiếm tài khoản cần. Đổi tài khoản ngân hàng là **đơn có duyệt**, có
thông báo về email cũ, và không có hiệu lực với kỳ lương đang chạy.

**7. Một chỗ xem mọi đơn của tôi.** Nghỉ phép, tăng ca, giải trình, đổi thông tin — cùng một
danh sách, cùng một cách hiện trạng thái. Rải mỗi loại một trang là bắt người ta nhớ mình đã
gửi cái gì ở đâu.

**8. Lịch ca của tôi, xem trước được.** Người làm ca cần biết tháng sau mình vào ca nào để sắp
xếp việc nhà. Ca phân xong mà chỉ HR thấy thì phân ca vô dụng.

**9. Số dư phép **tại một ngày**, không phải hôm nay.** Câu hỏi luôn là "nếu tôi nghỉ tuần sau
thì còn mấy ngày", nên ô số dư phải tính theo ngày người ta chọn, kể cả đơn đang chờ.

**10. Quyết toán thuế cuối năm.** Bản kê thu nhập cả năm và thuế đã nộp, cộng đường đăng ký
người phụ thuộc. Cả hai đều đang là việc HR làm tay cho từng người.

**11. Khiếu nại phiếu lương thành hồ sơ, không thành tin nhắn.** Có kênh chính thức, có hạn trả
lời, có kết quả lưu lại. Một tranh chấp lương giải quyết qua tin nhắn là một tranh chấp không
chứng minh được về sau.

**12. Biết đơn của mình đang ở đâu.** Thông báo khi đơn được duyệt, bị từ chối, hay **nằm quá
lâu không ai động tới** — cái thứ ba là cái người ta bức xúc nhất và phần mềm hay quên nhất.

### 9.18 Mười hai việc HR thật sự cần

**1. Hợp đồng sắp hết hạn.** Bỏ lỡ hạn tái ký thì hợp đồng xác định thời hạn **tự thành không
xác định thời hạn** theo luật — một hậu quả pháp lý vĩnh viễn sinh ra từ một ô lịch không ai
nhìn. Cần nhắc theo mốc 30 / 15 / 7 ngày, và danh sách phải mở được từ trang chủ.

**2. Thử việc sắp kết thúc.** Cùng loại rủi ro: hết thử việc mà không quyết là mặc nhiên nhận
chính thức.

**3. Bảng ngoại lệ của hôm nay.** Không phải "ai đi làm" — mà **ai lệch**: chưa quẹt, quẹt muộn,
quẹt một lần rồi biến mất, nghỉ không đơn. Danh sách ngắn mà hành động được, mở mỗi sáng.

**4. Danh sách kiểm trước khi chốt lương.** Trước khi `LOCKED` (§9.6), hệ phải tự liệt kê cái
gì còn treo: đơn nghỉ chưa duyệt, giải trình chưa xử, ngày công thiếu, người chưa có mức lương
hiệu lực. **Chốt kỳ khi còn mục treo phải cần xác nhận có ghi tên người xác nhận.**

**5. Nhập hàng loạt từ Excel.** Ba mươi nghìn người không gõ tay được, và dữ liệu đầu vào luôn
bẩn. Nên nhập theo hai nhịp: **chạy thử ra báo cáo lỗi từng dòng**, rồi mới nhập thật. Nhập
thẳng rồi sửa sau là cách chắc chắn nhất để có dữ liệu rác vĩnh viễn.

**6. Điều chỉnh lương hàng loạt.** Tăng lương cả công ty hay cả một phòng là việc một lần một
năm nhưng bắt buộc. Sinh ra **một loạt dòng `CompensationRecord` mới cùng ngày hiệu lực**
(§9.6), xem trước được trước khi ghi.

**7. Tái cơ cấu tổ chức.** Chuyển cả một phòng sang cấp trên khác, gộp hai phòng, đổi người quản
lý hàng loạt. Phải xem trước ai bị ảnh hưởng, vì đổi `managerId` là đổi luôn ai duyệt đơn của
họ và ai nhìn thấy dữ liệu của họ (§9.4).

**8. Lương chốt cuối khi nghỉ việc.** Trợ cấp thôi việc, phép năm chưa dùng quy ra tiền, thu hồi
tạm ứng, đối trừ tài sản chưa trả. Đây là phép tính khác hẳn lương tháng và làm tay thì sai.

**9. Thưởng chạy tách khỏi lương tháng.** Thưởng tết, thưởng hiệu quả. Là **lượt chạy riêng trên
cùng kỳ**, vì thuế của khoản thưởng tính cùng kỳ chi trả nhưng nguồn và người duyệt thì khác.

**Thuế của lượt thưởng là phần thuế tăng thêm, không phải thuế tính lại từ đầu.** Thuế TNCN luỹ
tiến trên **tổng thu nhập của kỳ**, nên một phiếu thưởng tính thuế độc lập sẽ rơi vào bậc thấp
và thu thiếu; còn tính lại cả kỳ rồi phát phiếu thứ hai thì trả lương hai lần. Công thức đúng
là hiệu:

```
thuế thưởng = thuế(thu nhập tính thuế kỳ + thưởng) − thuế(thu nhập tính thuế kỳ)
```

Nên lượt thưởng **bắt buộc chạy sau lượt lương tháng của cùng kỳ** và đọc phiếu thường của người
đó làm nền. Không có phiếu nền thì từ chối, chứ không lặng lẽ coi nền bằng không.

**Thưởng không vào nền đóng bảo hiểm.** Nền đóng là mức lương theo hợp đồng cộng phụ cấp có
tính chất lương, và một khoản thưởng một lần không phải thứ đó — nên phiếu thưởng không có dòng
bảo hiểm nào, cả phía người lao động lẫn phía công ty.

**10. Tạm ứng lương.** Đơn, duyệt, chi, rồi **tự khấu trừ ở kỳ sau**. Không có đường này thì nó
vẫn xảy ra, chỉ là xảy ra ngoài hệ thống.

**11. Ai đang giữ tài sản gì.** Mỗi lần cấp và thu là một dòng chuyển giao (§9.16), và danh sách
"chưa trả" phải nối được vào offboarding.

**12. Số liệu nộp cho cơ quan nhà nước.** Xem §9.19.

### 9.19 Nghĩa vụ pháp lý ở Việt Nam

Ba nhóm, và nhóm thứ ba là nhóm hệ này **bắt buộc** phải làm vì bản chất của nó.

**Báo cáo lao động và bảo hiểm.** Mẫu **D02-LT** — báo cáo tình hình sử dụng lao động kèm danh
sách tham gia BHXH, BHYT, BHTN — nộp **hai lần một năm**, trước ngày 5 tháng 6 và trước ngày 5
tháng 12, theo Quyết định 1040/QĐ-BHXH sửa bởi 948/QĐ-BHXH. Nó cần đúng những trường hệ này đã
giữ: họ tên, mã BHXH, ngày sinh, giới tính, số giấy tờ tuỳ thân, chức danh, loại hợp đồng và
thời hạn, mức lương cùng phụ cấp. **Nên nó phải xuất được, không phải chép tay.** Ngoài ra là
báo tăng, báo giảm, báo điều chỉnh khi có người vào, ra hoặc đổi lương.

**Thuế thu nhập cá nhân.** Khấu trừ và kê khai theo kỳ, và **quyết toán năm** cho từng người.
Dữ liệu đã nằm ở `PayslipLine` (§9.6) nếu từng khoản là một dòng — đây là lý do thứ hai để
không nhét phiếu lương vào một ô JSON.

**Bảo vệ dữ liệu cá nhân — và chỗ này hệ chấm công khuôn mặt không có đường vòng.** Nghị định
**13/2023/NĐ-CP**, hiệu lực 01/07/2023, xếp **dữ liệu sinh trắc học, gồm đặc điểm khuôn mặt,
vào nhóm dữ liệu cá nhân nhạy cảm**. Hệ này lưu embedding khuôn mặt trên kiosk và bản mã hoá ở
server, nên nó **là** bên xử lý dữ liệu nhạy cảm, không phải một phần mềm quản lý thông thường.
Bốn nghĩa vụ kéo theo, và cả bốn đều là việc phải dựng chứ không phải điều khoản để dán vào
hợp đồng:

- **Đồng ý riêng cho dữ liệu sinh trắc**, tách khỏi hợp đồng lao động, ghi lại thời điểm và
  phiên bản văn bản đã đồng ý (§9.16 mục tài liệu). Đồng ý gộp vào hợp đồng là đồng ý không
  chứng minh được.
- **Đánh giá tác động xử lý dữ liệu** theo Điều 24, và khai bộ phận phụ trách với Bộ Công an.
- **Nhật ký truy cập**: ai đã xem hoặc xuất dữ liệu sinh trắc, lúc nào. `AuditLog` đã có, phải
  phủ tới đây.
- **Quyền xoá**. Một người nghỉ việc thì mẫu khuôn mặt **xoá thật** ở cả server lẫn mọi kiosk
  từng nhận — hồ sơ nhân sự ở lại, sinh trắc thì không (§9.14). Đây là thứ duy nhất trong hệ bị
  xoá thật, và §7.5 đã có đường `DELETE` xuống kiosk để làm việc đó.

### 9.20 Sáu thứ cắt ngang mọi phân hệ

Không thuộc phân hệ nào, nhưng thiếu thì phân hệ nào cũng khó dùng.

**Nhập và xuất hàng loạt.** Mọi bảng lớn cần nhập từ Excel theo hai nhịp — chạy thử, xem báo cáo
lỗi từng dòng, rồi nhập thật — và xuất ra định dạng mở được bằng Excel (kèm BOM, cùng lý do đã
gặp ở bảng chấm công).

**Trung tâm thông báo.** Một chỗ trong ứng dụng, cộng email cho thứ cần rời khỏi ứng dụng. Mỗi
người tự chọn nhận gì. Không có nó thì hoặc gửi quá nhiều rồi bị bỏ qua, hoặc gửi quá ít rồi
đơn nằm chết.

**Uỷ quyền duyệt.** Cấp trên nghỉ phép thì đơn của cấp dưới không được đứng lại. Uỷ quyền có
thời hạn, và **việc đã duyệt ghi tên người duyệt thật**, không ghi tên người uỷ quyền.

**Nhiều pháp nhân.** Ở quy mô này công ty thường có nhiều chi nhánh hoặc nhiều pháp nhân, mà
lương và báo cáo BHXH nộp **theo từng pháp nhân**. Nên `LegalEntity` phải có từ đầu và mọi bảng
lương gắn vào nó — thêm vào sau là sửa mọi truy vấn.

**Điện thoại là thiết bị chính của người lao động, không phải máy tính.** Công nhân không có
máy để mở cổng nhân viên. Bốn màn của §9.10 dành cho `EMPLOYEE` phải dùng được trên màn hình
hẹp; phần quản trị thì không cần.

**Tìm kiếm toàn cục.** Một ô tìm ra người, phòng ban, đơn, phiếu lương. Ở ba mươi nghìn hồ sơ,
điều hướng bằng menu là quá chậm cho việc HR làm nhiều nhất trong ngày: tìm một người.

### 9.21 Điện thoại: thiết bị chính của phần lớn người dùng

Ở một công ty vài nghìn người, **số người có máy tính là thiểu số**. Công nhân, nhân viên kho,
lái xe, bảo vệ — họ chỉ có điện thoại. Nếu cổng nhân viên chỉ dùng được trên máy tính thì mọi
thứ §9.17 hứa đều quay về thành tin nhắn cho HR, và cả phần này thành trang trí.

**PWA, không phải ứng dụng native.** Cài được từ trình duyệt, chạy toàn màn hình, nhận thông
báo đẩy — và **web push nay chạy trên cả iOS**. Native chỉ đáng khi phải chạm sâu vào phần cứng
(BLE, AR, cảm biến chạy nền), mà trong hệ này phần cứng **chính là cái kiosk**, không phải cái
điện thoại. Chọn native ở đây là nhận thêm hai bản dựng, hai vòng duyệt cửa hàng và hai chỗ để
quên vá, đổi lại không được gì.

**Không chấm công bằng điện thoại — và đây là quyết định, không phải thiếu sót.** Phần mềm HR
trong nước hay có chấm công GPS. Hệ này **cố ý không làm**, vì toàn bộ §3 và §6 tồn tại để một
lượt chấm công không giả được: có liveness, có mẫu khuôn mặt, có phần cứng đặt tại chỗ. Thêm
một đường GPS giả được trong ba mươi giây là tự phá đúng thứ mình vừa xây. Điện thoại ở đây để
**xem và gửi đơn**, không để chấm công.

#### 9.21.1 Hai mô hình điều hướng, không phải một cái thu nhỏ

Thanh bên của §9.15 là cấu trúc đúng cho màn rộng và **sai hoàn toàn cho màn hẹp**: nó nuốt
một phần ba bề ngang hoặc trốn sau một nút mà không ai bấm.

| | Màn rộng | Màn hẹp |
|---|---|---|
| Điều hướng chính | thanh bên chia nhóm, gập được | **thanh tab dưới đáy**, tối đa 5 mục |
| Hành động chính | nút trong trang | **neo ở đáy**, trong tầm ngón cái |
| Bảng | nhiều cột, cuộn ngang | **thẻ một dòng một người**, không cuộn ngang |
| Bộ lọc | hàng ngang trên bảng | **tấm trượt lên từ đáy** |

Thanh tab của `EMPLOYEE` có đúng bốn mục: **Trang chủ · Chấm công · Đơn từ · Lương**.
`MANAGER` thêm mục thứ năm **Chờ duyệt** mang số đếm. Quá năm mục thì mục nào cũng hẹp và
chạm nhầm — đó là lý do trần năm, không phải thẩm mỹ.

**Bảng trên màn hẹp không phải là bảng.** Cuộn ngang một bảng bảy cột trên điện thoại là thao
tác không ai làm. Mỗi dòng thành một thẻ mang ba thông tin quan trọng nhất, chạm vào mở chi
tiết. Cột nào không lọt vào ba thứ đó thì nó không quan trọng như mình tưởng.

#### 9.21.2 Vùng ngón cái quyết định chỗ đặt nút

Người ta cầm điện thoại một tay, và **góc trên bên kia của màn hình là chỗ khó với nhất**. Nên:

- Hành động chính nằm **ở đáy**, không ở đầu trang. Nút *Duyệt* và *Từ chối* của một đơn nằm
  dưới cùng thẻ, sau khi đã đọc hết nội dung — vừa đúng tầm tay vừa đúng thứ tự đọc.
- Hành động **phá huỷ không đặt cạnh hành động thường dùng**. Xoá không nằm sát Lưu.
- Điều hướng lùi dùng cả cử chỉ vuốt lẫn nút, vì một nửa số người không biết cử chỉ.

**Mọi đích chạm tối thiểu 44 × 44 px.** Bộ primitive hiện tại **chưa đạt**: đo ra nút thường
**40 px**, nút nhỏ **32 px**, ô tích **16 px**. Ba con số ấy đều dưới ngưỡng, nên `components/ui/`
cần một cỡ cho màn cảm ứng chứ không phải chỉnh lại cỡ đang dùng cho chuột.

#### 9.21.3 Mạng yếu là trạng thái thường, không phải lỗi

Nhà xưởng, tầng hầm, ngoài công trường. Ba luật:

1. **Thứ đã xem phải xem lại được khi mất mạng.** Phiếu lương gần nhất, số dư phép, lịch ca của
   tôi — service worker giữ bản đã tải. Một người mở ứng dụng trong hầm gửi xe để xem ca mai
   phải thấy được ca mai.
2. **Đơn gửi lúc mất mạng thì xếp hàng, không mất.** Ghi lại, đồng bộ khi có sóng, và **nói rõ
   là đang chờ gửi** — im lặng ở đây là người ta gửi lại ba lần.
3. **Tải trang đầu phải nhẹ.** Máy Android tầm thấp trên 3G là cấu hình thật của người dùng
   này, không phải trường hợp biên.

#### 9.21.4 Thông báo đẩy là thứ khiến cổng nhân viên được dùng

Không có thông báo thì một cổng tự phục vụ chỉ được mở khi người ta nhớ ra nó. Bốn loại đáng
đẩy, và **chỉ bốn**: đơn của tôi đã được quyết, có đơn chờ tôi duyệt, phiếu lương kỳ này đã
phát, và hợp đồng của tôi sắp hết hạn. Mỗi loại tắt riêng được.

**Không đẩy nội dung nhạy cảm vào màn khoá.** "Phiếu lương tháng 9 đã có" là đủ; con số thì
nằm sau lần đăng nhập, cùng lý do §9.11 không đính kèm phiếu vào email.

**Luật này phải do kiểu dữ liệu giữ, không do người viết nhớ.** `Notification` **không có cột
nào chứa câu chữ**: nó giữ `kind` là enum bốn giá trị, cộng vài tham chiếu (`requestId`,
`periodId`, số ngày còn lại). Câu hiển thị dựng ở phía đọc — frontend cho chuông trong ứng
dụng, service worker cho màn khoá — và cả hai lấy chữ từ catalogue. Không có chỗ nào để lỡ tay
nhét số tiền vào, vì không có cột nào nhận được một số tiền.

**Ba kênh, bật tắt theo từng loại.**

| Kênh | Mặc định | Ghi chú |
|---|---|---|
| Trong ứng dụng | **bật** cả bốn loại | Rẻ, không làm phiền, và là nơi xem lại |
| Đẩy tới máy | **bật** cả bốn loại | Đây là thứ khiến cổng được mở |
| Email | **tắt** cả bốn loại | Phiếu lương đã có đường thư riêng ở §9.11; bật thêm ở đây là gửi hai lần cùng một tin |

**Một thông báo hỏng không được làm hỏng việc nó mô tả.** Duyệt một đơn xong mà không gửi được
thông báo thì đơn **vẫn đã duyệt** — cùng luật với `AuditService`: mất lời nhắn còn hơn huỷ việc
đã làm.

**`PushSubscription` khoá theo `endpoint`, không khoá theo người.** Một người có điện thoại và
máy tính là hai đăng ký; đăng xuất thì xoá đúng đăng ký của máy ấy. Nhà cung cấp trả `404` hoặc
`410` nghĩa là đăng ký đã chết — xoá ngay, đừng thử lại, vì nó sẽ không bao giờ sống lại.

#### 9.21.5 Màn nào lên điện thoại, màn nào không — nói thẳng

Trả lời "tất cả" là câu trả lời dễ và sai. Một màn chốt kỳ lương cho ba mươi nghìn người, hay
một màn nhập hàng loạt, hay một màn tái cơ cấu tổ chức — nhồi chúng vào màn hẹp không làm chúng
dễ tiếp cận hơn, chỉ làm chúng **nguy hiểm hơn**.

| Nhóm màn | Điện thoại |
|---|---|
| Mọi thứ của `EMPLOYEE`: trang của tôi, công, đơn từ, lương, lịch ca | **ưu tiên màn hẹp** — thiết kế cho điện thoại trước |
| `MANAGER`: hộp chờ duyệt, nhóm của tôi, lịch nghỉ nhóm | **ưu tiên màn hẹp** |
| HR tra cứu: danh bạ, hồ sơ một người, cây tổ chức | dùng được, nhưng thiết kế cho màn rộng trước |
| HR thao tác nặng: chốt lương, nhập hàng loạt, tái cơ cấu, sửa bảng công | **chỉ màn rộng** — và nói rõ điều đó thay vì để nó vỡ âm thầm |

Luật rút ra: **màn nào hỏng được dữ liệu ở quy mô lớn thì không nằm cách một ngón tay cái.**

### 9.22 Dữ liệu: cái gì mất được, cái gì không

Mọi phần trên đây đều giả định dữ liệu còn đó. Mục này nói cái gì giữ nó còn đó.

#### 9.22.1 Phân loại theo khả năng dựng lại, không theo độ quan trọng

Hỏi "cái nào quan trọng" thì câu trả lời luôn là "tất cả". Hỏi **"mất rồi có dựng lại được
không"** thì ra được thứ tự hành động.

| Loại | Ví dụ | Mất thì sao | Bảo vệ |
|---|---|---|---|
| **Không dựng lại được** | lượt chấm công, đơn đã duyệt, phiếu lương đã phát, nhật ký kiểm toán | mất vĩnh viễn, và là tranh chấp lao động | sao lưu + WAL, kiểm phục hồi định kỳ |
| **Dựng lại được nhưng đắt** | hồ sơ nhân sự, cây tổ chức, hợp đồng | nhập lại từ giấy, hàng tuần công | sao lưu hằng ngày |
| **Dựng lại được** | bảng ngày công, số liệu báo cáo, nội dung đệm | chạy lại job là có | không cần sao lưu riêng |
| **Không được phép giữ lâu** | mẫu khuôn mặt của người đã nghỉ | rủi ro pháp lý khi **còn**, không phải khi mất | xoá thật (§9.19) |

Dòng cuối là dòng ngược đời và là dòng dễ quên nhất: với dữ liệu sinh trắc, **giữ lại mới là
lỗi**. Sao lưu cũng phải tôn trọng điều đó — một bản sao lưu ba năm tuổi chứa embedding của
người đã nghỉ vẫn là dữ liệu nhạy cảm đang được lưu trữ.

#### 9.22.2 Sao lưu: ba câu hỏi phải trả lời bằng số

Một lịch sao lưu không nói lên điều gì. Ba con số mới nói:

- **RPO — chấp nhận mất bao nhiêu?** Với lượt chấm công và phiếu lương, câu trả lời là **gần
  bằng không**, nên chỉ sao lưu mỗi đêm là không đủ: cần **lưu trữ WAL liên tục** để phục hồi
  tới một thời điểm bất kỳ.
- **RTO — chấp nhận dừng bao lâu?** Kiosk vẫn chấm công được khi server chết (hàng đợi offline
  của §6.2.6), nên áp lực thấp hơn vẻ ngoài. Nhưng ngày trả lương thì khác hẳn.
- **Phục hồi mất bao lâu thật?** Con số duy nhất có giá trị là con số **đã bấm giờ trên một
  lần phục hồi thật**. Một bản sao lưu chưa từng phục hồi thử là một giả định, không phải một
  bản sao lưu.

**Kiểm phục hồi định kỳ là một task, không phải một lời hứa.** Dựng lại từ bản sao lưu vào một
cơ sở dữ liệu tạm, đếm số dòng của các bảng không dựng lại được, và ghi thời gian. Không có
bước này thì cả mục 9.22 chỉ là văn.

**Sao lưu phải mã hoá và phải để ngoài máy chủ đang chạy.** Sao lưu nằm cùng ổ với dữ liệu gốc
bảo vệ được đúng một tình huống: xoá nhầm. Nó không bảo vệ được hỏng ổ, không bảo vệ được mã
độc tống tiền, và không bảo vệ được xoá nhầm cả máy.

#### 9.22.3 Di trú lược đồ: không bao giờ phá và dựng trong cùng một lần

Bài học vừa gặp khi chuyển `Employee.department` từ chuỗi sang khoá ngoại: cách an toàn là
**nở rồi mới co**, ba nhịp và **không dồn vào một lần phát hành**:

1. **Nở** — thêm cột mới, để cột cũ nguyên. Bản cũ của ứng dụng vẫn chạy.
2. **Đổ dữ liệu** — chuyển sang cột mới, kiểm đếm đủ.
3. **Co** — bỏ cột cũ, ở lần phát hành sau, khi đã chắc không còn ai đọc nó.

Gộp ba nhịp vào một migration thì lúc quay lui không còn đường: cột cũ đã mất.

**Ba luật kèm theo.**

- **Đổi dữ liệu tách khỏi đổi lược đồ.** Một `UPDATE` trên năm triệu dòng khoá bảng đủ lâu để
  API hết giờ. Đổ dữ liệu đi theo lô, chạy được lại, và ngoài giờ cao điểm.
- **Sửa một migration đã chạy là chuyện không làm.** Sai thì thêm migration mới. Đây cũng là lý
  do không được lấy `migrate reset` làm cách sửa lỗi: xoá cả cơ sở dữ liệu để sửa một ô là đổi
  một lỗi nhỏ lấy mất toàn bộ dữ liệu không dựng lại được.
- **Migration chạy trên bản sao trước khi chạy trên bản thật**, và bấm giờ ở đó.

#### 9.22.3b Chia mảnh: `AttendanceDay` chia được, `AttendanceRecord` thì không

Hai bảng lớn nhất, và chúng **không cùng một câu trả lời** — khác biệt nằm ở khoá duy nhất.

**`AttendanceDay` chia theo tháng, không vướng gì.** Khoá duy nhất của nó là
`(employeeId, date)`, mà `date` **chính là khoá chia mảnh**, nên Postgres chấp nhận thẳng. Đây
cũng là bảng đáng chia nhất: bảng lương và mọi báo cáo đọc nó theo khoảng ngày, nên cắt mảnh là
cắt luôn phần lớn công việc quét.

**`AttendanceRecord` thì chia sẽ làm yếu chống trùng, nên dừng lại và hỏi.** Khoá của nó là
`(deviceId, localId)` — **toàn cục, không có ngày trong đó** — và đó là thứ giữ cơ chế giao ít
nhất một lần ở §6.2.6: kiosk gửi lại bản ghi chưa được ack, máy chủ nhận ra bản trùng bằng đúng
cặp ấy. Postgres đòi **mọi khoá duy nhất trên bảng chia mảnh phải chứa khoá chia mảnh**, nên
chia theo `ts` buộc khoá thành `(deviceId, localId, ts)`.

Cặp ba ấy *có vẻ* vẫn chống trùng được, vì bản gửi lại mang đúng `ts` cũ. Nhưng nó chỉ đúng
chừng nào **không ai từng sửa `ts` sau khi nhận** — và §6.2.5 để ngỏ đúng chuyện đó: bản ghi có
`clockUnsynced` là bản ghi có đồng hồ sai, và một ngày nào đó sẽ có người muốn hiệu chỉnh nó.
Hiệu chỉnh xong, bản gửi lại rơi vào mảnh khác và **trùng lặp âm thầm** — thành một lượt chấm
công thừa, rồi thành tiền.

Nên đây là **quyết định phải hỏi trước, không phải tối ưu hoá được tự làm** (§1.2). Ba đường đi
và cái giá của từng đường:

| Đường | Được gì | Mất gì |
|---|---|---|
| Không chia, chỉ đánh chỉ mục theo `ts` | giữ nguyên chống trùng | bảng lớn dần vô hạn, xoá theo hạn lưu là `DELETE` hàng triệu dòng |
| Chia theo `ts`, khoá `(deviceId, localId, ts)` | cắt mảnh, xoá bằng `DROP` | chống trùng gãy nếu `ts` từng bị sửa |
| Chia theo `ts`, thêm bảng chống trùng riêng không chia | giữ cả hai | bảng chống trùng lớn đúng bằng bảng gốc, chỉ nhẹ hơn về bề rộng |

**Chốt: đường thứ nhất — không chia `AttendanceRecord`, chỉ đánh chỉ mục theo `ts`.**

Ba lý do, theo thứ tự quan trọng.

Thứ nhất, hai đường còn lại đều đem **rủi ro tiền** đổi lấy **tiện lợi vận hành**, và đó là sai
hướng. Chống trùng hỏng không kêu: nó không đổ lỗi, không ghi log, nó chỉ đẻ thêm một lượt chấm
công, rồi lượt ấy thành một ngày công, rồi thành một dòng trên phiếu lương. Còn bảng phình to
thì kêu ngay, kêu sớm, và có nhiều cách chữa.

Thứ hai, bảng mà bảng lương thật sự đọc là `AttendanceDay`, và **nó đã chia mảnh rồi**.
`AttendanceRecord` là bản ghi thô: một tháng của toàn công ty truy vấn đúng một mảnh
`AttendanceDay`, không ai phải quét bảng thô để tính lương. Cái giá của việc không chia bảng thô
vì thế nhỏ hơn nhiều so với vẻ ngoài của nó.

Thứ ba, chưa có số đo nào nói bảng thô đang gây đau. Quyết định đổi khoá duy nhất của một bảng
đang giữ đúng dữ liệu tiền lương cần một bảng đo đứng sau, không phải một linh cảm về quy mô.

**Điều kiện mở lại quyết định này**, ghi rõ để lần sau không phải bàn từ đầu: khi `DELETE` theo
hạn lưu trên `AttendanceRecord` vượt cửa sổ bảo trì, **hoặc** khi có người thật sự dựng đường
hiệu chỉnh `ts` cho bản ghi `clockUnsynced` (§6.2.5). Vế thứ hai quan trọng hơn vế thứ nhất:
ngày nào `ts` còn bất biến sau khi nhận thì đường thứ hai vẫn còn khả thi, mất vế ấy là mất luôn
lựa chọn.

#### 9.22.3c Nở rồi co, và một công cụ giữ luật thay cho trí nhớ

Mọi migration phá huỷ chia làm **hai lần phát hành**: lần này **thêm** cột hoặc bảng mới và đổ
dữ liệu sang; lần sau mới **bỏ** cái cũ đi. Giữa hai lần ấy, bản cũ của ứng dụng vẫn chạy được
trên lược đồ mới — và đó là toàn bộ lý do: quay lui một bản phát hành không được biến thành mất
dữ liệu.

Luật này chết nếu chỉ nằm trong tài liệu, vì người viết migration lúc hai giờ sáng không đọc
tài liệu. Nên `tools/check_migrations.py` đọc từng file migration và **fail khi một câu lệnh phá
huỷ đứng một mình**:

| Câu lệnh | Cần gì để được đi qua |
|---|---|
| `DROP TABLE` · `DROP COLUMN` | một dòng chú thích ngay trên nó nói rõ bản nào đã đổ dữ liệu sang, dạng `-- contract of <tên migration>` |
| `ALTER COLUMN ... TYPE` | chú thích `-- widening`, và kiểu mới phải rộng hơn kiểu cũ |
| `ALTER COLUMN ... SET NOT NULL` | chú thích `-- backfilled by <tên migration>` |
| `DROP CONSTRAINT` | chú thích `-- replaced by <tên>` |
| `TRUNCATE` | không bao giờ; không có chú thích nào cho qua |

Một `DROP` có chú thích vẫn là một `DROP` — công cụ không ngăn được người cố tình. Nó ngăn được
thứ hay xảy ra hơn nhiều: **bỏ quên**, tức viết `DROP COLUMN` trong cùng lần phát hành với lệnh
thêm cột, vì lúc ấy nó trông hoàn toàn hợp lý.

#### 9.22.4 Ràng buộc đặt ở cơ sở dữ liệu, không chỉ ở tầng ứng dụng

Phép kiểm trong code chỉ đúng khi **mọi** đường ghi đều đi qua nó, mà không bao giờ đủ: còn
migration, còn script sửa tay, còn hai request chạy song song. Nên những thứ sau nằm ở tầng dữ
liệu:

- khoá ngoại thật, không phải "id trỏ tới" bằng niềm tin;
- `unique(deviceId, localId)` chống trùng chấm công — đã có từ §4.3;
- ràng buộc loại trừ chặn đơn nghỉ chồng ngày (§9.5), vì hai request song song thì phép kiểm
  trong code cho qua cả hai;
- `CHECK` cho thứ không bao giờ được âm: số ngày phép, số tiền trên dòng phiếu lương.

#### 9.22.5 Nhìn thấy truy vấn chậm trước khi người dùng thấy

Ở ba mươi nghìn nhân viên, một truy vấn thiếu chỉ mục không hỏng ngay — nó **chậm dần** cho tới
ngày không ai chịu nổi, và lúc đó không ai nhớ đã thêm gì.

- Bật `pg_stat_statements` và xem bảng xếp hạng theo **tổng thời gian**, không theo thời gian
  trung bình: một truy vấn 20 ms chạy một triệu lần tốn hơn một truy vấn 2 giây chạy mười lần.
- Ghi nhật ký mọi câu vượt ngưỡng, kèm tham số.
- Mỗi truy vấn mới trên bảng lớn phải **xem `EXPLAIN` một lần** trước khi lên, và nếu nó quét
  toàn bảng thì hoặc có chỉ mục hoặc có lý do ghi lại.
- Theo dõi **kích thước bảng và độ phình** theo tuần. Bảng lượt chấm công lớn nhanh nhất và là
  bảng đầu tiên cần chia mảnh (§9.9 luật 2).

#### 9.22.6 Kết nối và bản sao đọc

Mỗi tiến trình Node giữ một bể kết nối, mà Postgres tính mỗi kết nối là một tiến trình. Nhân
lên vài bản chạy là chạm trần trước khi chạm giới hạn CPU. Nên khi vượt một bản chạy, **đặt
PgBouncer ở giữa** ở chế độ transaction.

**Báo cáo nặng đọc từ bản sao, không đọc từ bản chính.** Một lượt gộp toàn công ty không được
phép làm chậm lượt ghi của kiosk đang chấm công. Kèm theo một luật: bản sao có **độ trễ**, nên
thứ vừa ghi xong mà đọc ngay thì đọc ở bản chính — phiếu lương vừa phát là ví dụ.

#### 9.22.7 Giữ bao lâu, và xoá thế nào

Giữ mãi mọi thứ vừa tốn vừa là rủi ro. Nhưng dữ liệu lao động có thời hiệu pháp lý, nên **mặc
định là giữ**, và chỉ dọn thứ có lý do dọn:

| Dữ liệu | Giữ | Vì sao |
|---|---|---|
| Lượt chấm công, phiếu lương, hợp đồng | **giữ lâu dài** | thời hiệu tranh chấp lao động và nghĩa vụ lưu trữ |
| Nhật ký sự kiện thiết bị | vài tháng | chỉ dùng để chẩn đoán |
| Bảng ngày công | dựng lại được, nhưng giữ vì nó là đầu vào bảng lương đã chốt | |
| Mẫu khuôn mặt của người đã nghỉ | **xoá ngay** | §9.19 — giữ mới là lỗi |
| Nhật ký truy cập dữ liệu nhạy cảm | giữ lâu hơn dữ liệu nó mô tả | nó là bằng chứng cho chính việc xoá |

**Xoá theo lô và xoá được lại.** Dọn vài triệu dòng bằng một `DELETE` là khoá bảng và phình
WAL. Chia mảnh theo tháng rồi `DROP` một mảnh là tức thì (§9.9 luật 2) — đây là lý do thứ hai
để chia mảnh, ngoài tốc độ truy vấn.


### 9.23 Nhiều người, nhiều thiết bị, nhiều bản chạy

§9.22.4 nói ràng buộc phải nằm ở tầng dữ liệu. Mục này nói **vì sao** và **khi nào** phép kiểm
trong code là không đủ, vì ở quy mô này chuyện hai người bấm cùng lúc không phải ngoại lệ.

**Luật 1 — cái gì phải duy nhất thì ràng buộc phải ở cơ sở dữ liệu, không ở phép `if`.**
Tám người cùng thêm một mã nhân viên thì phép `if` trong code cho qua cả tám: mỗi tiến trình
đọc "chưa có" trước khi ai kịp ghi. Đo thật: tám request song song → **một 201, bảy 409, đúng
một dòng**, và thứ làm việc đó là `unique(code)` chứ không phải câu lệnh nào trong service.

**Luật 2 — đếm thì đếm trong câu lệnh, đừng đếm trong tiến trình.** `x = x + 1` viết bằng
JavaScript là đọc–sửa–ghi, và hai lượt song song mất một nhịp. Đo thật: mười lượt đăng ký đồng
thời xuống một kiosk chỉ đẩy `rosterVersion` **từ 4 lên 6**. Hậu quả không trừu tượng — phiên
bản danh sách là thứ heartbeat so để biết kiosk có thiếu ai không, nên mất nhịp nghĩa là
**người đã đăng ký trên máy chủ mà thiếu trên kiosk, còn heartbeat vẫn báo khớp**. Viết bằng
`SET x = x + 1` thì mười lượt ra đúng mười.

**Luật 3 — đổi trạng thái thì để chính câu lệnh ghi giành lấy trạng thái.** `if (đang rảnh)`
rồi mới `update` là hai bước, và giữa hai bước có người khác. Điều kiện phải nằm trong `WHERE`
của chính lệnh ghi, rồi **đếm số dòng đã đổi**: không dòng nào nghĩa là người khác giành trước.

**Luật 4 — một tiến trình Node không phải là một ổ khoá.** Node chạy một luồng nên hai request
tới cùng lúc thường bị xếp hàng, và một phép kiểm-rồi-ghi **trông như** an toàn khi thử trên
máy. Đo thật: hai mươi lượt cấp cùng một tài sản trên một bản chạy vẫn ra đúng một dòng — và
điều đó **không chứng minh gì cả**, vì §9.22.6 nói bản chạy thứ hai là câu trả lời bình thường
cho tải. Đã qua Traefik là không còn gì xếp hàng giúp nữa. Nên thử nghiệm đồng thời trên một
bản chạy chỉ dùng để **bắt lỗi**, không bao giờ dùng để **kết luận an toàn**.

**Luật 5 — một người có nhiều thiết bị, nên phiên là dòng chứ không phải ô.** Giữ đúng một
`refreshTokenHash` trên `User` thì một tài khoản chỉ đăng nhập được một chỗ. Tệ hơn là cách nó
hỏng: lượt gia hạn thứ hai không khớp ô, hệ coi là token bị đánh cắp và **xoá sạch phiên**, nên
đăng nhập điện thoại rồi laptop là **mất cả hai** trong một chu kỳ token. Đo thật lúc còn một ô:
A và B cùng đăng nhập đều 200, rồi cả hai lượt gia hạn đều **401**. Một lần đăng nhập thứ hai
bình thường không được phép trông giống một vụ trộm, mà với một ô duy nhất thì nó **không thể
trông khác** — cùng lý do §9.16 mục 11 bắt lịch sử tài sản là dòng.

`Session` vì thế giữ một dòng mỗi thiết bị, và token gia hạn mang **hai** thứ: `sid` chỉ dòng,
`jti` chỉ token mà dòng ấy còn nhận. Tách ra như vậy thì phát hiện dùng lại mới **khu trú được**
— lượt gia hạn cầm `jti` đã tiêu chỉ đóng đúng dòng của nó, các thiết bị khác chưa chứng tỏ điều
gì nên giữ nguyên phiên. Ba việc đóng **tất cả**: nghỉ việc, đổi mật khẩu, và tài khoản bị tắt.
Một lượt đăng nhập cũng là một lượt dọn: xoá dòng đã hết hạn hoặc đã đóng, rồi bỏ thiết bị lâu
nhất nếu tài khoản chạm trần `SESSIONS_PER_USER` — bảng phiên không được phép là bảng chỉ lớn
lên. Đo sau khi sửa: điện thoại và laptop cùng gia hạn đều **200**; một lượt dùng lại trên điện
thoại giết đúng phiên điện thoại còn laptop vẫn **200**; đổi mật khẩu đưa số phiên sống về **0**;
mở quá trần thì số dòng dừng đúng ở trần.

**Luật 6 — thử đồng thời là một phép đo, và phải ghi số.** Mỗi chỗ nghi ngờ thì bắn N request
song song rồi đếm dòng trong cơ sở dữ liệu. Con số vào `docs/measurements/`, không vào trí nhớ.

**Luật 7 — một người, nhiều cửa: máy này nhận mặt thì máy kia phải thôi hỏi.** Người mới được
gán vào nhiều kiosk, và hợp đồng đã phân biệt sẵn `ASSIGN` ("chờ người này tới lấy mặt") với
`UPSERT` ("đây là mặt rồi"). Nên khi một cửa lấy được mặt, máy chủ phải **đẩy mẫu sang mọi cửa
còn lại và chuyển chúng sang `ENROLLED`** — để nguyên `ASSIGN` chính là thứ khiến cửa thứ hai
hỏi lại.

Năm điều kèm theo, mỗi điều bịt một khe khác nhau:

- **Chất lượng quyết định, không phải thứ tự tới.** Hai cửa cùng lấy được thì bản mờ có thể tới
  sau, và một `upsert` trơ sẽ đè bản tốt. Điều kiện `quality` nằm trong `WHERE` của chính lệnh
  ghi, nên **kết quả không phụ thuộc bản nào tới trước** — đo bốn lượt song song đều giữ bản
  95 và bỏ bản 40.
- **Báo cáo phải đến từ cửa đã được giao người ấy.** Máy chủ nhận dữ liệu sinh trắc thì không
  được chỉ dựa vào phép xác thực của broker: không có dòng `DeviceEnrollment` thì từ chối.
- **Đường sửa chữa phải chạy được từ chính trạng thái cần sửa.** `resync` từng suy ra phiên
  bản bắt đầu bằng phép trừ, nên một máy giữ nhiều người hơn số đếm của nó sẽ sinh phiên bản
  âm, bị hợp đồng từ chối, và **đúng cái cửa cần đẩy lại cả danh sách là cái cửa không bao giờ
  nhận được**. Nâng số đếm lên bằng số dòng trước khi phát lại.
- **Kiosk chỉ lùi phiên bản khi máy chủ bảo nó lùi.** Giao ít nhất một lần nghĩa là hai lần
  đẩy có thể tới lệch thứ tự, và một bản tin cũ tới sau vừa ghi đè mặt mới vừa kéo số đếm
  xuống. Luật ở firmware có hai nửa. Bản tin **đếm tăng** — `ASSIGN`, `UPSERT`, `DELETE`,
  `DELETE_EMPLOYEE`, `REVOKE` — mang số phiên bản **không lớn hơn** số đang giữ thì bỏ hẳn:
  không áp dụng, không ghi số. `REPLACE_ALL` thì ngược lại, **luôn áp dụng và đặt số đang giữ
  bằng số nó mang**, kể cả khi số ấy nhỏ hơn.
- **Vì sao `REPLACE_ALL` được miễn.** Nó không phải một bước đếm mà là một lời tuyên bố lại:
  `resync` phát cả danh sách từ mốc `top − số dòng`, và một cửa sống lâu có số phiên bản lớn
  hơn số người nó giữ rất nhiều — mỗi lượt gán, thu hồi, hay lan mẫu đều đẩy số lên trong khi
  số dòng thì không. **Mốc mở màn gần như luôn thấp hơn số kiosk đang giữ.** Đem cùng phép so
  sánh áp lên `REPLACE_ALL` là vứt bỏ phần đầu của mọi lượt đồng bộ lại, và cái mất không phải
  số dòng mà là **hai thứ đúng ra phải biến mất**. Chạy chính vị từ ấy trên lượt `resync` máy
  chủ phát thật — kiosk đang ở 98 giữ một người đã nghỉ và một mẫu cũ, máy chủ ở 100 với ba
  người: luật miễn `REPLACE_ALL` ra đúng ba dòng, mẫu mới, không còn người đã nghỉ; luật lọc
  tất ra **bốn dòng, mặt người đã nghỉ vẫn mở được cửa, mẫu cũ vẫn nguyên — mà số phiên bản vẫn
  là 100 nên heartbeat báo khớp**. Hỏng im lặng, đúng thứ luật này sinh ra để chặn.
  🔬 Vị từ đo trên máy chủ dựng, chưa đo trên board: hàng đợi, NVS và bảng mặt chưa ai thấy chạy.


---

### 9.24 Nhật ký kiểm toán: một bảng, một câu hỏi, một bộ từ vựng

`AuditLog` sinh ra để trả lời đúng một câu: **ai đã làm gì với thứ này, lúc nào**. Mọi quyết
định dưới đây chỉ là hệ quả của việc giữ câu ấy trả lời được khi bảng có vài triệu dòng.

**Vấn đề đo được trước khi sửa.** Bảng có 7.488 dòng, trong đó **2.774 dòng (37%) là `/auth`** —
gần như toàn bộ là đăng nhập và gia hạn token. Một lượt gia hạn xảy ra mỗi `JWT_ACCESS_TTL` cho
**mỗi thiết bị**, mà §9.23 luật 5 vừa cho một người nhiều thiết bị, nên con số ấy chỉ có một
hướng đi. Ở quy mô §9.9 giả định, riêng gia hạn đã đủ để nhật ký kiểm toán thành **bảng lớn
nhất trong cơ sở dữ liệu**, và lần đổi lương duy nhất trong ngày nằm lẫn giữa hàng vạn dòng
không ai từng đọc.

**Luật 1 — một lượt gia hạn không phải một quyết định.** Ghi cái gì thì hỏi: sau này có ai truy
ngược tới nó không. Đăng nhập thì có; gia hạn token là **cùng phiên ấy đi tiếp**, không ai quyết
định gì. Route nào như vậy thì đánh dấu ngay tại chỗ khai nó bằng `@NotAudited()`, chứ không để
bộ chặn đoán theo đường dẫn — đường dẫn đổi thì phép đoán lệch mà không ai biết.

**Luật 2 — `action` có đúng một bộ từ vựng, khai một chỗ.** Trước đó cột này chứa lẫn lộn động
từ HTTP (`POST`) với tên nghiệp vụ (`compensation.create`), tức hai ngôn ngữ trong một cột và
không truy vấn nào gộp được chúng. Nay mọi tên nằm ở `audit-actions.ts`, **đúng cùng lý do
§4.3 bắt tên khoá cache nằm ở `cache-keys.ts` và tên hàng đợi ở `queues.ts`**: chuỗi gõ rời rạc
là chuỗi sẽ gõ sai, và không ai liệt kê được hệ thống ghi lại những gì.

**Luật 3 — chủ thể là một cặp, không phải một chuỗi.** `target` cũ khi thì là đường dẫn
(`/users/:id`), khi thì là mã nhân viên (`412`), khi thì là **số người bị di chuyển** trong một
lượt tái cơ cấu. Không gì trong dòng cho biết đang là loại nào. Tách thành `subjectType` với
`subjectId` thì câu **"mọi thứ từng xảy ra với nhân viên 412"** mới có chỉ mục để chạy — mà đó
chính là hình dạng của việc truy ngược: người ta tra từ **đối tượng**, không tra từ route.

Hai hệ quả bắt buộc. **Chủ thể là thứ người ta mở trang ra xem**, nên lương, hợp đồng, nghỉ
việc và mỗi lượt đọc dữ liệu sinh trắc đều nằm dưới **chính nhân viên ấy**, còn mã hợp đồng thì
vào `meta` — chia nhỏ chủ thể ra thành `pay`, `contract`, `biometric` là chia đôi câu chuyện của
một con người thành ba bảng con không nối được với nhau. Và **mỗi loại chủ thể chỉ dùng một loại
định danh**: `employee.offboard` từng ghi mã nhân viên trong khi mọi dòng khác ghi id, nên lượt
nghỉ việc vô hình với chính truy vấn dựng ra để tìm nó.

**Luật 4 — thứ đổi được thành tiền hoặc thành quyền thì ghi cả trước lẫn sau.** Biết lương
thành 20 triệu mà không biết nó vốn là bao nhiêu là nửa câu trả lời, và nửa thiếu đúng là nửa
người ta cần khi có tranh chấp. Lương và vai trò vì thế ghi `{ from, to }`. **Hồ sơ cá nhân thì
ngược lại: chỉ ghi tên trường đã đổi, không ghi giá trị** — nhật ký không được trở thành bản sao
thứ hai của dữ liệu cá nhân, vì quyền xoá ở §9.22.1 sẽ phải đuổi theo cả hai chỗ.

**Luật 5 — bộ chặn toàn cục ở lại, nhưng là lưới đỡ.** Một route mới mà không ai nhớ ghi nhật
ký vẫn để lại dấu, dưới `subjectType` là `route`. Lưới đỡ nói được **ai, lúc nào, đụng vào đâu**;
nó không nói được **đổi thành gì** — nên thấy một hành động quan trọng còn nằm ở `route` thì đó
là việc chưa làm xong, không phải đã phủ.

**Luật 6 — ghi nhật ký hỏng thì không được làm hỏng việc.** `record()` nuốt lỗi và chỉ log:
mất một dòng ghi chú còn hơn huỷ chính thao tác mà nó mô tả. Đổi lại, nó **không nằm trong giao
dịch** của thao tác ấy, và đó là đánh đổi có chủ ý chứ không phải sơ suất.
