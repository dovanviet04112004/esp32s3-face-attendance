# ADR-0001 — Chọn YuNet làm student phát hiện mặt, thay vì ULFG

- **Trạng thái**: Chấp nhận
- **Ngày**: 2026-08-27
- **Liên quan**: KẾ HOẠCH §1.1 (bảng model), §4.5.6 (`ai_engine/src/detection/`); bị ADR-0002 sửa phần teacher

---

## Bối cảnh

Pipeline trên kiosk có ba chặng nối tiếp: **phát hiện → chống giả mạo → nhận diện**. Chặng
phát hiện là cổng vào — không có mặt thì hai chặng sau không chạy — và nó chạy ở tần suất
cao nhất, mỗi khung hình sau khi ToF đánh thức.

Ràng buộc từ phần cứng và từ hai chặng sau:

| Ràng buộc | Từ đâu |
|---|---|
| Chạy INT8 trên ESP32-S3, arena dùng chung với 2 model còn lại | §3.8 |
| Phải ra **5 landmark** để affine align 112×112 trước MobileFaceNet | §1.1, §7.1 |
| Teacher phải có landmark thì mới distill được đủ hai nhánh | §1.1 |
| Hậu xử lý decode + NMS phải viết lại bằng C, khớp 1:1 bản Python | §4.5.6, `contracts/golden/` |

Hai ứng viên student được xét: **YuNet** (`yunet_n`, từ `libfacedetection.train`) và
**ULFG** (Ultra-Light-Fast-Generic-Face-Detector-1MB, bản `slim` / `RFB`).

## Quyết định

Dùng **YuNet (`yunet_n`)** làm student cho nhánh detect.

## Lý do

**1. ULFG không ra landmark — đây là lý do quyết định.**

ULFG chỉ xuất bounding box. Không có 5 điểm thì không có phép affine warp, MobileFaceNet
nhận ảnh chưa align, và accuracy nhận diện rớt mạnh. Muốn dùng ULFG thì phải tự gắn thêm
landmark head và tự train nó — tức là làm lại đúng phần việc YuNet đã có sẵn và đã được
kiểm chứng, nhưng không có bản tham chiếu để đối chiếu.

**2. Không có landmark thì phí một nửa tín hiệu teacher.**

Teacher là YOLO26m-pose, chọn bản `-pose` chính vì nó có landmark. `kd_localization.py`
distill **cả box lẫn 5 landmark**. Student không có landmark head thì nhánh distill đó
chỉ còn một nửa, và việc chọn teacher `-pose` trở nên vô nghĩa.

**3. Accuracy cách biệt, và cách biệt lớn nhất đúng ở chỗ quan trọng nhất.**

| WIDER FACE val | Easy | Medium | Hard |
|---|---|---|---|
| YuNet (`yunet_n`) | 0.884 | 0.866 | 0.750 |
| ULFG (slim / RFB) | ≈0.77–0.79 | ≈0.67–0.70 | ≈0.40–0.44 |

Số của YuNet lấy từ `opencv_zoo`; số của ULFG lấy từ README upstream. **Cả hai đều là số
công bố, chưa tự đo lại** — nhưng khoảng cách ở cột Hard quá lớn để là nhiễu đo đạc. Hard
là mặt nhỏ, nghiêng, thiếu sáng: đúng tình huống người vừa bước tới kiosk và chưa đứng
ngay ngắn trước camera.

**4. YuNet nhỏ hơn, không phải đánh đổi.**

75.856 tham số. Tên "1MB" của ULFG nói về kích thước file FP32, không phải lợi thế so với
YuNet sau khi lượng tử hoá.

**5. Có sẵn bản ONNX và INT8 tham chiếu.**

`opencv_zoo` phát hành cả hai. Khi lượng tử hoá theo §3.7, có bản tham chiếu để
đối chiếu là khác biệt giữa "biết mình sai ở đâu" và "mò".

**6. License không phải yếu tố phân biệt.** Cả hai đều MIT.

## Hệ quả

**Chấp nhận được**

- Align được mặt bằng landmark của chính detector đang chạy, không lệch train/serve.
- Distill đủ hai nhánh box và landmark từ teacher.
- Có bản INT8 tham chiếu để soi khi quantize.

**Phải trả giá**

- Decode anchor và NMS của YuNet phải viết lại bằng C ở `ai_engine/src/detection/`, khớp
  1:1 với `ml/src/facepipe/tasks/detection/postproc/`. Ràng buộc này được chốt bằng vector
  vàng ở `contracts/golden/detection/{decode,nms}/` và `firmware/test_apps/parity`.
- Landmark head thêm chi phí tính toán so với model chỉ ra box.
- 🔬 Latency và arena thật trên ESP32-S3 chưa biết. Con số ước lượng chỉ được thay bằng số
  đo ở E8.

## Phương án đã cân nhắc và loại

| Phương án | Vì sao loại |
|---|---|
| **ULFG** | Không có landmark (lý do 1). Accuracy Hard thấp hơn nhiều. Tự thêm landmark head là làm lại việc đã có. |
| **RetinaFace-MobileNet0.25** | Có 5 landmark, nhưng nặng hơn YuNet đáng kể mà AP Hard không hơn tương xứng. |
| **BlazeFace** | Nhanh, có 6 landmark, nhưng thiết kế cho ảnh selfie cự ly gần — dải khoảng cách hẹp hơn tình huống kiosk. |
| **YOLO-face bản nano** | Kéo theo license AGPL-3.0 của Ultralytics vào firmware. Teacher chạy ở máy train nên không vướng; student nằm trong sản phẩm thì vướng. |

## Điều kiện xét lại

Mở lại ADR này nếu E8 đo trên board cho thấy YuNet không đạt ngân sách latency hoặc arena
ở §3.8, hoặc nếu AP Hard trên tập ảnh OV5640 tự thu thấp hơn hẳn số trên WIDER FACE.

## Nguồn

- YuNet — train: <https://github.com/ShiqiYu/libfacedetection.train> · ONNX + INT8 tham chiếu: <https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet>
- ULFG — <https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB>
- WIDER FACE — <http://shuoyang1213.me/WIDERFACE/>
