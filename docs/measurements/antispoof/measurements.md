# Nhánh anti-spoof — sổ đo

Mọi số đã đo được của nhánh chống giả mạo, kèm điều kiện đo. Số chưa chạy trên board
đánh dấu 🔬.

---

## 1. Mirror của CelebA-Spoof chia sẵn ba split, và `valid` không đo được gì

Nguồn là `Ar4ikov/celebA_spoof` — bản đóng gói lại thành parquet, **không phải layout gốc**.
`metas/` rỗng nên không có nhãn identity, cũng không có nhãn kiểu tấn công; cột `Class`
chỉ còn `live`/`spoof`.

Đo trên chính ảnh nguồn, 600 ảnh trải đều bốn parquet mỗi split:

| Split | Độ phân giải | Trung vị KB | < 150 KB | > 300 KB | live |
|---|---|---|---|---|---|
| train | 450×600 | 72,2 | **98,0%** | 1,3% | 34,4% |
| valid | 450×600 | 75,9 | **97,2%** | 1,7% | 34,6% |
| **test** | 480×600 | **415,6** | 4,5% | **86,8%** | 27,8% |

`train` và `valid` trùng nhau trên cả ba chiều — cùng độ phân giải, cùng mức nén, cùng tỉ
lệ lớp. Chúng là **một mẻ**. `test` là mẻ khác: cùng số điểm ảnh nhưng nặng gấp 6 lần, tức
nén nhẹ hơn hẳn.

Hệ quả: **`valid` đo độ khớp trong phân bố, không đo khả năng tổng quát hoá.** Một model
tự do đọc vết nén JPEG sẽ đọc vết nén — ảnh chụp lại màn hình rồi nén mạnh có chữ ký rất
riêng, và mọi đòn tấn công trong mẻ train đều mang chữ ký đó.

Điều tra đầy đủ, chạy lại được: [`ml/notebooks/01_celeba_spoof_splits.py`](../../../ml/notebooks/01_celeba_spoof_splits.py).

### Split đang dùng

| | Spec | Shard | Bản ghi |
|---|---|---|---|
| train | `train` | 210 | 419.935 |
| val | `test:0:10` | 10 | 20.000 |
| test | `test:10:` | 20 | 39.191 |

`valid` của mirror **bỏ không dùng**. Cắt theo shard mua được tính lặp lại, **không** mua
được tách biệt danh tính: không có nhãn identity, và thứ tự của mirror đã trộn sẵn hai
lớp, nên một người vẫn có thể nằm cả hai bên.

---

## 2. Teacher CDCN++ — run đầu đã bỏ

Run `20260831-1844`, 30 epoch, EER 0,0134 trên `valid` cũ. **Con số đó không dùng được**,
và bản thân checkpoint cũng không:

- `best.pth` chọn ở epoch 25 theo EER trên mẻ `valid` — tiêu chí chọn mù với tổng quát hoá.
- Train **không có augment nén**, nên nó vẫn học vết nén làm dấu hiệu.

Chấm lại chính checkpoint đó trên mẻ test (giao thức: ngưỡng chốt trên val, áp nguyên sang
test):

| | AUC | EER | APCER | BPCER | ACER |
|---|---|---|---|---|---|
| `valid` cũ | 0,9984 | 0,0134 | — | — | — |
| **test** | **0,9384** | **0,1365** | **0,4028** | 0,0147 | **0,2087** |

Hình dạng lỗi là chẩn đoán: **BPCER 1,5% mà APCER 40%** — mặt thật vẫn nhận tốt, còn 40%
đòn tấn công lọt. Đó là chữ ký của một dấu hiệu bề mặt không chuyển miền được, không phải
của một model kém toàn diện.

Teacher phải chạy lại. Bản chạy lại tự thừa hưởng split mới, augment nén, EMA fused và
`compile`.

---

## 3. Augment nén — cách chữa

Mỗi crop được mã hoá lại JPEG ở chất lượng bốc ngẫu nhiên trong `[30, 95]`, xác suất 0,5,
**chỉ khi train**. Hai view cùng một chất lượng vì chúng là một cảnh. Augment vào split
dùng để chọn checkpoint sẽ làm dịch chuyển chính cái đích, nên val/test không bao giờ bị.

