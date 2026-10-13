# ADR-0006 — Hàng lượng tử hoá ESP-DL của ba nhánh, chọn bằng thang bốn bậc trên đồ thị cuối

- **Trạng thái**: Chấp nhận. Lock ở 8c2d9b7f (detect), abd62cfb (anti-spoof), d47e3605 (recog).
- **Ngày**: 2026-10-14
- **Liên quan**: ADR-0005 (ESP-DL là runtime deploy); KẾ HOẠCH §3.7; E9-T35, E9-T36, E9-T38, E9-T40..T50;
  `docs/measurements/{detection,antispoof,recognition}/quant_ladder.md`; `docs/measurements/latency.md` §14

---

## Bối cảnh

Bộ ESP-DL deploy từ 24/09 là Q1 của từng nhánh: detect AP ≥ 38 px 0,9497; anti-spoof giữ 61/62 mặt thật trên
87 khung kiosk; recog dưới cửa, TAR@1e-3 trên CFP-FP 0,756 so với 0,830 của Q0.

Đợt tối ưu tốc độ E9-T38..T50 đưa một khuôn mặt từ 444,8 ms xuống 251,6 ms ở các nấc làm tròn cuối, và xuống
333,8 ms nếu chỉ dùng bản vá giữ nguyên số nguyên (`latency.md` §14.8–14.18). Mọi bản vá đều khớp chip từng bit.
Riêng các nấc làm tròn (`clip_as_relu`, `fused_prelu`, `prelu_on_input_grid`) đổi số nguyên, nên phải để thang chấm.
Chủ repo yêu cầu chạy thang một lần trên đồ thị cuối rồi mới deploy.

Thang đi trọn bốn bậc cho cả ba nhánh: bốn cách hiệu chuẩn, int16 cho các lớp nhạy nhất, QAT chưng cất từ mô hình
float, rồi các hàng biến thể làm tròn. Mỗi hàng ứng viên được dò trên kiosk để lấy giờ và kiểm khớp từng bit.

## Quyết định

| Nhánh | Hàng | Thước chính, Q0 → hàng | Cửa | Giờ trên chip |
|---|---|---|---|---:|
| detect | `mse+clip_as_relu` | AP ≥ 38 px 0,9414 → **0,9544** | đạt | **31,58 ms** |
| anti-spoof | `int16_top1` | AUC CelebA-Spoof 0,8208 → **0,8242**; 59/62 thật, 25/25 giả | đạt | **72,63 ms** |
| recog | `qat` | TAR@1e-3 CFP-FP 0,830 → **0,799** | **không đạt** | **245,09 ms** |

Một khuôn mặt qua cả ba nhánh: **349,3 ms**, trong ngân sách 360 ms (từ 444,8 ms lúc bắt đầu tối ưu).

## Vì sao từng hàng

**Detect.** Mọi hàng đạt cửa. `mse` cao nhất ở bậc 2. Biến thể `+clip_as_relu` đổi cả 18 ReLU6 thành ReLU bão
hoà ở đỉnh lưới int8, cho cùng AP tới chữ số thứ năm và nhanh hơn 0,23 ms. Lớp int16 và QAT không lợi gì.

**Anti-spoof.** `int16_top1` là hàng đạt cửa có AUC cao nhất. Các biến thể gộp PReLU, tức các hàng chạy 39,6 ms,
giữ nguyên AUC nhưng chỉ giữ 49–50/62 mặt thật ở ngưỡng `live_min` 500‰: làm tròn xuống ở nhánh âm kéo điểm
"sống" của mặt thật xuống dưới ngưỡng. Hàng int8 `kl` kém 0,002 AUC, quá một bước 0,001 của thước, nên luật
không lấy dù ước nhanh hơn chừng 16 ms. Chủ repo giữ đúng lựa chọn của luật.

**Recog.** Không hàng nào đạt cửa ≥ 0,822. Không cách hiệu chuẩn nào giữ được CFP-FP (cao nhất `kl` 0,775), và một
tới tám lớp int16 không kéo nó lên. QAT 2.000 bước nâng `kl` lên 0,799. `qat+fused_prelu` nhanh hơn 26 ms nhưng
CFP-FP còn 0,783. Luật của §3.7 không chọn được hàng nào, nên chủ repo chọn `qat`: chất lượng cao nhất, và hơn bộ
đang deploy 0,043 điểm.

## Đánh đổi

- **Phần nhanh của các nấc làm tròn không thành hiện thực ở anti-spoof và recog.** Bảng §14 đo được 251,6 ms một
  mặt; bộ chọn chạy 349,3 ms vì hai nhánh ấy không qua được cửa chất lượng với PReLU gộp.
- **Lớp int16 của anti-spoof tốn ~16 ms** cho 0,002 AUC trên CelebA-Spoof, một mức nằm trong cỡ nhiễu của thước.
- **Recog vẫn dưới cửa.** Ở CFP-FP (mặt nghiêng), TAR@1e-3 kém Q0 0,031; AgeDB-30 kém 0,046; LFW gần như không đổi.
  Kiosk sẽ từ chối oan nhiều hơn với mặt nghiêng.
- **Recog đổi số nguyên, nên mọi khuôn mặt phải đăng ký lại** sau khi nạp bộ mới.
- Thang lộ ra hai lỗi của công cụ, đều đã sửa. `best_row` lấy cả hàng trượt cửa làm nền cho bậc sau (14a3fcdc); bậc
  3 của anti-spoof vì thế dựng trên `percentile`, và các hàng ấy vẫn đạt cửa. `quant-deploy` dừng vì đường dẫn tính
  từ sai thư mục (9cfe647d).
