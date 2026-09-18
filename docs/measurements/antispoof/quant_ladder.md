# Thang lượng tử hoá — nhánh anti-spoof

Bảng đối chứng B của KẾ HOẠCH §3.8. Mỗi dòng đủ 5 cột; cột nào chưa đo được thì
để 🔬 chứ không điền số suy ra.

## 1. Model đem lượng tử hoá

Ba checkpoint, cùng kiến trúc `minifasnet_v2_se`, hai crop 80×80:

| Nhãn | Run | Ghi chú |
|---|---|---|
| `0140` | `20260902-0140_0212c98_6706a4` | |
| `1740` | `20260905-1740_865b5d0_64c387` | bản vá cổng crop-scale |
| `0944` | `20260906-0944_8535ca1_80fe5f` | mới nhất, epoch 45, val EER 0,1452 |

**Chưa chốt arm §3.7.** Cả ba run hiện có đều là A0 (`teacher.enabled: false`);
arm A3 chưa chạy nên `ablation_teacher.md` chưa tồn tại. §3.8 nói thang chạy
trên arm thắng ở §3.7, nên bảng dưới là **số của một checkpoint cụ thể**, dùng
để dựng và kiểm đường export — không được đọc thành "đã chốt cấu hình quantize"
(§4.2).

## 2. Bảng chính

Đo trên `test_split`, lấy mẫu **trải đều** 4.032/39.072 mẫu (bước nhảy theo lô,
vì shard không xáo nên cắt đầu là lệch lớp).

| Model | Q | EER | AUC | Δ EER so với Q0 | Kích thước | 🔬 head arena | 🔬 latency |
|---|---|---|---|---|---|---|---|
| `0140` | Q0 FP32 | 0,1295 | 0,9484 | — | 2.114,4 KB | 🔬 | 🔬 |
| `0140` | **Q1** | **0,1255** | 0,9438 | **−3,09%** | **877,7 KB** | 🔬 | 🔬 |
| **`1740`** | Q0 FP32 | **0,1121** | **0,9643** | — | 2.114,4 KB | 🔬 | 🔬 |
| **`1740`** | **Q1** | **0,1079** | **0,9629** | **−3,75%** | **877,7 KB** | 🔬 | 🔬 |
| `0944` | Q0 FP32 | 0,1327 | 0,9527 | — | 2.114,4 KB | 🔬 | 🔬 |
| `0944` | PTQ min-max | 0,1341 | 0,9518 | +1,06% | 877,7 KB | 🔬 | 🔬 |
| `0944` | **Q1** | 0,1318 | 0,9520 | −0,68% | 877,7 KB | 🔬 | 🔬 |

Dòng `PTQ min-max` chỉ chạy cho `0944`, để tách công của CLE và bias correction
khỏi phần lượng tử hoá thuần.

Hai cột 🔬 cần TFLM chạy trên board, tức E8-T7 và E8-T8, mà chuỗi phụ thuộc là
E7-T10 → E8-T1 → E8-T2 → E8-T5. E7-T10 và E8-T2 đã xong: `minifasnet_int8.tflite`
của `1740` đang nằm ở partition `models_0`, board đọc được header và trả đúng
con trỏ khối `.tflite`. Mắt xích còn thiếu là `ai_engine` (E8-T1), chưa có file
nguồn nào.

## 3. Đọc bảng

**Lượng tử hoá không làm mất accuracy đo được.** Q1 nhỏ hơn Q0 **2,41 lần** mà
EER của **cả ba** model đều tốt hơn Q0. Ba kết quả độc lập cùng chiều nên đây
không còn là nhiễu. Ngưỡng accuracy của §3.8 là "sụt < 1% so với Q0" — Q1 vượt
thoải mái, nên theo quy tắc *"Q1 đạt thì dừng, không chạy Q2 cho đẹp bảng"*,
**Q2 (QAT + LSQ) chưa cần chạy**. Hai ngưỡng còn lại (arena, latency) vẫn treo
cho tới khi có số trên board.

**`1740` là model tốt nhất, không phải `0944` train sau.** Cùng tập test, cùng
giao thức: `1740` EER 0,1079 so với 0,1318 — tốt hơn 18%. Cùng chiều với 13
snapshot camera ở §16 của `measurements.md`, nơi `0944` cho mặt thật chính diện
điểm 0,036 còn `1740` cho 0,728. Lần train ngày 06 vì thế **đi lùi**, dù val EER
của nó nhìn khá — đúng cái bẫy §14.2 đã ghi: val không dự đoán miền triển khai.

**CLE và bias correction có công đo được**: chúng kéo EER từ 0,1341 của PTQ trần
xuống 0,1318, cải thiện 1,7% tương đối. Cân bằng chéo lớp chạm 46 cặp conv, cặp
lệch nhất có tỉ lệ scale giữa các kênh **13,04×** — đúng loại mất cân bằng mà
per-channel một mình chưa xử lý hết ở depthwise.