Giá phải trả, đo trên reader: **4.211 → 3.951 ảnh/s** (−6%), trong khi bước train chỉ tiêu
thụ ~1.735, nên nó không thành nút thắt.

---

## 4. Chi phí một bước, và ba lần sửa

Đo ở batch 96, 120 bước sau 30 bước làm nóng:

| Cấu hình | ảnh/s |
|---|---|
| loader riêng | 4.181 |
| step thuần | 1.659 |
| step + clip + EMA (gốc) | **1.299** |
| … EMA fused | 1.545 |
| … + `compile` | **1.873** |
| … + `reduce-overhead` | 2.145 |

Ba thứ tìm ra khi soi vì sao main process ghim 105% CPU còn GPU chỉ 57%:

1. **`ModelEma.update`** dựng lại cả hai `state_dict` mỗi bước rồi lặp Python từng tensor
   với `mul_` + `add_` — hàng trăm kernel tí hon mỗi bước. Ăn **22%** của bước; sau khi gộp
   bằng `_foreach_*` còn **5%**. Phép toán không đổi: test so bằng `torch.equal`.
2. **`compile` chưa từng được bật cho nhánh này** — nó nằm ở config recognition. Trớ trêu
   là nhánh model nhỏ nhất, nơi overhead Python nặng nhất, lại là nhánh thiếu nó.
3. **`reduce-overhead` (CUDA graphs)** hơn thêm 15% trên benchmark, **không bật**: tỉ lệ
   benchmark→thực tế đo được là 63%, nên thực tế chỉ còn ~9%, mà §3.7 buộc bật cho cả arm
   A3 dài ~13 giờ và graph capture đòi shape tĩnh.

Epoch thật: **7 phút 19 → 4 phút 35** (−37%).

> Con số "4 phút/epoch" trong config trước đây lấy từ micro-benchmark trên dữ liệu tổng
> hợp, chưa từng có epoch nào chạy như thế. Mọi số ở mục này ghi rõ là benchmark hay là
> epoch thật.

---

## 5. Bảng đối chứng A — có teacher hay không (§3.7)

| Arm | Cách train | AUC val | EER val | **ACER trên `test:10:`** |
|---|---|---|---|---|
| **A0** | task loss, không teacher | 0,9605 | 0,1064 | **0,0973** |
| **A3** | A0 + logit + depth map + contrastive depth | chưa chạy | chưa chạy | chưa |

Cổng nhánh: **ACER < 5%** sau INT8. A0 trượt khoảng hai lần.

**Con số 5% chưa có căn cứ đo đạc.** Nó nằm ở `TASKS.md` E6-T6, và tìm khắp KẾ HOẠCH không
thấy chỗ nào dẫn nó ra từ một phép đo. Tham chiếu anti-spoof duy nhất là §1.1: CDCN++ ACER
0,2% trên **OULU-NPU P1** — mà chính §1.2 đã ghi rằng dự án này *"không thay được khả năng
so số trực tiếp với bảng trong bài báo CDCN++"* và không có giao thức OULU. OULU là phòng
lab; CelebA-Spoof là ngoài đời.

Số đo khớp với chẩn đoán đó: model qua cổng thoải mái trên bộ kiểm soát (NUAA EER 1,14%,
Axon đòn phẳng 0–8,75%) và trượt trên CelebA-Spoof (9,73%). Nhánh detect đã gặp đúng lỗi
này — ba số WIDER đo ở độ phân giải gốc đem làm cổng cho model 160×120 — và KẾ HOẠCH §3 xử
bằng cách định nghĩa miền phục vụ rồi đặt cổng trên đó, vẫn báo cáo đủ số gốc bên cạnh.

Anti-spoof cần đúng cách làm ấy, nhưng **phải định nghĩa miền trước khi nhìn số nó sinh
ra**, nếu không thì là chọn cho vừa. Việc đó cần tập tự thu (§10) và phải qua §1.2.

### A0 — `20260901-0717_b326cd5_6706a4`, 60 epoch, best ở epoch 47

Chấm bằng `eval.py`, ngưỡng chốt trên `test:0:10` rồi áp nguyên sang `test:10:`:

