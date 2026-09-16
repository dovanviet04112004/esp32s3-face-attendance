# ADR-0003 — Distill nhánh chống giả từ trọng số nhập, mở lại một phần ADR-0002

- **Trạng thái**: Chấp nhận
- **Ngày**: 2026-09-16
- **Liên quan**: ADR-0002; KẾ HOẠCH §1.1 (bảng model), §3 lớp 2 (huấn luyện), §4.4 (cây `ml/`);
  `docs/measurements/antispoof/measurements.md` §41; `docs/thesis/nghien-cuu-chong-gia-mao-ov5640.md` §17

---

## Bối cảnh

ADR-0002 bỏ knowledge distillation vì lý do đo được: teacher CDCN++ train trên CelebA-Spoof
**tệ hơn student** trên mẻ test (ACER 0,2087 so với 0,1184), và "một teacher yếu hơn student
thì không có gì để distill". Quyết định ấy đúng với teacher ấy.

Ngày 16/09 tình thế đổi. Bảy lần train student trên pool đều hỏng cùng một kiểu trên OV5640
(§16 file nghiên cứu), trong khi trọng số MiniFASNetV2 của minivision, nhập nguyên và đọc crop
ngữ cảnh 2,7×, **giữ 62/62 mặt thật và chặn 25/25 khung giả** của chính camera này, INT8, qua đúng
đường cắt và lượng tử của firmware (§41.7). Quét 15 model công khai khác không tìm được model
nào tốt hơn (§41.9). Lần đầu nhánh có một teacher **tốt hơn mọi student từng train**.

Cái giá của teacher ấy là kiến trúc của họ: 40,7 MMAC so với 24,6 MMAC của `minifasnet_v2_se`
width 32, tức spoof **535 ms** trên board thay vì 234 ms (`latency.md` §9). Bộ kênh
103/231/308 không cắt được mà không train lại.

Nguyên nhân gốc vì sao student tự train hỏng cũng đã đo được: CelebA-Spoof dạy "ảnh studio =
thật, ảnh chụp lại trong phòng = giả", mọi model train trên nhãn CelebA — kể cả MobileNetV3
của OpenVINO và ViT — đều chặn oan mặt thật của OV5640 (§41.9). **Nhãn** là nguồn của vấn đề,
không phải ảnh, không phải kiến trúc.

## Quyết định

**Distill nhánh chống giả**: student `minifasnet_v2_se` width 32, một backbone đọc view ngữ cảnh
2,7× (`views: wide`), 81×81, ba lớp `[sống, phát lại, in]`; teacher là run nhập
`20260916-0728_f20a94a_ec4799` (PReLU gốc, float, chỉ chạy trên host). Loss là KL giữa hai phân
bố softmax ở nhiệt độ T (`losses/distill_loss.py`), **không dùng nhãn**: ảnh của pool và các
nguồn khác chỉ là đầu vào, teacher gán mục tiêu mềm. Vì không có nhãn nên confound của CelebA
không đi vào student, và pool càng rộng càng tốt.

Chọn checkpoint bằng **KL trên val** (không phải EER pool). Nghiệm thu bằng đúng thước của
nhánh: 87 khung OV5640 INT8 qua đường board (§41.1), các tập lớn của §41.8, latency `bench_ai`.
Bảng đối chứng bắt buộc có bốn dòng cùng thước: teacher (trần), bản nhập stem tách đang nạp
(`0854`), student distill, và student cũ train trên nhãn (`0107`).

Phạm vi: **chỉ nhánh chống giả**. Detect và recognition giữ nguyên ADR-0002 — hai nhánh ấy đã
đạt ngưỡng bằng A0 và không có teacher nào tốt hơn student.

## Đánh đổi

- Student học hàm của teacher trên miền ảnh nó được cho xem. Miền ấy (pool, LCC, SynthASpoof,
  `unique`) không phải OV5640; student có thể lệch teacher ở đúng miền cần dùng. Thước 87
  khung sẽ nói; nếu lệch, ảnh OV5640 không nhãn là thứ thêm vào — không cần nhãn nên rẻ.
- Teacher 3 lớp, student 3 lớp: mất một phép chiếu về hai lớp, nhưng giữ được thứ tự
  `LIVE = 0` mà firmware và `task_loss` đã dùng, và `score()` đọc số lớp từ tensor.
- Teacher đọc 80×80, student 81×81 (lẻ để không sinh PAD): view của loader thu về 80 cho
  teacher bằng bilinear ngay trong bước train. Sai lệch ấy nằm trong mục tiêu mềm, không nằm
  trong đầu vào student.
- Không phục hồi hạ tầng KD cũ (`core/distiller.py`, hook đặc trưng, bảy `kd_*.py`). Một loss
  logit là đủ cho bài toán ba lớp; distill đặc trưng chỉ cân nhắc khi logit không đủ, và khi
  đó phải qua ADR khác.

## Kết quả đo được, 16/09

Student `20260916-1109_00e506a_73d457` đạt mốc nghiệm thu và **lên `models.lock.json`**:

| | teacher | bản nhập `0854` | student |
|---|---|---|---|
| board 87 khung INT8 | 0/62 · 25/25 | 0/62 · 25/25 | **0/62 · 25/25** |
| khe logit (nấc INT8) | 57 | 53 | **49** |
| spoof trên board | — | 535,3 ms | **234,1 ms** |
| `arena_big` | — | 744.428 B | **422.764 B** |
| op ngoài esp-nn | — | PAD ×4 | **không có** |

Distill cho ra thứ mà bảy lần train trên nhãn không cho: một model width 32 **giữ trọn 62 mặt thật**
của OV5640. Bản train trên nhãn cùng kiến trúc mất 51/62 (`measurements.md` §41.9).

Hai điều phải đọc kèm. **Ảnh in là chỗ student thua**: teacher dìm NUAA xuống 0,000, student để 0,177;
phép lọc thông thấp cho thấy toàn bộ chênh lệch nằm dưới 3 px, tức trần năng lực của width 32
(§42.5). Đổi lại student **hơn ở đòn màn hình** (iPad 50,2% so với 23,8%). **Giai đoạn thêm nguồn ảnh
in bị loại**: nó mua 11 điểm chặn ảnh in nhưng trả 18% khe board (§42.7).

Một bước mới vào đường xuất: **căn bias**. Cộng hằng số vào logit lớp sống không đổi thứ tự nên 0/87
khung đổi phán quyết, chỉ dịch điểm vận hành khỏi đuôi phẳng của softmax, nơi `live_min` theo phần
nghìn chỉ còn 19 nấc; sau khi căn là 320 nấc và `live_min` gieo **500‰**. Hàm ở
`tasks/antispoof/eval.py`, bản chưa căn giữ ở `ckpt/best.uncalibrated.pth`.

## Hệ quả kéo theo

- KẾ HOẠCH §3 lớp 2: "ba model train trên nhãn thật, không teacher" thành "hai model"; nhánh
  chống giả có teacher là trọng số nhập.
- `tasks/antispoof/losses/distill_loss.py` và `configs/antispoof/minifasnet_distill.yaml` vào §4.
- `train.py` của nhánh nhận `loss.name` và `loss.teacher_run`; `SpoofBatch` mang thêm
  `teacher_logits`. `minifasnet_v2_se` nhận `views: wide`.
- Model đang nạp không đổi cho tới khi bảng đối chứng bốn dòng nói student đủ tốt.