**Giới hạn phải nhớ khi trích số này**: n = 4.032, nên chênh lệch cỡ 0,002 EER
giữa ba dòng nằm trong nhiễu. Kết luận đứng vững là "không mất gì", không phải
"Q1 giỏi hơn FP32".

## 4. Hiệu chỉnh — lệch so với §1

§1 định nghĩa tập hiệu chỉnh PTQ là **300 ảnh OV5640 tự thu** (`calib/`). Tập đó
**chưa tồn tại**: `data/raw/device/ov5640/images` rỗng. Bảng trên hiệu chỉnh
bằng 300 crop lấy từ `val_split` của CelebA-Spoof.

Hệ quả: dải lượng tử hoá đo trên miền train chứ không phải miền triển khai. Khi
có tập OV5640 thật thì phải chạy lại toàn bộ bảng — đây là lý do §1 tách `calib/`
riêng ngay từ đầu.

**Percentile 99,9% chưa cài.** §3.8 định nghĩa Q1 gồm cả nó, nhưng
`TFLiteConverter` chỉ lấy dải theo min-max của tập đại diện và không mở API cho
percentile; muốn có phải sửa thẳng tham số lượng tử hoá trong flatbuffer. Dòng
Q1 ở trên vì thế là **per-channel + CLE + bias correction, hiệu chỉnh min-max**.
Bảng quét 4 thuật toán hiệu chỉnh (`calib_sweep.md`) chưa chạy.

## 5. Op và ESP-NN

`artifacts/antispoof/reports/op_check.txt`, sinh bằng `export/tflite_op_check.py`.

| | Op | Số lần | Tỉ lệ |
|---|---|---|---|
| ESP-NN tăng tốc | `CONV_2D` 84 · `MUL` 40 · `DEPTHWISE_CONV_2D` 24 · `ADD` 14 · `FULLY_CONNECTED` 3 | 165 | 68,8% |
| TFLM C tham chiếu | **`PRELU` 46** · `MEAN` 20 · `PAD` 8 · `CONCATENATION` 1 | 75 | **31,3%** |

**`PRELU` ×46 là vi phạm kiến trúc, không phải vấn đề lượng tử hoá.** Pipeline §3
bước [1] quy định student dùng **ReLU6** kèm lý do ESP-NN; nhánh detection tuân
thủ, còn `tasks/antispoof/student/blocks.py:32` dùng `nn.PReLU(out_channels)`
theo bài báo MiniFASNet gốc. PReLU có tham số học được cho từng kênh nên không
gập vào conv được — sửa cho đúng plan là đổi khối rồi **train lại**.

Một đánh đổi phải cân trước khi đổi: **CLE chỉ đúng với activation thuần nhất
dương** (`f(sx) = s·f(x)`). PReLU thoả, **ReLU6 không** vì trần 6 đứng yên khi
scale đổi. Đổi sang ReLU6 để lấy kernel ESP-NN thì **mất luôn CLE** — mà CLE là
thứ vừa đo được là có công. Nên quyết định này cần latency thật của E8-T8 chứ
không suy đoán: 46 phép elementwise trên C tham chiếu chưa chắc đắt bằng cái mất
đi khi bỏ CLE.

---

## 4. Arm một backbone `0107` — thang chạy lại 12/09, CLE tắt

Run `20260912-0107_fd87e15_5728fa`, `best.pth` epoch 79, một backbone trên crop mặt 81×81.
Cùng giao thức mục 2: `test_split`, 4.032/39.072 mẫu trải đều. Ba cột cuối **đo thật trên
board**, không còn 🔬: `ai_engine/test_apps/antispoof` và `test_apps/bench_ai`, 240 MHz,
`-O2`, PSRAM octal 80 MHz, cả hai arena ở PSRAM.

| Q | EER | AUC | Δ EER so với Q0 | Kích thước | head arena | latency |
|---|---|---|---|---|---|---|
| **Q0** FP32 | 0,0895 | 0,9727 | — | 1.046,6 KB | — | — |
| **Q1** fold + bias, **không CLE** | **0,0908** | **0,9727** | **+1,45%** | **424,9 KB** | **210 KB** | **234,0 ms** |

**Q1 đạt cả ba ngưỡng accuracy và arena của §3.7**: AUC bằng đúng Q0, EER lệch 0,0013 tuyệt
đối (0,13 điểm phần trăm, dưới ngưỡng 1%), arena 422.764 B nằm trong `arena_big` 466 KB.
**Ngưỡng latency vẫn trượt**: 234,0 ms so với ngân sách 60 ms của §6.4. Nhưng bản hai
backbone là 469,7 ms, nên một backbone đã cắt đúng một nửa.