| | n | AUC | APCER | BPCER | ACER |
|---|---|---|---|---|---|
| val `test:0:10` | 20.000 | 0,9605 | — | — | EER 0,1064 |
| **test `test:10:`** | 39.191 | **0,9698** | **0,0863** | **0,1082** | **0,0973** |

Hai lớp lỗi giờ **cân nhau** (0,086 so với 0,108), khác hẳn teacher cũ (0,403 so với 0,015). Đường
tắt vết nén đã bị chặn.

**BPCER 0,1082 đáng lo ngang APCER**: cứ 9 lần chấm công thật thì 1 lần bị từ chối. Với
kiosk, phiền hơn việc lọt vài đòn tấn công.

Đường cong val (EER, val mỗi 2 epoch): 0,1554 → 0,1352 → 0,1297 → 0,1290 → 0,1307 →
0,1173 → 0,1261 → 0,1122 → … → **0,1064 (epoch 47)** → 0,1279 (epoch 59). Đáy ở epoch 47,
đúng đoạn cosine kéo LR xuống mạnh; 12 epoch cuối đi ngược. Val loss leo đều 0,52 → 1,83
trong khi train loss rơi 0,042 → 0,0023 — nhớ tập train, nhưng `best.pth` giữ đúng đáy.

---

## 6. Chẩn đoán khác miền — model thua kiểu tấn công nào

Chấm A0 trên hai bộ ngoài, **ở ngưỡng mà tập nhà đã chọn** (0,997355). Fit lại ngưỡng trên
bộ ngoài sẽ đo "bộ đó dễ hay khó" thay vì đo khả năng chuyển miền.

Mặt do chính nhánh detect tìm (`xdomain_crop.py`), không lấy box ground-truth: crop mà
kiosk không tự tạo ra được thì không phải phép thử công bằng. **100% ảnh dò được mặt** ở
cả hai bộ, kể cả trên mặt nạ silicone và ảnh phát lại.

### NUAA — ảnh in, miền hoàn toàn khác

| n | AUC | EER | APCER | BPCER | HTER |
|---|---|---|---|---|---|
| 5.110 | **0,9992** | **0,0114** | **0,0006** | 0,1987 | 0,0996 |

Chuyển miền **rất tốt**: webcam 2010, camera khác, nén khác, mà EER tốt hơn trên chính
CelebA-Spoof **8 lần** và chặn 99,94% đòn tấn công. HTER 0,0996 gần như toàn bộ đến từ
BPCER — ngưỡng nhà (0,9974, rất chặt) không mang sang được phân bố ảnh live của NUAA.

**Đây là bằng chứng bác bỏ giả thuyết "9,7% là do lệch miền dữ liệu".**

### AxonData — APCER theo từng kiểu tấn công

| Kiểu | n | APCER |
|---|---|---|
| cut-out | 120 | **0,0000** |
| replay mobile | 80 | 0,0125 |
| 3D paper mask | 288 | 0,0312 |
| replay display | 45 | 0,0667 |
| wrapped 3D paper | 80 | 0,0875 |
| **textile 3D mask** | 184 | **0,2500** |
| **silicone mask** | 88 | **0,3523** |
| **latex mask** | 80 | **0,5875** |

Ranh giới sạch: **mọi tấn công phẳng đều bị chặn** (0–8,75%), **mặt nạ vật liệu 3D lọt ồ ạt**
(25–59%).

Nguyên nhân là **lỗ hổng phủ, không phải lỗi học**: CelebA-Spoof không chứa một mặt nạ 3D
nào. Và depth map **không cứu được** loại này — mặt nạ latex đeo trên mặt có gò nổi thật,
đúng đặc trưng mà teacher CDCN++ học, nên teacher cũng bị lừa. Depth map là thuốc cho tấn
công **phẳng**, mà tấn công phẳng thì A0 đã giải xong.

Không train được trên Axon: **đa dạng bằng 2** — latex có đúng 2 chiếc mặt nạ (Mask_6,
Mask_8), silicone 2, textile 2 người; phía live chỉ 24 ảnh selfie. Các bộ khác trên
HuggingFace (`silicone-mask-dataset` 58 video, `mask-face-anti-spoofing-dataset` 53 mẫu)
đều là mẫu quảng cáo, bản đầy đủ bán thương mại, và **cùng một nhà cung cấp AxonData** nên
train chéo giữa chúng vẫn quẩn trong một miền.

