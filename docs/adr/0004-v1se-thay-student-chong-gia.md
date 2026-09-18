# ADR-0004 — MiniFASNetV1SE nhập thay student width 32 trên nhánh chống giả

- **Trạng thái**: Chấp nhận
- **Ngày**: 2026-09-18
- **Liên quan**: ADR-0003 (giữ, student thành phương án nhẹ); KẾ HOẠCH §1.1, §3 lớp 1 và lớp 2, §4.5;
  `docs/measurements/antispoof/measurements.md` §43; `quant_ladder.md` §8; `latency.md` §11

---

## Bối cảnh

ADR-0003 đưa student width 32 distill lên `models.lock.json` vì nó giữ 62/62 mặt thật và chặn
25/25 khung giả của board với 234 ms. Ngày 17/09 thử trực tiếp trên board: student **cho qua mọi
đòn giấy** — tờ tiền, ảnh in, thẻ bọc nhựa — trong khi bản nhập V2 `0854` chặn 15/15 lượt giấy.
Bộ 25 khung giả dùng để nghiệm thu toàn là đòn màn hình (`spoof1309` là ảnh thẻ trên điện thoại,
`p2gia` là điện thoại thứ hai), nên "25/25" chưa từng nói gì về giấy. Nguyên nhân của student đã
đo ở §42.5: dấu hiệu giấy nằm dưới 3 px, ngoài trần năng lực của width 32; nới width lên 48 đã
nặng hơn teacher nên không có đường student nào rẻ hơn bản nhập mà chặn được giấy.

Ngày 18/09 quét thêm 5 model công khai ngoài minivision và đưa **ba ứng viên** qua cùng một đường
tối ưu — PReLU nguyên → stem tách ReLU → INT8 — rồi đo cùng thước: 87 khung board, các tập lớn,
`bench_ai` (§43.4–43.5, `latency.md` §11).

## Quyết định

Nhánh chống giả chạy **MiniFASNetV1SE của minivision** (`keep: 1.8M`, ba khối SE), nhập nguyên
trọng số qua `import_minifasnet.py`, `conv1` PReLU viết thành stem tách hai nhánh ReLU, 32 lớp còn
lại ReLU, INT8 Q1, **không căn bias** (hằng số 0: bộ căn hiện có chỉ có màn hình và hằng số nó sinh
ra đẩy tờ tiền qua ngưỡng, `measurements.md` §43.7), đọc crop ngữ cảnh 2,7× của firmware như cũ. Ba khối SE
giữ Sigmoid gốc: resolver nhánh đăng ký thêm `LOGISTIC` và `MEAN`, chạy kernel tham chiếu trên vector
đã gộp về 1×1. Student `20260916-1109` giữ nguyên trong repo làm phương án nhẹ, không xoá.

## Vì sao V1SE chứ không phải hai ứng viên kia

| INT8 stem tách, cùng thước | V2 `0854` | **V1SE `0118`** | facenox `0100` |
|---|---|---|---|
| 87 khung: thật giữ · giả chặn | 62/62 · 25/25 | 62/62 · 25/25 | 62/62 · 25/25 |
| khe p5 thật − p95 giả | +0,365 | **+0,559** | +0,732 ở crop 1,5× riêng |
| ảnh in cỡ vừa `attack_anh` chặn | 1/12 | **12/12** | 3/12 |
| SynthASpoof in · iPad · Samsung | 0,880 · 0,261 · 0,694 | **0,970 · 0,515 · 0,865** | 0,649 · 0,238 · 0,849 |
| mặt thật ở xa `live_xa` đậu | 13/20 | **19/20** | 12/20 |
| spoof trên board | 535 ms | **581 ms** | 1.452 ms |
| `arena_big` | 744 KB | 749 KB | **1,64 MB, vượt cap 1,5 MB** |

Điểm quyết định không phải bản PReLU gốc mà là **bản phải nạp lên board**. Đổi PReLU sang ReLU làm
V2 mất đúng thứ cần: ảnh in cỡ vừa 12/12 → 0/12, SynthASpoof in 0,953 → 0,889. V1SE đi qua cùng phép
đổi mà mọi cột giả **tăng**, chỉ trượt điểm vận hành, thứ bước căn bias dịch lại được. facenox có khe
rộng nhất ở float nhưng mất thế mạnh giấy sau đổi ReLU, cần crop 1,5× khác firmware, 108,9 MMAC và
arena vượt ngân sách §6.4.

## Đánh đổi

- **+347 ms mỗi lần chấm** so với student, +46 ms so với V2; một lượt ba nhánh 1.272 ms thay 925.
  Ngân sách 360 ms của §6.4 vốn đã trượt từ recognition, nay trượt thêm.
- Hai op tham chiếu trong nhánh (`LOGISTIC` ×3, `MEAN` ×3) và `PAD` ×4 của map chẵn 80 px; đo tổng
  cộng trong 581 ms, không đo tách từng op vì build bench không bật profiler.
- `arena_big` 748.524 B thay 422.764 B, vẫn trong PSRAM và dưới cap 1,5 MB.
- Số tập lớn ở ngưỡng 0,5 chưa căn cho thấy V1SE đậu mặt thật thấp hơn V2 trên NUAA và SynthASpoof
  bonafide với AUC gần nguyên; sau căn bias điểm vận hành dịch lên. Trên 87 khung board thì không
  mất mặt nào ở mọi trạng thái.
- Đòn giấy chưa có khung OV5640 nào để đo bằng số; bằng chứng là thử trực tiếp (V2 chặn 15/15 lượt),
  và V1SE chưa thử trực tiếp. Thẻ bọc nhựa trong lọt cả V2, chưa model nào chống được.

## Hệ quả kéo theo

- KẾ HOẠCH §1.1 bảng model và bảng kích thước; §3 lớp 1 luật Sigmoid trong SE cho trọng số nhập;
  §3 lớp 2 đoạn model nhánh; §4.5 `ops.cpp` thành `MicroMutableOpResolver<10>`; §6.4 `arena_big`.
- `minifasnet_v2.py` nhận `keep` và `squeeze_excite`; `import_minifasnet.py` nhận `--source`.
- `contracts/models.lock.json` và `firmware/models/antispoof/meta.json` trỏ run V1SE stem tách đã
  căn bias, `arena_bytes` đo trên board.
- ADR-0003 không bị bác: distill vẫn là đường cho student nhẹ khi có teacher chặn được giấy.