## 5. Vì sao CLE bị tắt — bảng tách, 12/09

Chạy lần đầu với Q1 đúng định nghĩa cũ (có CLE) cho kết quả tệ hẳn. Tách từng thành phần,
cùng run, cùng split, cùng 4.032 mẫu:

| Cấu hình | EER | AUC | Δ EER so với Q0 |
|---|---|---|---|
| Q0 FP32 | 0,0895 | 0,9727 | — |
| PTQ trơ (không CLE, không bias) | **0,0860** | 0,9722 | **−3,91%** |
| Chỉ bias correction | 0,0908 | **0,9727** | +1,45% |
| Chỉ CLE | 0,1368 | 0,9385 | **+52,8%** |
| CLE + bias | 0,1370 | 0,9383 | **+53,1%** |
| CLE + bias, 1.000 mẫu calib | 0,1404 | 0,9364 | +56,9% |

Một mình CLE gây ra toàn bộ thiệt hại; bias correction vô hại; tăng mẫu calib không cứu
được vì calib không phải nguyên nhân. Cơ chế ở `measurements.md` §32.

## 6. Hai run nhập từ minivision — thang chạy 16/09, CLE tắt

Kiến trúc `minifasnet_v2`, 80×80, một view 2,7×, ba lớp. Trọng số không train trên pool
(KẾ HOẠCH §3), nên val pool ở đây đo **mức bất đồng giữa pool và model**, không đo chất lượng
model; chất lượng đọc ở `measurements.md` §41 trên khung của chính OV5640.

| Nhãn | Run | Kích hoạt | `op_check` |
|---|---|---|---|
| `0728` | `20260916-0728_f20a94a_ec4799` | PReLU gốc | **chặn**: PRELU ×33 ngoài resolver |
| `0729` | `20260916-0729_f20a94a_cc06da` | ReLU | qua: PAD ×4 tham chiếu, còn lại esp-nn |
| **`0854`** | `20260916-0854_bcf7a40_e97321` | ReLU, `stem: split_prelu` | qua: 70 op, PAD ×4 tham chiếu, **không PRELU** |

| Model | Q | Pool EER | Pool AUC | Board: thật giữ / giả chặn (§41) | Kích thước | head arena | latency spoof |
|---|---|---|---|---|---|---|---|
| `0728` | Q0 FP32 | — | — | 62/62 · 25/25 | 1.694 KB | — | — |
| `0728` | Q1 | — | — | **62/62 · 25/25** | 586 KB | 🔬 | 🔬 (§41.7) |
| `0729` | Q0 FP32 | 0,3179 | 0,7436 | 59/62 · 25/25 | 1.694 KB | — | — |
| **`0729`** | **Q1** | 0,3219 | 0,7368 | **59/62 · 25/25** | **586 KB** | **670 KB một mình, 743.468 B chung với recog** | **490,3 ms** |
| `0854` | Q0 FP32 | 0,3169 | 0,7504 | 62/62 · 25/25 | 1.694 KB | — | — |
| **`0854`** | **Q1** | 0,3126 | 0,7590 | **62/62 · 25/25** | **586 KB** | **671 KB một mình, 744.428 B chung với recog** | **535,3 ms** |

Pool của `0728` không chấm vì thang dừng ở `op_check` trước bước chấm; số board của nó chấm bằng
đường của §41.1. Q1 so với Q0 trên board: PReLU giữ nguyên 0/62, ReLU giữ nguyên 3/62 — lượng
tử không đổi thứ tự ở cả hai, chỉ thu khe (0,473 → 0,322 và 0,146 → 0,127).

Cả hai run đều là **A0 với trọng số nhập**, không phải arm §3.7; bảng này dựng đường export cho
chúng và ghi số, không chốt cấu hình lượng tử.

## 7. Student width 32 distill từ trọng số nhập — 16/09, CLE tắt

`minifasnet_v2_se` width 32, view wide 2,7×, 81×81, ba lớp, distill từ `20260916-0728` (ADR-0003).
Val pool ở đây **không phải thước chọn**: nhãn pool không được đọc lúc train, và §42.4 cho thấy nó
xếp hạng ngược với board. Thước là 87 khung OV5640.

| Nhãn | Run | Ghi chú |
|---|---|---|
| `1109` | `20260916-1109_00e506a_73d457` | 40 epoch, đã căn bias +4,5184 — **bản chốt** |
| `1251` | `20260916-1251_00e506a_1bc7e5` | tiếp 12 epoch với nguồn ảnh in, loại ở §42.7 |