BPCER 0,4167 trên selfies tính trên **24 ảnh** (mỗi ảnh 4,2%) — nhiễu cộng lệch ngưỡng,
không kết luận được gì.

**Kết luận phạm vi**: mặt nạ 3D nằm ngoài mô hình mối đe doạ của kiosk điểm danh, được ghi
nhận thành giới hạn đã định lượng. Hướng khắc phục nếu cần sau này: NIR (da và latex phản
xạ hồng ngoại khác nhau) hoặc rPPG (latex không có mạch đập) — cả hai đều đụng §2, §5, §6
nên phải qua §1.2.

---

## 7. Đích depth phủ 71,2% lên hậu cảnh

Teacher đọc crop **wide**, nơi `scaled_box` để hộp mặt chiếm **14,1% diện tích**. Gò Gauss
`sigma=0.28` vẽ cho crop tight, và `l1_loss` tính trên toàn bản đồ không mask:

| `sigma` | Khối lượng đích trên mặt | Trên nền |
|---|---|---|
| 0,28 — gò phủ cả khung | 28,8% | **71,2%** |
| 0,104 — thu theo cạnh hộp | 86,4% | 13,6% |
| **mask hộp + gò** (đã chốt) | **100%** | 0% |

Mẫu live bắt bức tường phía sau nhận giá trị "bề mặt sống", mẫu spoof bắt chính bức tường
đó bằng 0 — mà CelebA-Spoof quay hai lớp trong cùng những căn phòng. **71,2% loss dạy phần
nền mang nhãn lớp**, đúng đường tắt mà giám sát depth sinh ra để chặn.

Che mặt nạ không thôi thì hỏng chiều ngược lại: ngoài hộp hai lớp cùng đích 0, nên bản đồ
phẳng — đáp án suy biến — chỉ còn tốn 0,0585 thay vì 0,4160. **L1 lấy trung bình riêng
trong và ngoài hộp rồi cộng**, đưa giá về đúng 0,4160 nhưng lần này toàn bộ từ vùng mặt.

Run teacher `20260901-1239` chạy trên công thức hỏng, dừng ở epoch 11. Đường cong của nó
giữ lại làm hàng đối chứng "trước khi sửa":

| epoch | 1 | 3 | 5 | 7 | 9 | 11 |
|---|---|---|---|---|---|---|
| EER | 0,4995 | 0,2203 | 0,1919 | 0,1762 | 0,1673 | 0,1607 |

Chia LR ở epoch 10 không đổi gì (mốc null đặt trước: 0,162; thực tế 0,1607), tức nó bão hoà
quanh 0,16 — trên cả 0,1365 của bản teacher cũ và 0,1064 của student.

---

## 8. Năm phép augment còn thiếu — chưa kết luận được

KẾ HOẠCH §3 lớp 2 khai sáu phép; code chỉ có lật ngang và nén JPEG. Bổ sung nhiễu
Poisson-Gaussian, lệch cân bằng trắng, vignette, motion blur, ngược sáng — mỗi mẫu rút tham
số một lần rồi áp cho **cả hai view**, gồm chung một luồng nhiễu vì crop tight nằm giữa crop
wide nên cùng điểm ảnh cảm biến xuất hiện hai lần.

Giá phải trả, đo trên reader: **1.534 img/s** khi dùng Poisson thật → **2.876 img/s** sau khi
thay bằng Gauss cùng phương sai, cache lưới toạ độ và bỏ `sqrt` thừa ở vignette. Bước train
tiêu thụ ~1.735 nên reader hết là nút thắt.

A0 bản augment (`20260901-1508`), so với A0 cũ ở **cùng epoch**:

| epoch | 1 | 3 | 5 | 7 | 9 | 11 | 13 | 15 | 17 | 19 |
|---|---|---|---|---|---|---|---|---|---|---|
| augment | 0,2058 | 0,1772 | 0,1629 | 0,1592 | 0,1631 | 0,1532 | 0,1624 | 0,1485 | 0,1598 | 0,1639 |
| cũ | 0,1554 | 0,1352 | 0,1297 | 0,1290 | 0,1307 | 0,1173 | 0,1261 | 0,1122 | — | — |

