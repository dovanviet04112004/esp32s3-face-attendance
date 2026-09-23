# ADR-0005 — ESP-DL thay TFLite Micro làm runtime deploy, TFLM giữ làm đối chứng

- **Trạng thái**: Chấp nhận. Mặc định Kconfig chỉ chuyển sang ESP-DL khi E9-T31 đạt luật chấp nhận.
- **Ngày**: 2026-09-23
- **Liên quan**: ADR-0004 (V1SE giữ nguyên, đổi dạng hàm kích hoạt trên runtime mới); KẾ HOẠCH §1.1,
  §3 lớp 1, 2, 4, 5, §3.7, §3.8, §4.5.1, §4.5.6, §6.1, §6.2.2, §6.3, §6.4; E9-T28..T31;
  `docs/measurements/latency.md` §13

---

## Bối cảnh

Trên TFLite Micro + esp-nn 1.3.2, một lượt detect → spoof → recog mất **1.273 ms**, gấp 3,5 lần
ngân sách 360 ms. Soát mã nguồn cho thấy phần lớn chênh lệch không nằm ở chỗ đặt trọng số mà ở luật
lượng tử hoá: TFLite lượng tử hoá activation bất đối xứng, có zero point, nên esp-nn phải nhân ở
16 bit (`ee.vmulas.s16`); kênh lẻ rơi về kernel C; depthwise chép filter và input vào scratch mỗi
lượt. ESP-DL lượng tử hoá đối xứng, scale luỹ thừa 2, và nhân thẳng 8 bit (`EE.VSMULAS.S8`).

Ngày 23/09 dựng một app đo riêng, xuất năm model qua ESP-PPQ 1.3.11 và chạy trên đúng board kiosk,
cùng partition, cùng `-O2`, cùng tải preview giả lập, 50 lượt sau 3 lượt nóng
(`ml/artifacts/antispoof/espdl_trial/ket_qua_espdl_vs_tflm.md`):

| Median, ms, rảnh | TFLM + esp-nn | ESP-DL, trọng số PSRAM | ESP-DL, trọng số flash |
|---|---|---|---|
| detect YuNet `1616` | 231,6 | 61,9 | 63,8 |
| spoof V1SE tách `1050` | 579,6 | 81,8 | 96,9 |
| spoof V1SE PReLU `0118` | — | 85,0 | 99,9 |
| recog w32 `1750` | 459,2 | 84,0 | 95,7 |
| **Một lượt ba nhánh** (cùng model) | **1.270,9** | **227,7** | |
| Một lượt, có tải | 1.481,8 | 257,8 | |

Cả mười lần `model->test()` — đầu ra chip so với mô phỏng ESP-PPQ — đều PASS, tức khớp trong một
bước int8 ở mọi phần tử (sai số `1 + 1e-5` của `Model::test()`, không phải trùng từng bit). Độ chính xác
chấm trên host bằng đúng file chip chạy: detect ngang TFLite (AP ≥ 38 px 0,9497 so với 0,9387),
anti-spoof ngang trên miền thiết bị, recog **tốt hơn hẳn** file TFLite đang nạp (cùng model w32,
CFP-FP TAR@1e-3 0,566 so với 0,361).

## Quyết định

1. **ESP-DL 3.3.11 là runtime deploy của `ai_engine`**, chọn lúc biên dịch bằng
   `choice AI_RUNTIME`. **TFLite Micro + esp-nn ở lại nguyên vẹn và build được** — cả đường
   Python (`ptq_tflite.py`, `onnx_to_tf.py`, `tflite_op_check.py`) lẫn đường C (`TfliteModelBase`,
   arena, op resolver) — vì nó là một nửa của bảng đối chứng trong báo cáo.
2. **Một `ai_engine`, hai mặt tiền, một bộ hậu xử lý.** Letterbox, decode, NMS, crop, align,
   l2norm, softmax nhận `TensorView`; `contracts/golden/` kiểm cả hai runtime bằng cùng ca.