| Model | Q | Pool EER | Pool AUC | Board: thật giữ / giả chặn | Khe board | Kích thước | head arena | latency spoof |
|---|---|---|---|---|---|---|---|---|
| `1109` | Q0 FP32 | 0,3242 | 0,7682 | 62/62 · 25/25 | 49 nấc | 1.046 KB | — | — |
| **`1109`** | **Q1** | 0,3281 | 0,7639 | **62/62 · 25/25** | **49 nấc** | **425 KB** | **210 KB một mình, 422.764 B chung với recog** | **234,1 ms** |
| `1251` | Q1 | 0,3088 | 0,7787 | 62/62 · 25/25 | 40 nấc | 425 KB | 210 KB | 234 ms 🔬 |

`op_check`: 93 op, **toàn bộ esp-nn, không PAD** — sạch hơn bản nhập vốn còn PAD ×4.

Q1 so với Q0 trên board: khe giữ nguyên 49 nấc, mặt thật thấp nhất 0,667 → 0,639, khung giả cao nhất
0,334 → 0,328. Lượng tử không ăn biên.

## 8. Hai run nhập có khối SE: V1SE của minivision và facenox — thang chạy 18/09, CLE tắt

Cùng `minifasnet_v2` với `squeeze_excite: true`; V1SE dùng bảng kênh `keep: 1.8M`, facenox `1.8M_`
với `input_size 128`, hai lớp. Cả hai qua `stem: split_prelu`, 32 lớp ReLU. Val pool không chấm
(`SCORE=0`) vì thang dừng ở `op_check` như thiết kế; chất lượng đọc ở `measurements.md` §43.

| Nhãn | Run | Trọng số gốc | `op_check` |
|---|---|---|---|
| `5d7b35` | `20260918-0118_c1d09c8_5d7b35` | V1SE PReLU nguyên, parity 9,5e-7 với module upstream | chặn: PRELU ×33 |
| **`0118`** | `20260918-0118_c1d09c8_0ad0a8` | V1SE stem tách, parity 1,4e-6 | **chặn: `LOGISTIC` ×3, `MEAN` ×3 ngoài resolver**; PAD ×4 tham chiếu; còn lại esp-nn |
| `bc7535` | `20260918-0100_2613aa2_bc7535` | facenox PReLU nguyên, parity 2,4e-6 với ONNX của họ | chặn: PRELU ×33 |
| **`0100`** | `20260918-0100_2613aa2_55e1a6` | facenox stem tách, parity 7e-7 | chặn: `LOGISTIC` ×3, `MEAN` ×3; PAD ×4 |

| Model | Q | Board 87 khung (§43.4) | Kích thước | head arena | latency spoof |
|---|---|---|---|---|---|
| `0118` | Q0 FP32 | 62/62 · 25/25, khe +0,595 | 1.694 KB | — | — |
| **`0118`** | **Q1** | **62/62 · 25/25, khe +0,559** | **602,5 KB** | **675 KB một mình, 748.524 B chung với recog** | **581,0 ms** rảnh · 677,4 ms tải |
| `0100` | Q0 FP32 | 62/62 · 25/25, khe +0,628 ở 1,5× | 1.855 KB | — | — |
| `0100` | Q1 | 62/62 · 25/25, khe +0,732 ở 1,5× | 644,1 KB | **1.589 KB một mình, 1.684.700 B chung** — vượt cap `CONFIG_AI_ARENA_BIG_KB` 1536 | 1.452,4 ms rảnh · 1.691,1 ms tải |
| **`1050`** `20260918-1050_aa7e463_e66877` | **Q1** | **62/62 · 25/25, đường board: thật min 0,121 (mặt nghiêng 90°), thật thứ ba 0,518, giả max 0,003, 84 nấc** (§43.6–43.7) | **602,6 KB** | **675 KB một mình, 748.524 B chung** | **581,0 ms** (cùng graph `0118`) |

`1050` là `0118` nhập lại với `prob_bias: true`; hằng số căn +5,0051 được thử rồi **rút lại** vì bộ căn
chỉ có màn hình và nó đẩy tờ tiền lên trên 0,5 (§43.7), nên bản trên `models.lock.json` (ADR-0004)
mang hằng số 0, sha `71ec3d307931…`. `op_check` qua sau khi resolver nhánh đăng ký `LOGISTIC` và `MEAN`.

Hai số board đo bằng `bench_ai` với resolver **đăng ký tạm** `LOGISTIC` và `MEAN` (không commit, như
§9.2 của `latency.md` đã làm với PRELU); facenox còn phải nới cap arena trong `sdkconfig` của riêng
app bench lên 3072 KB mới nạp được. Q1 so với Q0 trên 87 khung: V1SE thu khe 0,595 → 0,559 (không đổi
thứ tự), facenox **nới** 0,628 → 0,732 nhưng mặt thật thấp nhất tụt 0,295 → 0,259; trên NUAA thì
INT8 của facenox mất mặt thật rõ (đậu 0,701 → 0,671, §43.5), V1SE gần như không (0,906 → 0,895).