Khoảng cách co tới epoch 7 (0,0504 → 0,0302) rồi ngừng, sau đó dao động 0,148–0,164 không
có hướng. Mốc đặt trước ở epoch 5 là **≥ 0,145 tại epoch 15 nghĩa là không trả công**; kết
quả 0,1485, trượt.

**Nhưng phép đo này chỉ kết luận được cho CelebA-Spoof val, không cho thiết bị.** Tập val là
ảnh sạch, còn năm phép augment mô phỏng đúng đường OV5640 — chấm chúng bằng ảnh sạch là đo
trên miền chúng không nhắm tới. Câu "augment có lợi hay hại" **chỉ trả lời được khi có tập
tự thu**, và khi đó phải chấm cả hai checkpoint.

---

## 9. OV5640 thật — ba số đầu tiên trên miền thiết bị

Board ESP32-S3 + OV5640 (PID `0x5640`) phát MJPEG, host chạy detect → anti-spoof qua
`ml/bench/live_demo.py`. Crop cắt đúng đường của shard train (hộp vuông hoá, JPEG q95 ở
128 px, resize 80).

| | Số đo |
|---|---|
| Detect trên một khung 640×480 | 1 mặt, điểm 0,708, hộp **128×138 px**, 50 ms |
| Anti-spoof cùng khung | liveness **0,993633** so với ngưỡng 0,997355 → **SPOOF** |
| Một phiên 66 khung | live 21,2% · spoof 42,4% · không thấy mặt 36,4% |

**Mặt thật bị gọi SPOOF, thiếu đúng 0,0037.** Ngưỡng nằm sát 1 tới mức đó vì phân bố
CelebA-Spoof bão hoà; sang cảm biến khác thì biên đó không còn nghĩa.

Quan sát khi xem trực tiếp trên board: **mặt chính diện ra LIVE, mặt quay nghiêng ra SPOOF.**
Giả thuyết lúc đó là model học tương quan **tư thế** thay vì học độ nổi.

**Giả thuyết này đã bị bác, hai lần.** Đo phân bố tư thế của 250 crop mỗi lớp trong tập
train bằng landmark của detector: yaw trung bình **live 0,1381 · spoof 0,1273** — hai lớp
gần như y hệt, spoof còn chính diện hơn một chút. Không có tương quan nào để mà học. Rồi
chấm trực tiếp trên ảnh camera: khung yaw cao nhất (0,3177) lại cho liveness cao nhất
(0,999746), còn khung bị gọi SPOOF có yaw 0,0849, gần như chính diện.

Nguyên nhân thật của quan sát trên board là **phơi sáng** — xem mục dưới — và ở phần đo trên
điện thoại là **ảnh nằm ngang 90°** do virtual camera của Windows. Cả hai đều là hỏng ở khâu
lấy ảnh, không phải ở model. §10 đo lại trên ảnh dựng đứng và đủ sáng: nghiêng đầu, ngẩng
cúi, ngược sáng đều đạt 0,9999.

**Đã kiểm chứng sơ bộ trên chính board.** Ngưỡng 0,997355:

| Tư thế | n | liveness | Gọi LIVE |
|---|---|---|---|
| chính diện, loạt liên tiếp | 11 | tb 0,997958 · max 0,999994 | **90,9%** |
| chính diện, quality 10 | 2 | 0,999974 | 100% |
| chính diện, quality 4 | 1 | 0,999854 | 100% |
| **nghiêng, hơi cúi** | 1 | **0,993633** | **0%** |

Chính diện đọc ~0,9999, nghiêng đọc 0,9936 — chênh ~0,006 và **ngưỡng nằm đúng giữa**.
Người dùng quan sát trực tiếp trên luồng video: đổi góc mặt là chuyển sang SPOOF ngay, lặp
lại nhất quán.

Phép so có kiểm soát **loại được chất lượng ảnh** khỏi danh sách nghi phạm: cùng người cùng
vị trí, quality 10 và quality 4 đều cho 0,9999 và 100% LIVE. Cơ chế nén hai lần có thật
nhưng ở dải này không phải yếu tố quyết định.

🔬 **n=1 cho nhóm nghiêng, và nhóm đó về sau hoá ra là ca ngược sáng chứ không phải ca tư
thế.** Bảng này giữ lại làm ghi chép, kết luận đúng nằm ở §10.

