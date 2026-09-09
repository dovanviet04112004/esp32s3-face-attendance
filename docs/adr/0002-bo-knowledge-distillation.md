# ADR-0002 — Bỏ knowledge distillation, train trực tiếp cả ba nhánh

- **Trạng thái**: Chấp nhận
- **Ngày**: 2026-09-09
- **Liên quan**: KẾ HOẠCH §1.1 (bảng model), §3 lớp 2 (huấn luyện), §4.4 (cây `ml/`)

---

## Bối cảnh

Thiết kế ban đầu có **sáu model**: mỗi nhánh một teacher lớn và một student nhỏ, student
học từ teacher qua knowledge distillation. Teacher là YOLO26m-pose cho detect, CDCN++ cho
anti-spoof, ResNet50 @ WebFace600K cho recognition.

§3.7 cũ đặt ra bảng đối chứng hai arm — A0 không teacher, A3 toàn bộ KD — và quy định
không được chốt nhánh nào trước khi có đủ hai dòng.

## Thứ đã xảy ra

**Mọi run đã train đều là A0.** Kiểm trên toàn bộ thư mục run của cả ba nhánh: mỗi
`config.resolved.yaml` đều có `teacher.enabled: false`, và mỗi log đều ghi `arm=baseline`.
Không có một run A3 nào tồn tại.

Nghĩa là toàn bộ hạ tầng KD — `core/distiller.py`, `core/hooks.py`, ba thư mục
`tasks/*/teacher/`, bảy hàm loss `kd_*.py`, năm file config teacher và KD, hai script
train teacher — **chưa bao giờ chạy trong một lần train nào cho ra kết quả đang dùng**.

Hai nhánh đã có kết quả và cả hai đạt ngưỡng mà không cần teacher:

| Nhánh | Kết quả A0 | Ngưỡng |
|---|---|---|
| Recognition (MobileFaceNet, ReLU 113, width 64) | LFW 0,9930 · CFP-FP 0,9484 · AgeDB 0,9367 | LFW ≥ 0,990 |
| Anti-spoof (MiniFASNetV2-SE) | ACER 0,1184 trên 111 khung camera thật, `live_kho` 12/12, APCER 0,0000 @0,90 | ACER < 0,05 — **chưa đạt** |

Anti-spoof chưa đạt, nhưng nguyên nhân đã truy được và **không phải thiếu teacher**: mirror
CelebA-Spoof có `train` và `valid` là cùng một mẻ nén JPEG, nên model học vết nén thay vì
kết cấu (`docs/measurements/antispoof/measurements.md` §1). Teacher train trên đúng mẻ đó
mang đúng thiên lệch đó — chấm lại CDCN++ trên mẻ `test` cho ACER **0,2087** và APCER
**0,4028**, tệ hơn student. Một teacher yếu hơn student thì không có gì để distill.

## Quyết định

**Bỏ knowledge distillation khỏi kiến trúc.** Ba nhánh train từ khởi tạo ngẫu nhiên trên
nhãn thật, mỗi nhánh một task loss. Xoá toàn bộ code, config và script của KD; bảng model
§1.1 còn ba dòng; §3.7 cũ (bảng đối chứng A) không còn lý do tồn tại.

Weight teacher **xoá hết**, kể cả `ml/artifacts/*/teacher/`: 223 MB không code nào đọc
nữa. Hai trong ba tải lại được từ upstream (`yolo26m-pose.pt` của Ultralytics,
`w600k_r50.pth` của insightface); `cdcnpp_best.pth` là 6,5 giờ GPU tự train và mất hẳn.
Số đo của nó vẫn còn ở `docs/measurements/antispoof/measurements.md` §2, nên phần kết luận
"teacher tệ hơn student trên mẻ test" vẫn tra lại được, chỉ không chạy lại được.

## Cái giá

Bảng này **không** trả lời được *KD có giúp được nhánh nào không*. Câu trả lời đó cần một
run A3 mỗi nhánh, và mỗi run là hàng chục giờ GPU trên một máy dùng chung — trong đó
teacher phải chạy thêm một lần forward mỗi bước.

Với anti-spoof, đường đi tiếp là **dữ liệu**: thu tập tự thu bằng chính OV5640 (E3-T8), vì
đó là chỗ khoảng cách đo được nằm. Với recognition, A0 đã đạt ngưỡng nên không còn câu hỏi.

Nếu về sau có thời gian và muốn bảng đối chứng đầy đủ thì phục hồi được từ git: quyết định
này xoá code chứ không xoá lịch sử.

## Hệ quả kéo theo

- `tasks/<nhánh>/student/` đổi tên thành `model/` — không còn teacher thì không còn đối nghĩa.
- `tasks/<nhánh>/train_kd.py` đổi tên thành `train.py`.
- `scripts/2x_kd_*.sh` đổi tên thành `scripts/2x_train_*.sh`; `scripts/1x_train_teacher_*.sh` xoá.
- Ràng buộc "teacher detect phải có landmark mới distill được landmark head" ở §1.1 mất hiệu lực; YuNet vẫn phải ra 5 landmark, nhưng vì recognition cần align chứ không vì KD.
- Phần đích depth 32×32 của CDCN++ ở §3 lớp 2 xoá khỏi kế hoạch. Số đo của nó vẫn ở `docs/measurements/antispoof/measurements.md` §7.