3. **Bộ model trên ESP-DL**: detect YuNet `1616`; anti-spoof MiniFASNetV1SE **PReLU nguyên**
   `0118` (không cần stem tách vì ESP-DL có kernel `PRelu`); recog **MobileFaceNet-ECA, trọng số
   nhập từ FRBench** `mobilefacenet_arcface_ms1m` (ArcFace, MS1M). TFLM giữ bộ `1616` / `1050` /
   `1750` đang deploy.
4. **Trọng số chép sang PSRAM** lúc nạp (`param_copy`), từng nhánh tắt được bằng
   `AI_WEIGHTS_PSRAM_*`; đo được nhanh hơn ở cả năm model thử.
5. **Partition**: slot OTA 2 MB → 2,75 MB, slot model 3 MB → 2,25 MB, offset của `assets`,
   `storage`, `coredump` giữ nguyên.

## Vì sao anti-spoof là bản PReLU nguyên, không phải bản tách

| ESP-DL INT8, cùng thước | tách `1050` | **PReLU `0118`** |
|---|---|---|
| 87 khung OV5640 ở 500‰: thật giữ · giả chặn | ≈ TFLite | **61/62 · 25/25**, thật thấp nhất 0,455 |
| SynthASpoof iPad · Samsung chặn | **0,635 · 0,915** | 0,505 · 0,876 |
| `unique` thật giữ | **0,997** | 0,956 |
| spoof trên board | 81,8 ms | 85,0 ms |

Bản PReLU nhận mặt thật của chính camera kiosk tốt hơn và nhận nhiều mặt thật hơn ở NUAA, LCC,
Axon; bản tách chặn đòn phát lại màn hình tốt hơn. Chủ repo chọn ưu tiên loại oan ít hơn trên
OV5640. `live_min` giữ 500‰: mọi khung giả của board dưới 0,005, mặt thật thấp nhất 0,455 — một
khung dưới ngưỡng.

## Vì sao recog là trọng số nhập

Cùng 1,20M tham số và embedding 512, bản FRBench train đủ lịch hơn mọi bản tự train sau INT8 trên
ESP-DL (KẾ HOẠCH §3 lớp 2): AgeDB TAR@1e-3 **0,841** so với 0,599 của w64 PReLU tự train 10 epoch,
LFW 0,994 so với 0,987. Đổi lại nó không train trên dữ liệu của dự án, và dự án ghi đúng như vậy
ở §1.1, §1.4, ở `run.notes` của run nhập và trong báo cáo.

Bản trial của nó **hỏng trên board**: 15 khối ECA gọi `expand_as`, ONNX ghi thành `Expand`, ESP-DL
3.3.11 không có module ấy nên nạp bỏ dở và `test()` FAIL. Port của dự án nhân broadcast — cùng hàm,
lệch 0,0 trên host — và `espdl_op_check.py` chặn loại lỗi này từ trên PC.

## Đánh đổi

- **+858 KB flash** cho thư viện, không tỉa được mà không sửa code Espressif; kéo theo đổi bảng
  partition, và bảng partition không đi qua OTA được.
- **RAM nội**: 13,6 KB DIRAM tĩnh (180.392 → 194.276 B, đo trên ảnh kiosk) cộng 25–41 KB mỗi model nếu để mặc định; `EspdlModel` đẩy object nhỏ
  sang PSRAM lúc dựng, và đáy RAM nội của kiosk là cổng phủ quyết của E9-T31.
- **PSRAM**: ~3,1 MB cho ba model thay ~940 KB của hai arena TFLM.
- Trọng số ở PSRAM thì một phép ghi lố heap **âm thầm sửa model** thay vì crash tại chỗ như ở flash.
- Recog mới đổi không gian embedding: **mọi khuôn mặt phải đăng ký lại**.
- `esp-ppq` 1.3.11 khai `onnx<1.18`, venv dùng 1.22 qua `override-dependencies`; bằng chứng
  duy nhất rằng tổ hợp này đúng là `test()` PASS trên board, trong một bước int8.
- Pipeline dự kiến ~450 ms 🔬: vẫn vượt ngân sách 360 ms, nhưng nhanh ~2,8× so với 1.273 ms.