### Phơi sáng lay điểm số mạnh hơn biên của ngưỡng 50 lần

Cùng người, cùng model, chỉ khác ánh sáng:

| Điều kiện | liveness |
|---|---|
| đủ sáng, chính diện | 0,9999 |
| ngược sáng, mặt nằm trong bóng | **0,683** |

Biên độ do ánh sáng: **0,32**. Khoảng cách từ mặt thật tới ngưỡng: **0,006**.

Nguyên nhân đo được: AE của OV5640 đo sáng **cả cảnh**. Camera chĩa lên trần sáng nên nó
hạ phơi sáng để cứu trần, dìm mặt vào bóng; mặt tối thì mất kết cấu da, mà kết cấu da là
thứ model dùng để tách da thật khỏi mặt phẳng in. Cùng cơ chế ấy làm màn hình điện thoại
cháy trắng và loé khi đưa vào khung.

**Hệ quả kiến trúc**: nếu phơi sáng trôi tự do thì không có ngưỡng cố định nào bền — hiệu
chỉnh hôm nay, đổi giờ trong ngày là sai. Chính sách phơi sáng của `drv_camera` nằm ở
**thượng nguồn** của ngưỡng anti-spoof. KẾ HOẠCH hiện **không quy định** chính sách này.

Ba hướng, chưa chốt, phải qua §1.2: AE đo cả cảnh (đã đo là hỏng cả hai chiều) · AE đo theo
hộp mặt do detector trả về · phơi sáng cố định (lặp lại được nên ngưỡng bền, hỏng khi ánh
sáng phòng đổi nhiều).

**Một cái bẫy khi nghiệm thu**: nếu màn hình cháy tới mức detector không tìm ra mặt, đòn
tấn công thất bại **vì detect không bắt được, không phải vì anti-spoof chặn được**. Ghi
nhận đó là "chặn được" là tự lừa mình; kẻ tấn công chỉ cần hạ độ sáng màn hình. Mọi phép đo
APCER phải tách riêng "bắt được mặt rồi từ chối" khỏi "không bắt được mặt".

### Chất lượng ảnh camera — cơ chế nén hai lần

Crop train sinh từ ảnh gốc rồi nén JPEG q95. Ảnh OV5640 thì **đã nén sẵn trên board** mới
bị crop và nén lại q95 — một lịch sử nén tập train chưa từng có, trên đúng nhánh mà §3 đã
chứng minh là bám vào vết nén.

Quét `jpeg_quality` của driver (số nhỏ là chất lượng cao):

| quality | KB mỗi khung VGA | blockiness |
|---|---|---|
| 4 | 32,9 – 39,5 | **1,67** |
| 8 | 18,3 | 2,23 |
| 10 (mặc định cũ) | 15,6 | — |

Chốt **quality 4 khi thu dữ liệu** (gấp 2,5 lần dữ liệu, ít vết block hơn) và giữ 10 khi
xem trực tiếp, vì 39,5 KB/khung trên 119 KB/s chỉ còn ~3 fps.

So sánh khác giữa ảnh OV5640 và crop CelebA-Spoof **chưa kết luận được**: phép đo lấy bức
tường phẳng so với ảnh mặt, nên `sharp` và `std` thấp là do nội dung. Chỉ số ít bị nhiễu
duy nhất là độ sáng — OV5640 đọc 142,2, nằm trong dải p10–p90 của tập train (73,9–151,5).

🔬 Mức ảnh hưởng lên chính điểm liveness **chưa đo**, vì cần khuôn mặt trong khung.

Chi phí host, đo trên CPU: detect 50 ms + anti-spoof 62 ms = **112 ms, ~9 fps**. Đường
truyền mới là nút thắt: camera tự chụp được **10,9 fps** (16,2 KB/khung) nhưng qua WiFi chỉ
về **1,3 fps**. Nguyên nhân là cửa sổ TCP và buffer gửi LWIP mặc định 5.760 byte; nâng lên
65.534 và bật AMPDU cho **6,95 fps, 119 KB/s** — gấp hơn 5 lần. Con số này đáng nhớ khi viết
`drv_camera` thật.

---

## 10. Bộ thước 48 khung trên camera thật — và ba kết luận bị bác

Điện thoại qua virtual camera của Windows, 1280×720, ảnh **dựng đứng và đủ sáng** — hai điều
kiện mà mọi phép đo trước đó của nhánh này đều thiếu. Bốn nhóm, 12 khung mỗi nhóm, chấm bằng
A0 `20260901-0717` ở ngưỡng 0,997355:

| Nhóm | n | cỡ mặt | liveness tb | dải | Đúng |
|---|---|---|---|---|---|
| `live_vua` — cách một cánh tay | 12 | 349 px | 1,0000 | 1,0000 | **100%** |
| `live_kho` — nghiêng, ngẩng cúi, ngược sáng | 12 | 319 px | 0,9999 | 0,9995–1,0000 | **100%** |
| `live_gan` — sát camera | 12 | 696 px | 0,2538 | 0,166–0,413 | **0%** |
| `attack_anh` — ảnh thẻ in | 12 | 235 px | 0,0035 | 0,0003–0,0106 | **100%** |

**Tư thế và ngược sáng không phải vấn đề.** Nhóm `live_kho` gộp cả hai và đạt 0,9999. Ba kết
luận trước của nhánh — model bám tư thế (§9), phơi sáng lay điểm mạnh hơn biên ngưỡng 50 lần
(§9), nén hai lần là thủ phạm (§9) — đều rút ra từ **ảnh hỏng ở khâu thu**: OV5640 cháy sáng
vì AE đo cả trần nhà, rồi ảnh điện thoại nằm ngang 90°. Đo trên ảnh đúng thì cả ba biến mất.

**Chỉ còn một lỗi thật: đứng gần.** Mặt 696 px cho 0,166–0,413, trượt sạch. Ba cách cắt crop
đã thử ở khoảng cách đó (cắt cụt · đệm viền · vuông lọt khung) đều bị gọi tấn công, nên
nguyên nhân là phân bố train chứ không phải phép cắt: đứng gần thì quanh mặt **không còn
phòng** cho view wide, và không phép cắt nào lấy lại được thứ camera chưa chụp.

### Ngưỡng đang đặt sai chỗ, và sửa được ngay

| | Mặt thật | Tấn công |
|---|---|---|
| Thấp nhất / cao nhất | **0,1661** | **0,0106** |

Hai lớp cách nhau **15 lần**. Model phân biệt tốt; cái vạch mới là chỗ sai:

| Ngưỡng | Nhận đúng mặt thật | Chặn tấn công |
|---|---|---|
| 0,997355 — vay từ CelebA-Spoof | **67%** | 100% |
| ~0,17 — đo trên chính thiết bị | **100%** | **100%** |

Đổi mỗi hằng số ngưỡng là từ 67% lên 100%, **không train lại gì**. Đây là bằng chứng đo được
cho luận điểm ở §5: cổng và ngưỡng vay từ miền khác thì không có nghĩa.

🔬 **n=48, một người, một phòng, một buổi.** Đủ để kết luận 0,997355 sai, **chưa đủ** để chốt
con số thay thế cho sản phẩm.

---

## 11. Còn nợ

- **Tập tự thu bằng OV5640** (KẾ HOẠCH §1.2, ≥500 ảnh mỗi loại). Phần cứng đã sẵn sàng và
  đường lấy ảnh đã thông; chỉ còn khâu ngồi thu. Đây là thứ chặn ba câu hỏi cùng lúc: giả
  thuyết tư thế, ngưỡng vận hành thật, và cổng nghiệm thu đo trên miền thiết bị.
- Chạy lại teacher với đích depth đã sửa → chạy A3 → điền §5 → ADR.
- **A0 chưa có bản đối chứng tắt augment nén.** Đã đo rằng nó không phá hỏng gì, nhưng
  chưa đo rằng nó giúp. Muốn chắc thì cần một run A0 với `recompress_probability: 0`.
- UniqueData live + replay: hai bộ khác miền còn lại chưa chấm, cả hai là video nên cần
  giải khung hình như Axon.
- `export_soft_target.py`, `postproc/preproc.py`, `postproc/emit_golden.py`, `quant.py`,
  `README.md` — §4.4 đã khai, chưa viết.
- Thang lượng tử hoá §3.8.
