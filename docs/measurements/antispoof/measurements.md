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

## 11. Ảnh wide dựng sai — nguyên nhân gốc của mọi số ở §9 và §10

### 11.1 Cái hỏng

`scaled_box` phóng hộp mặt quanh tâm, vuông hoá, rồi **clamp về trong khung**. Clamp một
hình vuông vào khung trả ra hình **chữ nhật**; `resize` về vuông sau đó là kéo méo mặt.

Đo trên 48 khung camera thật, hộp wide 2,7×:

| Nhóm | Mất hộp wide | Tỉ lệ cạnh | Mặt chiếm crop |
|---|---|---|---|
| live_gan (ngồi sát) | **74%** | **1,78** | **0,97** |
| live_vua (một cánh tay) | 24% | 1,31 | 0,48 |
| live_kho (nghiêng, ngược sáng) | 16% | 1,20 | 0,44 |
| attack_anh (ảnh thẻ) | 11% | 1,13 | 0,42 |
| *train kỳ vọng* | *0%* | *1,00* | *0,37* |

Không phải lỗi biên hiếm: ở khoảng cách dùng bình thường đã mất 24%. Và **thứ tự méo trùng
thứ tự nhãn** — tấn công méo ít nhất vì ảnh thẻ bị giơ xa hơn mặt người.

### 11.2 Clamp không phải chỗ hỏng, méo tỉ lệ mới là

Đo trên 3 shard train (n=13.548): clamp có đầy trong train, model quen rồi.

| | Mất hộp trung bình | Mất > 50% | Lệch cạnh > 1,5 | Mặt chiếm crop |
|---|---|---|---|---|
| live (n=4.596) | 34,7% | 26,7% | **4,6%** | 0,53 |
| spoof (n=8.952) | 40,7% | 39,8% | **0,4%** | 0,58 |

Lệch cạnh 1,78 của mặt gần nằm trong đuôi dưới 5% mà train từng thấy. Mặt chiếm 0,97 thì
nằm ngoài hẳn.

### 11.3 Bốn cách dựng, cùng một bộ trọng số

Chỉ đổi ảnh wide, không train lại, không đổi ảnh tight:

| Cách dựng | live_gan | live_vua | attack_anh | Cách biệt |
|---|---|---|---|---|
| Clamp rồi kéo về vuông | 0,2538 | 1,0000 | 0,0035 | 15,6× |
| Đệm phản chiếu cho đủ 2,7× | 0,0823 | 0,9999 | 0,0160 | — |
| Lấy tight làm wide | 0,9953 | **0,0002** | 0,3195 | — |
| **Ô vuông lớn nhất lọt khung** | **0,9957** | **0,9999** | **0,0027** | **108×** |

Đệm cho vuông làm **tệ hơn** clamp. Nên thủ phạm không phải méo tỉ lệ đơn thuần — ngữ cảnh
**bịa ra**, dù bằng kéo giãn hay phản chiếu, bị model đọc là dấu hiệu tấn công. Ở mặt gần
trong khung hình **không tồn tại** ngữ cảnh 2,7×; cách duy nhất đúng là thu tỉ lệ lại.

Qua đường code thật sau khi sửa, cả tight lẫn wide đều dựng bằng `fitted_box`: thật thấp
nhất **0,9927**, tấn công cao nhất **0,0073**, cách biệt **136×**.

### 11.4 Nhánh wide gánh bao nhiêu

Thay wide bằng tight rồi đo lệch điểm:

| Nhóm | Có wide | Mù wide | Lệch |
|---|---|---|---|
| attack_anh | 0,0035 | 0,3195 | 0,3160 |
| live_vua | 1,0000 | 0,0002 | 0,9998 |

Phần lớn khả năng bắt tấn công đi qua ngữ cảnh. Đây là lý do zoom toàn cục ở §8 phá biên:
nó bóc ngữ cảnh wide trên **mọi** mẫu.

### 11.5 Tấn công ở cự ly gần — lỗ hổng dự đoán, không có thật

Lo ngại: ô vuông lọt khung thu về ~1,0× ở mặt gần, hết viền để bắt. Đo trên nhóm mới
`attack_gan` (giơ ảnh thẻ / màn hình sát camera):

| Nhóm | n | Trung bình | Dải | Chặn |
|---|---|---|---|---|
| attack_gan | 3 | **0,0006** | 0,0000–0,0019 | 100% |
| attack_anh | 12 | 0,0027 | 0,0004–0,0073 | 100% |

Tấn công gần chấm **thấp hơn** tấn công xa. Dí sát màn hình thì lưới điểm ảnh và moiré rõ
hơn, mà đó là dấu hiệu **trong** khuôn mặt — nhánh tight đọc được. Mất ngữ cảnh ở cự ly gần
rơi đúng lúc dấu hiệu trong mặt mạnh nhất.

🔬 **n=3, và là ảnh chụp bằng điện thoại chứ không phải khung từ camera kiosk.** Đủ để nói
lỗ hổng không tồn tại như đã lo, **chưa đủ** làm số nghiệm thu.

### 11.6 Kéo theo: đích depth

`FACE_FRACTION = 1 / 2,7` là hằng số, nhưng mặt chiếm trung bình 0,53 (live) và 0,58
(spoof) cạnh khung. Gò Gauss bị đặt lệch trên phần lớn dữ liệu, và phần lệch rơi đúng vào
vùng mặt — chỗ duy nhất phân biệt hai lớp. Teacher chưa train lại lần nào từ khi sửa đích
ở §7, nên bắt được trước khi tốn giờ GPU.

---

## 12. A0 trên crop đã sửa + augment phơi sáng

Run `20260902-0140_0212c98_6706a4`, 60 epoch, seed 42, EER tốt nhất **0,1371** ở epoch 57.
Không đặt cạnh EER của các run trước được: val split sinh lại trên crop mới, hai bên chấm
trên hai bộ ảnh khác nhau.

```
ep 1  0,2409    ep 21  0,1719    ep 39  0,1559    ep 55  0,1420
ep 11 0,1765    ep 29  0,1759    ep 45  0,1509    ep 57  0,1371
```

Phẳng suốt epoch 11–30 rồi đuôi cosine kéo xuống: 20 epoch cuối đóng góp gần một phần tư
tổng mức giảm. Cắt ngắn lịch là vứt đúng phần đó.

### 12.1 Bất biến phơi sáng — đã đạt

Ép tối và bẹt tương phản trên chính khung mà mỗi model đang chấm đúng:

| `live_vua` | Model cũ | A0 mới |
|---|---|---|
| Nguyên bản | 0,9999 | 0,9969 |
| Tối 15%, tương phản 80% | **0,0262** | **0,9920** |
| Tối 30%, tương phản 65% | 0,0066 | 0,9872 |
| Tối 45%, tương phản 50% | — | 0,9451 |

Mất 94% điểm xuống còn mất 0,5%. Đây là phép đo thẳng vào cơ chế ở §11.6 và nó đóng lại.

### 12.2 Cú đảo ở khoảng cách xa — đã hết

| Nhóm camera thật | Model cũ | A0 mới | |
|---|---|---|---|
| Mặt rất xa (163 px) | 0,1403 | **0,9979** | từ chối nhầm → nhận đúng |
| Màn hình laptop ở xa (121 px) | 0,9295 | **0,0222** | lọt → chặn 100% |
| Mặt sát camera | 0,9963 | 0,9999 | giữ |
| Mặt một cánh tay | 0,9999 | 0,9969 | giữ |
| Quay đầu, nghiêng, ngược sáng | 0,9999 | 0,9992 | giữ |
| Ảnh thẻ ở cự ly vừa | 0,0027 | 0,0022 | giữ |

Ở model cũ, xa thì mặt thật bị gọi là giả còn màn hình được gọi là thật. Cả hai chiều đều
đảo lại đúng.

### 12.3 Hai lỗ còn lại

**Đòn màn hình ở cỡ mặt trung bình lọt.** Nhóm `attack_gan` chỉ có 3 khung và chúng không
đồng ý với nhau:

| Khung | Cạnh mặt / cạnh ngắn khung | Điểm |
|---|---|---|
| 000 | 0,36 | **0,9969** lọt |
| 001 | 0,77 | 0,0006 |
| 002 | 0,79 | 0,0045 |

Dí thật sát thì bắt được, cỡ trung thì lọt. 🔬 **n=3, một khung sai — chưa đủ nói đây là
quy luật hay ngoại lệ**, và cũng chưa đủ để bỏ qua: màn hình lọt ở 0,997 là lỗi mở cửa.

**`live_xa` bất định**: trung bình 0,7349, dải 0,1994–0,9929. Khung thấp nhất cũng là khung
nhoè nhất, nhưng tương quan giữa điểm và độ nét chỉ **+0,378** trên 20 khung, và hai khung
cùng độ nét 34 chấm 0,27 với 0,99. Nhoè chỉ giải thích một phần.

Hai lỗ này là lý do **chưa chạy teacher và A3**: bảng đối chứng A chỉ có nghĩa khi arm nền
đã dùng được, mà một đòn tấn công lọt ở 0,997 thì chưa.

### 12.4 Ngưỡng 0,997355 một mình từ chối 12–18% mặt thật

Chấm 6.000 bản ghi `test:10:13` bằng cả hai bộ trọng số, cùng crop, cùng đường code:

| | live p5 | live p25 | attack med | EER | thr tại EER |
|---|---|---|---|---|---|
| `20260901-0717` (crop hỏng) | 0,8513 | 0,9991 | 0,0007 | 0,1043 | 0,9811 |
| `20260902-0140` (crop đã sửa) | **0,9739** | **0,9996** | 0,0008 | 0,1072 | 0,9953 |

Quét ngưỡng, BPCER là tỉ lệ **mặt thật bị gọi là giả**:

| Ngưỡng | `0717` BPCER / APCER | `0140` BPCER / APCER |
|---|---|---|
| **0,997355** (đang dùng) | **0,1837** / 0,0602 | **0,1264** / 0,0980 |
| 0,99 | 0,1298 / 0,0871 | 0,0782 / 0,1195 |
| 0,90 | 0,0624 / 0,1454 | **0,0266** / 0,1690 |
| 0,50 | 0,0227 / 0,2226 | 0,0102 / 0,2167 |

Cứ sáu khuôn mặt thật thì một bị từ chối, **trước khi** tính tới tư thế hay ánh sáng. Đây
là cùng một kết luận §10 rút ra trên 48 khung camera, giờ đo lại trên 6.000 bản ghi.

Hạ về 0,90 cắt tỉ lệ từ chối nhầm đi 4,8 lần trên `0140`, đổi lấy APCER tăng từ 0,098 lên
0,169 **trên CelebA-Spoof**. Con số APCER đó không mang sang thiết bị được: §11.3 và §12.2
đo trên khung camera thật cho cách biệt 108–136 lần, tức trên miền thiết bị hai lớp nằm xa
nhau hơn hẳn so với trên bộ mirror này. Ngưỡng phải đo trên miền thiết bị (§19).

`0140` tốt hơn ở **đuôi dưới của lớp thật** — p5 từ 0,8513 lên 0,9739 — mà đuôi dưới chính
là chỗ ngưỡng cắt. Ở đỉnh thì hai bên như nhau (cả hai trung vị 1,0000).

Quét rộng hơn cho `0140`, 20.000 bản ghi `test:10:20` (5.743 thật / 14.257 tấn công):

| Ngưỡng | Mặt thật bị từ chối | Tấn công lọt |
|---|---|---|
| 0,50 | 0,91% | 31,6% |
| 0,80 | 1,83% | 27,8% |
| **0,90** | **2,61%** | 25,2% |
| 0,99 | 7,30% | 17,7% |
| 0,997355 | 12,33% | 12,6% |

**Cột phải không mang sang thiết bị được.** Trên khung camera thật (§11.3, §12.2) tấn công
nằm ở 0,0022–0,0222 còn mặt thật ở 0,9451–0,9999, tức mọi ngưỡng trong dải **0,05–0,94**
đều cho 100%/100%. Chọn **0,90** vì đó là giá trị **cao nhất** vẫn nằm dưới khung thật tệ
nhất đo được (0,9451, §12.1 khi ép tối 45%) — cao nhất trong vùng an toàn thì chặn được
nhiều nhất. Cách khung tấn công cao nhất 40 lần.

Accuracy tại ngưỡng tối ưu của chính nó: `0717` **90,47%**, `0140` **89,40%**. Các bản
MiniFASNetV2-SE công bố ngoài thường báo ~98% trên CelebA-Spoof, nhưng trên **split gốc**;
mirror ở §1 là bộ khác, `test` của nó 70,6% là tấn công, nên hai con số không đặt cạnh nhau
được. Khoảng cách vẫn đủ lớn để không bỏ qua.

### 12.5 Điểm số bám tỉ lệ crop, không bám tư thế — và train dạy nó thế

Tám khung điện thoại chụp bằng nút "Chụp khung này" của `live_demo.py`, đủ tư thế nghiêng
ngẩng cúi che, chấm bằng A0 `20260902-0140` ở ngưỡng 0,90. Cột `tight` là tỉ lệ mà **crop
sát mặt** thực sự đạt được: nhỏ hơn 1,00 nghĩa là ô vuông cắt ra **bé hơn chính hộp mặt**,
tức crop cắt cụt mặt.

| Khung | Điểm | `tight` | `wide` | Mặt (px) | Mặt / cạnh ngắn |
|---|---|---|---|---|---|
| 210043 | 0,0004 | **0,71** | 0,71 | 548 | 0,76 |
| 210309 | 0,0042 | **0,88** | 0,88 | 702 | 0,97 |
| 210133 | 0,1997 | 1,00 | 1,59 | 387 | 0,54 |
| 210051 | 0,5644 | **0,91** | 0,91 | 625 | 0,87 |
| 210124 | 0,6222 | **0,74** | 0,74 | 709 | 0,98 |
| 210317 | 0,7537 | 1,00 | 1,82 | 372 | 0,52 |
| 210059 | 0,9929 | 1,00 | 1,64 | 335 | 0,47 |
| 210115 | 0,9958 | 1,00 | 1,82 | 317 | 0,44 |

**Bốn khung có `tight` < 1,00 chiếm trọn bốn vị trí thấp nhất.** Không khung nào trong số
đó vượt 0,63; không khung nào có `tight` = 1,00 tụt xuống dưới 0,19. Tư thế thì trộn đều cả
hai nhóm, nên tư thế không giải thích được thứ tự này.

Bỏ dải đen letterbox đi rồi chấm lại (nguồn là ảnh dọc điện thoại nhồi vào khung ngang
1280×720, nội dung thật chỉ 507 px) làm **mọi khung tệ đi**, vì mất luôn phần phòng ngang:
`tight` tụt xuống 0,24–0,96 và điểm tụt theo xuống 0,008–0,08. Cùng một quy luật, đo lần
thứ hai trên 16 điểm.

### Train dạy đúng cái đó

Đếm `wide_scale` trên 10.000 bản ghi train. Vì `fitted_box` cắt cả hai view bằng cùng một
lượng phòng, `wide_scale` < 1,0 tương đương `tight` < 1,0:

| `wide_scale` | Tỉ lệ mẫu | Trong đó là mặt thật |
|---|---|---|
| **< 1,00** | 8,8% | **4,6%** |
| 1,00–1,50 | 34,4% | 28,3% |
| 1,50–2,00 | 33,5% | 46,5% |
| 2,00–2,70 | 22,7% | 36,4% |

| | Có `wide` < 1,0 |
|---|---|
| Mặt thật | **1,2%** |
| Tấn công | **12,8%** |

Trong tập train, crop bị cắt cụt **có xác suất là tấn công cao gấp 11 lần** là mặt thật.
Model học đúng thứ nó được dạy: **cắt cụt ⇒ tấn công**. Đây là tương quan giả trong dữ
liệu, không phải model hỏng — và nó nổ mỗi lần người dùng ngồi gần.

Ngưỡng không chữa được: đây không phải điểm số trôi vài phần nghìn quanh vạch, mà là hai
bậc độ lớn.

### Suy ra ngưỡng khoảng cách

Để `wide` với tới 2,7× thì cần `1,35 × mặt ≤` khoảng cách từ tâm mặt tới mép gần nhất. Mặt
đặt giữa khung cao 720 px cho **mặt ≤ 266 px**, tức **≤ 37% chiều cao khung**. Tám khung ở
trên nằm trong dải 44–98%: **không khung nào đủ xa**, kể cả hai khung chấm 0,99.

🔬 **n=8, một người, một buổi, một điện thoại.** Đủ để nói cơ chế, chưa đủ làm cổng nghiệm
thu.

---

## 13. Sinh lại shard bằng ô vuông trượt — kiểm nhận

Toàn bộ dữ liệu nhánh này dựng lại sau khi §12.5 chỉ ra crop cắt cụt mặt. Bốn phép kiểm
chạy trước khi tốn giờ GPU:

| Kiểm | Kết quả |
|---|---|
| CelebA-Spoof | **525.864** mặt, **0** ảnh hỏng, 13 GB |
| Số shard từng split | 210 / 30 / 24 — khớp bản cũ |
| `face_in_wide` có mặt | **42.000 / 42.000** bản ghi mẫu |
| NUAA + Axon | 5.110 + 989 mặt, **100%** bắt được mặt |

### 13.1 Đường tắt tỉ lệ crop đã đứt

Đo trên 14.000 bản ghi shard thật, qua đúng đường loader lúc train:

| | `P(spoof \| tỉ lệ < 1,0)` | Số mẫu live rơi vào đó |
|---|---|---|
| Trước augment | **0,9774** | 6 |
| **Sau augment** | **0,7009** | **694** |
| *Cơ sở (tỉ lệ spoof chung)* | *0,6595* | |

0,7009 so với cơ sở 0,6595 — tỉ lệ crop gần như hết mang thông tin về nhãn.

Ô vuông trượt cũng tự nó kéo tỉ lệ crop cắt cụt từ **8,8% xuống 1,87%**; phần còn lại là
những ảnh mà hộp mặt lớn hơn cạnh ngắn khung hình, và chúng không thể dựng nổi tỉ lệ 1,0.

### 13.2 Giá phải trả: reader chậm 31%, epoch dài thêm 23%

Ảnh wide lưu ở 224 px nên giải nén tốn gấp ba lần điểm ảnh. Đo cùng điều kiện, chỉ khác
bộ shard:

| Reader | 8 worker | 12 worker | 16 worker |
|---|---|---|---|
| Shard cũ (wide 128) | 1.946 ảnh/giây | 2.819 | — |
| Shard mới (wide 224) | 1.687 | **1.937** | 1.976 |

| Cấu hình | phút/epoch |
|---|---|
| Wide 128, 8 worker | **5,00** |
| Wide 224, 8 worker | 6,65 |
| **Wide 224, 12 worker** | **6,17** |

**Nghẽn là độ trễ I/O, không phải CPU.** GPU chạy ở 6% với 8 worker và 13% với 12; load
giữ ở 6,4 trên 20 nhân; `/mnt/e` đọc khối lớn tới 96,7 MB/s nên đĩa cũng không phải thủ
phạm. `tarfile` đọc nhiều lần nhỏ qua lớp drvfs, và thêm worker không rút ngắn được độ trễ
mỗi lần đọc — đó là vì sao 12 worker chỉ mua được 7% chứ không phải 15% như benchmark hứa.

Giữ 224 px chứ không hạ: `176 / 2,7 = 65 px`, dưới đầu vào 80 của model, nên crop 1,0×
sẽ phải phóng to — đúng điều mà 224 sinh ra để tránh. Đổi lại là **+1,2 giờ GPU** mỗi run.

### 13.3 Batch của student bị arm KD chặn trên

§3.7 buộc hai arm dùng chung batch, nên batch phải là cái arm KD **chứa nổi**, không phải
cái arm nền thích. Đo channels-last trên card 4 GB:

| Batch | Arm nền | Arm KD | VRAM |
|---|---|---|---|
| 256 | 2.617 ảnh/giây | **không vừa** | — |
| 128 | — | **205** ảnh/giây | 2,70 GiB |
| **96** (đang dùng) | 1.735 | 630 | 0,72 / 2,03 GiB |

205 ảnh/giây ở batch 128 là **card đang phân trang chứ không phải đang tính**. Arm nền một
mình thì thích 256 hơn, nhưng lấy 256 là bảng đối chứng mất nghĩa.

`channels_last` cho **2.034 → 2.617** ảnh/giây, và **1.545 → 1.841** khi bước train mang
thêm EMA và grad clipping. Benchmark một bước đọc 1.841 ảnh/giây; epoch thật luôn chạy dưới
trần đó.

LR 0,02 là **scaling tuyến tính theo batch**: 0,05 ứng với 256, và bộ nhớ của arm KD kéo
batch xuống 96.

### 13.4 Batch và layout của teacher CDCN++

Đo channels-last trên card 4 GB:

| Batch | Ảnh/giây | VRAM |
|---|---|---|
| **96** (đang dùng) | 630 | 1,03 GiB |
| 192 | 629 | 2,05 GiB |

Batch lớn hơn **không mua được gì** mà tốn thêm một gigabyte. Ở 630 ảnh/giây, 420k bản ghi
là **11 phút mỗi epoch**, cả run dưới sáu giờ.

`channels_last` cho **515 → 630** ảnh/giây. Mọi convolution ở CDCN++ là 3×3 dày, đúng thứ
kernel channels-last của cudnn sinh ra để chạy.

Teacher là **đầu vào cố định của cả hai arm**, nên §3.7 không ràng buộc batch của nó theo
batch của student.

---

## 14. A0 trên shard ô vuông trượt — được trên dữ liệu, mất trên camera

Run `20260905-0932_ad91c16_73074a`, 60 epoch, seed 42, 09:32 → 15:41 (6 giờ 09 phút).
EER val tốt nhất **0,1199** ở epoch 57, `best_metric = 0,11985`. Đường cong val:

```
ep 1  0,2249    ep 21  0,1832    ep 41  0,1498
ep 11 0,1961    ep 31  0,1626    ep 51  0,1358
                ep 43  0,1374    ep 57  0,1199
```

### 14.1 Trên dữ liệu: tốt hơn ở mọi mục

Hai bộ trọng số chấm lại trên **cùng shard mới, cùng đường code**, nên chênh lệch ở đây chỉ
đến từ trọng số:

| | `20260902-0140` | `20260905-0932` |
|---|---|---|
| val `test:0:10` EER | 0,1406 | **0,1199** |
| `test:10:` AUC | 0,9544 | **0,9658** |
| `test:10:` ACER | 0,1239 | **0,1063** |
| NUAA HTER | 0,1529 | **0,1329** |
| NUAA BPCER | 0,3046 | **0,2561** |

### 14.2 Trên 111 khung camera: tệ hơn ở mọi ngưỡng

Cùng bộ `phone_eval` của §12.2, 76 khung mặt thật và 35 khung tấn công:

| Ngưỡng | `0140` BPCER / APCER / **ACER** | `0932` BPCER / APCER / **ACER** |
|---|---|---|
| 0,50 | 0,0263 / 0,0857 / **0,0560** | 0,1447 / 0,8571 / **0,5009** |
| 0,90 | 0,2368 / 0,0286 / **0,1327** | 0,3684 / 0,3143 / **0,3414** |
| 0,99 | 0,2368 / 0,0286 / **0,1327** | 0,4079 / 0,0000 / **0,2039** |
| 0,997113 | 0,4474 / 0,0000 / **0,2237** | 0,5658 / 0,0000 / **0,2829** |

Ở 0,50 và 0,90 bộ mới thua **cả hai chiều cùng lúc** — không phải đánh đổi ngưỡng.

### 14.3 Nhóm nào hỏng, ở ngưỡng 0,90

| Nhóm | n | `0140` qua | `0932` qua | |
|---|---|---|---|---|
| `live_kho` mặt thật quay nghiêng | 12 | **12/12** | **0/12** | mất sạch |
| `live_xa` | 20 | 2/20 | 4/20 | |
| `live_gan` · `live_vua` · `live_rat_xa` | 44 | 44/44 | 44/44 | giữ |
| `attack_anh` ảnh thẻ trên màn hình | 12 | 0/12 | **6/12** | lọt một nửa |
| `attack_xa` màn hình ở xa | 20 | 0/20 | **4/20** | |
| `attack_gan` | 3 | 1/3 | 1/3 | |

`live_kho` đúng là nhóm sinh ra khiếu nại ban đầu — mặt thật quay nghiêng. Bộ mới từ chối
cả 12 khung, tức nó làm **nặng thêm** chính triệu chứng đang phải chữa.

### 14.4 Axon: mặt nạ và selfie

| Bộ | `0140` | `0932` |
|---|---|---|
| `selfies` BPCER | 0,2917 | 0,5000 |
| `3d_paper_mask` APCER | 0,2778 | 0,3576 |
| `latex_mask` APCER | 0,4000 | 0,4750 |
| `textile_3d_mask` APCER | 0,4239 | 0,4620 |
| `silicone_mask` APCER | 0,4886 | 0,4205 |
| `wrapped_3d_paper` APCER | 0,2000 | 0,1625 |
| `cutout` APCER | 0,0750 | 0,0583 |
| `replay_mobile` APCER | 0,0250 | 0,0375 |
| `replay_display` APCER | 0,0889 | 0,0889 |

Một nửa selfie thật bị từ chối, và mặt nạ vốn đã lọt gần một nửa thì lọt thêm.

### 14.5 Tám khung chụp tay

Chấm lại bằng hình học crop mới, nên điểm khác con số nằm trong tên file:

| Khung | tỉ lệ đạt | `0140` | `0932` |
|---|---|---|---|
| 210043 | 0,705 | 0,9904 | 0,9861 |
| 210051 | 0,911 | 0,6650 | 0,9989 |
| 210059 | 1,000 / 1,636 | 0,9964 | 0,8823 |
| 210115 | 1,000 / 1,816 | 0,9817 | 1,0000 |
| 210124 | 0,740 | 0,9395 | **0,0641** |
| 210133 | 0,999 / 1,590 | 0,3052 | 0,9851 |
| 210309 | 0,881 | 0,1464 | 0,9885 |
| 210317 | 0,998 / 1,824 | 0,7883 | 0,9983 |

Qua ngưỡng 0,90: `0140` 4/8, `0932` 6/8. 🔬 **n=8 và cả tám đều là mặt thật**, nên bảng này
không nói được gì về tấn công — nó chỉ mâu thuẫn bề mặt với §14.3, không bác được §14.3.

### 14.6 Đọc hai bộ số

Bộ mới thắng trên CelebA-Spoof và NUAA, thua trên khung camera. Hai kết quả không mâu thuẫn
vì chúng đo hai thứ khác nhau, và bộ 111 khung mới là bộ gần miền triển khai hơn.

🔬 **Giả thuyết chưa kiểm**: `crop_scale_range: [0.7, 2.7]` ở §13.1 cắt được đường tắt tỉ
lệ, nhưng dải rộng như vậy có thể đồng thời dạy model bỏ qua bối cảnh quanh mặt. Trên
CelebA-Spoof vân in và moiré đủ để phân biệt; trên khung điện thoại ở cự ly này thứ tố cáo
`attack_anh` lại là viền màn hình và khung trình duyệt — nằm đúng phần bối cảnh đó. Kiểm
được bằng một run A0 thu hẹp dải, mọi điều kiện khác giữ nguyên.

**Chưa chốt A0.** Bảng đối chứng §3.7 chỉ có nghĩa khi arm nền dùng được, mà một nửa
`attack_anh` lọt ở ngưỡng 0,90 thì chưa.

---

## 15. Vì sao A0 hỏng: augment một chiều không có cổng

§14.6 đặt giả thuyết rằng dải `[0.7, 2.7]` dạy model bỏ qua bối cảnh. Đo xong thì cơ chế
khác với giả thuyết, và sắc hơn.

### 15.1 Phép cắt chỉ thu nhỏ được, nên nó dời phân bố chứ không mở rộng

`crop_scale` không thể bịa thêm phần khung hình ảnh gốc không chứa — nó chỉ cắt bớt. Rút
đều trong `[0.7, 2.7]` khi tỉ lệ lưu sẵn có trung vị 1,91 nghĩa là gần như mọi lần rút đều
làm hẹp lại. Đo trên 4.000 bản ghi qua đúng loader lúc train:

| | Train (có augment) | Val / kiosk |
|---|---|---|
| `wide_scale` trung vị | **1,44** | 1,91 |
| \|tight − wide\| trung bình | **31,4** | 57,2 |
| Mẫu có wide không rộng hơn tight | **17,7%** | 2,4% |

Nhánh wide mất 45% lượng thông tin phân biệt nó với nhánh tight, và gần một mẫu trên năm
thì hai nhánh nhìn cùng một cảnh. Nhìn ảnh dựng ra thì thấy thẳng: ô val còn cả người, cả
tường, cả chữ trên nền; ô train hai bên gần như trùng nhau.

### 15.2 Lỗi thật là thiếu cổng xác suất, không phải sai dải

Quét toàn bộ augment của nhánh, kiểm xem trung vị của val có nằm trong dải p10–p90 của
train không — tức tập train có còn chứa điều kiện lúc suy luận không:

| Đại lượng | val trung vị | train p10 | train p90 | Val còn nằm trong? |
|---|---|---|---|---|
| Độ sáng | 123,0 | 78,0 | 161,3 | có, ở giữa |
| Độ tương phản | 54,3 | 29,2 | 62,1 | có |
| Độ nét | 13,9 | 6,5 | 21,4 | có, ở giữa |
| Tỉ lệ crop | 1,91 | 0,90 | 2,17 | **sát mép trên** |
| \|tight − wide\| | 57,9 | 3,5 | 58,5 | **sát mép trên** |

Augment quang học và augment nén đều có cổng `p = 0,5`, nên mẫu sạch vẫn nằm trong tập
train và val rơi vào giữa. **Tỉ lệ crop là phép duy nhất áp cho 100% mẫu** — không cổng — và
nó là phép duy nhất đẩy điều kiện kiosk ra vùng đuôi.

Tính thẳng phân vị mà điều kiện kiosk rơi vào bên trong phân bố train:

| Chính sách | Phân vị của \|tight − wide\| | Phân vị của tỉ lệ |
|---|---|---|
| `uniform [0.7, 2.7]`, không cổng | **74,3** | **80,6** |
| `p = 0,15` trong `[0.7, 1.2]` | 57,8 | 57,8 |

Chỉ khoảng một phần tư số mẫu train có đủ ngữ cảnh như một khung kiosk điển hình. Bài học
tổng quát: **augment một chiều bắt buộc phải có cổng**, nếu không nó dời tập train khỏi
điều kiện vận hành thay vì bao lấy điều kiện đó.

### 15.3 Quét tỉ lệ lúc suy luận — bằng chứng nhánh wide chưa học được gì

Chấm 111 khung camera trong khi đổi tỉ lệ dựng nhánh wide:

| wide | `0140` ACER | `0932` ACER |
|---|---|---|
| 1,0 | 0,5137 | 0,3658 |
| 1,4 | 0,2429 | 0,6611 |
| 1,8 | 0,4316 | 0,6006 |
| 2,2 | 0,2776 | 0,4015 |
| **2,7** | **0,1327** | 0,3414 |

`0140` có đỉnh rõ tại 2,7 — đúng tỉ lệ nó được train, tức nó *có* dùng bối cảnh. `0932`
không có đỉnh ở đâu cả, kể cả tại 1,4 là trung vị nó quen. Bỏ đói nhánh wide không chỉ dời
điểm vận hành mà làm nhánh đó không học được gì; đưa tỉ lệ nào vào cũng vậy.

### 15.4 Chính sách đã chốt

Đo bốn chính sách trên 6.000 bản ghi train. Cơ sở `P(spoof)` = 0,6588:

| Chính sách | \|t − w\| | `P(spoof \| < 1,0)` | live < 1,0 |
|---|---|---|---|
| Tắt hẳn | 57,7 | 0,9690 | 4 |
| `uniform [0.7, 2.7]` | 42,0 | 0,6780 | 323 |
| **`p=0,15` trong `[0.7, 1.2]`** | **50,9** | **0,7186** | **188** |
| `p=0,15` + rung nhẹ ×`[0.85, 1.0]` | 47,5 | 0,7059 | 230 |

Giữ 88% ngữ cảnh so với bản không augment mà vẫn kéo đường tắt từ 0,969 về 0,719. Tắt hẳn
thì đường tắt quay lại nguyên vẹn, và **bốn trong tám khung chụp tay** nằm dưới 1,0
(0,705 · 0,740 · 0,881 · 0,911) nên triệu chứng cũ sẽ tái phát.

🔬 Chưa có gì chứng minh chính sách này chữa được 111 khung. Nó chỉ đưa thống kê ngữ cảnh
về sát cấu hình đã biết là tốt; bằng chứng thật chỉ có sau khi train xong.

---

## 16. A0 sau khi có cổng — 5/6 mốc đạt

Run `20260905-1740_865b5d0_64c387`, 60 epoch, seed 42, 17:40 → 00:16 (6 giờ 36 phút).
EER val tốt nhất **0,1297** ở epoch 59, tức chính epoch cuối — đuôi cosine còn giảm tới lúc
hết lịch. Sáu mốc dưới đây chốt **trước** khi thấy kết quả.

### 16.1 Bảng mốc

| # | Mốc | Kết quả | |
|---|---|---|---|
| 1 | `live_kho` mặt thật xoay nghiêng 12/12 @0,90 | **12/12** | ✅ |
| 2 | `attack_anh` ảnh thẻ trên màn hình 0/12 lọt | **0/12** | ✅ |
| 3 | ACER 111 khung @0,90 ≤ 0,133 | **0,1184** | ✅ |
| 4 | Axon `replay_*` APCER ≤ 0,09 | **0,0889 / 0,0125** | ✅ |
| 5 | Axon `selfies` BPCER ≤ 0,29 | **0,4167** | ❌ |
| 6 | EER val ≤ 0,14 | **0,1297** | ✅ |

### 16.2 Ba bộ trọng số trên 111 khung camera

| Ngưỡng | | `0140` cũ | `0932` không cổng | **`1740` có cổng** |
|---|---|---|---|---|
| 0,50 | BPCER / APCER / **ACER** | 0,0263 / 0,0857 / **0,0560** | 0,1447 / 0,8571 / **0,5009** | 0,1316 / 0,1714 / **0,1515** |
| **0,90** | BPCER / APCER / **ACER** | 0,2368 / 0,0286 / **0,1327** | 0,3684 / 0,3143 / **0,3414** | 0,2368 / **0,0000** / **0,1184** |
| 0,99 | BPCER / APCER / **ACER** | 0,2500 / 0,0286 / **0,1393** | 0,4079 / 0,0000 / **0,2039** | 0,2500 / 0,0000 / **0,1250** |

Ở 0,90 bộ vá **trội hơn `0140` theo nghĩa chặt**: cùng tỉ lệ từ chối mặt thật, mà không đòn
tấn công nào lọt. Ở 0,50 thì `0140` vẫn hơn — điểm vận hành quyết định câu trả lời.

### 16.3 Nhóm nào đổi

| Nhóm | n | `0140` | `0932` | **`1740`** |
|---|---|---|---|---|
| `live_kho` mặt thật nghiêng | 12 | 12/12 | **0/12** | **12/12** |
| `live_gan` · `live_vua` · `live_rat_xa` | 44 | 44/44 | 44/44 | 44/44 |
| `live_xa` | 20 | 2/20 | 4/20 | 2/20 |
| `attack_anh` | 12 | 0/12 | **6/12** | **0/12** |
| `attack_xa` | 20 | 0/20 | 4/20 | **0/20** |
| `attack_gan` | 3 | 1/3 | 1/3 | **0/3** |

`live_kho` quay lại 12/12 và `attack_gan` lần đầu sạch 0/3 — lỗ §12.3 đóng lại. Chẩn đoán
§15 được xác nhận: cổng xác suất là thứ thiếu, không phải dải sai.

### 16.4 Trên dữ liệu và khác miền

| | `0140` | `0932` | **`1740`** |
|---|---|---|---|
| val `test:0:10` EER | 0,1406 | **0,1199** | 0,1297 |
| `test:10:` ACER | 0,1239 | **0,1063** | 0,1159 |
| NUAA HTER | 0,1529 | 0,1329 | **0,0764** |
| NUAA BPCER | 0,3046 | 0,2561 | **0,1356** |
| Axon `selfies` BPCER | **0,2917** | 0,5000 | 0,4167 |
| Axon `replay_display` APCER | 0,0889 | 0,0889 | 0,0889 |
| Axon `replay_mobile` APCER | 0,0250 | 0,0375 | **0,0125** |

NUAA HTER giảm một nửa và BPCER giảm từ 30% xuống 14% — chuyển miền tốt hơn hẳn cả hai bộ
trước. Đây là bằng chứng độc lập với 111 khung.

### 16.5 Mốc 5 trượt, nhưng bộ đo quá nhỏ để kết luận

`selfies` có **n = 24**. BPCER 0,4167 là 10/24, mốc 0,2917 là 7/24 — chênh đúng **ba khung**.
Độ lệch chuẩn nhị thức ở n=24, p=0,29 là 0,093, nên khoảng cách này là 1,34σ: không phân
biệt được với nhiễu. 🔬 **Ghi là trượt vì mốc đặt trước là trượt**, không diễn giải lại thành
đạt; nhưng cũng không đủ cơ sở để nói bộ vá kém hơn ở chuyển miền — NUAA, n=5.110, nói ngược
lại rõ ràng.

### 16.6 Hai chỗ chưa mượt

**`live_xa` vẫn 2/20.** Không bộ nào qua được, kể cả `0932`. Bản vá không đụng tới: mặt ở xa
thì kết cấu không đủ phân giải để đọc, đây là hạn chế của crop 80 px chứ không phải augment.

**Tám khung chụp tay chỉ 2/8 qua @0,90**, so với 4/8 của `0140`:

| Khung | `0140` | `0932` | `1740` |
|---|---|---|---|
| 210115 | 0,9817 | 1,0000 | **0,9999** |
| 210309 | 0,1464 | 0,9885 | **0,9972** |
| 210124 | 0,9395 | 0,0641 | 0,8959 |
| 210043 | 0,9904 | 0,9861 | 0,8949 |
| 210051 | 0,6650 | 0,9989 | 0,8283 |
| 210059 | 0,9964 | 0,8823 | 0,6948 |
| 210317 | 0,7883 | 0,9983 | 0,4820 |
| 210133 | 0,3052 | 0,9851 | **0,0271** |

Bốn khung nằm trong dải 0,83–0,90, nên ngưỡng 0,80 cho 5/8. 🔬 **n=8, cả tám là mặt thật**,
không có khung tấn công nào để cân — bảng này không tự nó chọn được ngưỡng. Nó nói rằng
ngưỡng tối ưu trên 111 khung chưa chắc tối ưu ở cự ly gần, và đó là câu hỏi chỉ tập tự thu
bằng OV5640 trả lời được.

### 16.7 Chốt

A0 dùng được: 5/6 mốc đạt, mốc trượt duy nhất nằm trên bộ 24 mẫu. Bộ trọng số
`20260905-1740_865b5d0_64c387` là arm nền cho bảng đối chứng §3.7. Ngưỡng vận hành tạm đặt
**0,90**; nó chưa phải ngưỡng nghiệm thu vì chưa đo trên miền thiết bị.

---

## 17. Sinh lại shard bằng hộp detector — kiểm nhận

Shard cũ cắt theo cột `Bbox` của CelebA-Spoof, còn kiosk chỉ có hộp YuNet. §15 và §16 đã
vá phía augment; mục này vá phía dữ liệu và nghiệm thu trước khi tiêu 6,5 giờ GPU.

### 17.1 Số lượng — mọi con số tự khớp

`523.370` mặt từ 167 shard parquet, `0` ảnh không giải mã được, `2.494` ảnh detector không
thấy mặt.

| Split | Hộp chú thích | Hộp detector | Mất | Tỉ lệ |
|---|---|---|---|---|
| train | 419.935 | 417.816 | 2.119 | 0,505% |
| valid | 46.738 | 46.482 | 256 | 0,548% |
| test | 59.191 | 59.072 | 119 | 0,201% |
| **Tổng** | **525.864** | **523.370** | **2.494** | **0,474%** |

2.494 khớp đúng con số builder tự báo, nên không có bản ghi nào rơi vì lý do khác.

### 17.2 Hai hộp lệch nhau bao nhiêu

Đo trên 8.782 bản ghi ghép cặp theo tên, chỉ lấy bản ghi bị khung hình cắt cụt ở **cả hai**
bản dựng — ở đó `wide_scale` là `min(W,H)/cạnh mặt` với cùng một ảnh, nên thương của hai
bên khử sạch phần còn lại:

| | p10 | p50 | p90 |
|---|---|---|---|
| Cạnh hộp detector / cạnh hộp chú thích | 0,939 | **1,029** | 1,124 |

**77,4%** số hộp lệch quá 2%. Đây là độ lệch hệ thống nằm trên gần ba phần tư số crop model
từng học, trong khi §16 đã đo rằng xê dịch 2% làm mất 15% số khung mặt thật.

`face_in_wide` **không** dùng được cho phép đo này: nó chuẩn hoá theo cạnh crop, mà cạnh
crop lại tỉ lệ với chính cạnh mặt, nên tỉ lệ đo bằng nó ra 1,011 — gần như mù với thứ cần đo.

| `wide_scale` | Hộp chú thích | Hộp detector |
|---|---|---|
| p50 | 2,034 | 1,943 |
| Tỉ lệ chạm trần 2,7× | 25,3% | 22,2% |

Hộp to hơn thì trần hình học chặn sớm hơn, đúng như §13 dự đoán.

### 17.3 Bỏ ảnh không thấy mặt có làm lệch cân bằng nhãn không

Không. Đây là rủi ro phải loại trước khi tin `live_weight`, vì detector trượt lệch một lớp
sẽ âm thầm làm sai trọng số mất mát.

| Tỉ lệ spoof/live | Hộp chú thích | Hộp detector |
|---|---|---|
| train | 1,884 | **1,877** |
| test | 2,628 | 2,598 |

`live_weight = 1,97` giữ nguyên. Nó vốn đã lệch ~5% so với 1,88 từ trước; sửa lúc này sẽ
thêm một điều kiện thay đổi và làm bảng đối chứng với `0057` mất nghĩa (KẾ HOẠCH §4.2).

### 17.4 Cổng crop-scale bắn đúng tỉ lệ, và mù nhãn

Kiểm lại trên shard mới, 12.000 mẫu mỗi chế độ. Tỉ lệ bản ghi rơi vào `[0,7; 1,2]`:

| | Tự nhiên | Dự đoán ở cổng 0,15 | Đo được |
|---|---|---|---|
| live | 0,0239 | 0,1703 | **0,1669** |
| spoof | 0,1127 | 0,2458 | **0,2446** |

Sai số 0,002 trên cả hai lớp. Cổng rút từ **một** phân phối cho cả hai, nên nó không nhân
thêm phần chênh sẵn có của nguồn — dữ liệu nguồn vốn đã cho spoof khả năng nằm dưới 1,2×
cao gấp 4,7 lần, và cổng kéo tỉ số đó xuống 1,47.

### 17.5 Tốc độ dựng

Bản đầu chạy **22 ảnh/giây** trong khi detector một mình đạt 101. Nguyên nhân đo được: giải
mã PNG 9,8 ms và forward 9,9 ms **cùng chạy nối tiếp trên tiến trình chính**, 8 worker mã
hoá ngồi không. Tách bước letterbox cho pool và gộp forward theo lô 256 đưa lên **178 bản
ghi/giây** khi chạy dài — toàn bộ 523 nghìn mặt hết 45 phút thay vì 6,5 giờ.

Con số 69 ảnh/giây benchmark trên 2.000 dòng thấp hơn thực tế vì gánh cả thời gian nạp
model và khởi động CUDA.

---

## 18. Hộp lệch 5% làm sập điểm — viền đen thì không

Trên bộ 111 khung, toàn bộ 18 khung live trượt của `0140` nằm gọn trong một nhóm:

| Nhóm | Mặt (px) | Chỗ còn cho context | Qua @0,90 |
|---|---|---|---|
| `live_rat_xa` | 163 | 3,11× | **20/20** |
| `live_xa` | 216 | 2,35× | **2/20** |

Mặt `live_xa` **to hơn** mà lại trượt, nên không phải chuyện khoảng cách.

### 18.1 Phép thử tách một biến

Mỗi khung chạy qua đúng một xử lý, giữ nguyên mọi thứ còn lại. `0140`, 20 khung mỗi nhóm:

| Xử lý | `live_rat_xa` | `live_xa` |
|---|---|---|
| Nguyên khung (còn viền đen) | 0,999 · **100%** qua | 0,756 · 10% qua |
| Bỏ viền đen, không làm gì thêm | 0,523 · **0%** qua | 0,899 · 50% qua |

Bỏ viền đen **phá sập** nhóm đang qua sạch, nhưng lại **cứu** nhóm đang trượt. Hai chiều
ngược nhau nên viền đen không thể là biến giải thích.

### 18.2 Cái thật sự đổi là cái hộp

Đo trên 8 khung `live_rat_xa`, so hộp trước và sau khi bỏ viền:

| | Trung vị |
|---|---|
| Điểm đen trong crop wide, **cả hai bên** | **0,0000** |
| Cạnh hộp sau / trước | **0,950** |
| Tâm hộp xê dịch, theo cạnh mặt | **0,028** |
| Điểm | 0,999 → **0,523** |

Crop **không chứa một điểm đen nào** ở cả hai phía của phép so. Thứ duy nhất đổi là hộp:
nhỏ đi 5%, tâm lệch 2,8%. Bỏ viền làm đổi tỉ lệ khung 16:9 thành ~5:7, detector letterbox
khác đi, và hộp nó trả về lệch đi chừng đó.

**Đây là bằng chứng nhân quả sạch nhất cho §17 và cho augment dịch chuyển**: model sập vì
hộp rung vài phần trăm, đúng lượng mà §17.2 đo được giữa hộp chú thích và hộp detector
(trung vị 1,029, 77,4% lệch quá 2%).

Nhóm `live_xa` thì crop wide có **23,2%** điểm đen và ngồi ở 0,756, trong khi nhóm không
đen ngồi ở 0,999 — viền đen vẫn có hại, chỉ là hại ít hơn hẳn so với hộp lệch.

### 18.3 Hệ quả cho `cam_bridge`

Bản cắt viền trong `cam_bridge.py` bỏ được 23,2% điểm đen kia, nhưng đồng thời đổi tỉ lệ
khung và làm lệch **mọi** hộp chừng 5% — đúng lượng vừa làm sập 0,999 → 0,523. Nó là một
đánh đổi, không phải một bản vá thuần tuý, và chỉ có lợi khi model đã chịu được hộp rung.
Phải đo lại sau khi có model train bằng hộp detector; chưa chốt.

---

## 19. Còn nợ

- **Tập tự thu bằng OV5640** (KẾ HOẠCH §1.2, ≥500 ảnh mỗi loại). Phần cứng đã sẵn sàng và
  đường lấy ảnh đã thông; chỉ còn khâu ngồi thu. Đây là thứ chặn ba câu hỏi cùng lúc: giả
  thuyết tư thế, ngưỡng vận hành thật, và cổng nghiệm thu đo trên miền thiết bị.
- **Teacher CDCN++ chưa train lại** trên shard mới với augment đã vá — thứ chặn arm A3.
- **Mọi số ở §5, §6, §9–§12 đo trên hình học crop cũ** nên chỉ còn giá trị lịch sử: shard
  đã sinh lại ở §13. Thứ tự còn lại là A0 dùng được → teacher → A3 → điền §5 → ADR.
- **Teacher chưa train lại** trên crop mới. Nó không cần sửa code — `boxes()` đã tham số
  hoá theo tỉ lệ thật và xử lý đúng cả vùng dưới 1,0 (tỉ lệ mặt bão hoà ở 1,000, `ref mean`
  tăng đơn điệu 0,0585 → 0,6255) — nhưng nó đọc cùng shard nên cùng phải chạy lại. Chỉ
  chặn A3, không chặn A0.
- **Ngưỡng 0,997355 phải đo lại.** Trên 51 khung, 0,992728 cho 100%/100%; nhưng đó là
  ngưỡng khớp trên chính bộ đó, và bộ đó có 51 khung.
- **A0 chưa có bản đối chứng tắt augment nén.** Đã đo rằng nó không phá hỏng gì, nhưng
  chưa đo rằng nó giúp. Muốn chắc thì cần một run A0 với `recompress_probability: 0`.
- **Run `20260906-0944` gộp ba thay đổi** so với `0057`: hộp detector (§17), augment dịch
  chuyển, và phơi sáng đối xứng. Kết quả — tốt lên hay xấu đi — đều không quy được cho
  thay đổi nào. Tách sạch tốn ba run nữa, khoảng 19,5 giờ; chỉ làm nếu con số bắt buộc.
- UniqueData live + replay: hai bộ khác miền còn lại chưa chấm, cả hai là video nên cần
  giải khung hình như Axon.
- `export_soft_target.py`, `postproc/preproc.py`, `postproc/emit_golden.py`, `quant.py`,
  `README.md` — §4.4 đã khai, chưa viết.
- Thang lượng tử hoá §3.8.

---

## 20. Lệnh chấm bộ 111 khung nằm trong repo — kiểm nhận

Mọi bảng trên bộ `phone_eval` ở §12, §14, §16 chấm bằng script tạm đã mất. Từ 11/09 `eval.py`
có chế độ `--frames`: đi qua detector, lấy hộp lớn nhất, cắt hai crop bằng `fitted_box` với
vòng JPEG q95 y như shard, chấm ở ba ngưỡng 0,50 / 0,90 / 0,99 và in số qua/chặn theo thư mục:

```bash
cd ml && .venv/bin/python -m facepipe.tasks.antispoof.eval \
  --run artifacts/antispoof/runs/<run> \
  --frames /mnt/e/face-attendance-data/interim/antispoof/phone_eval \
  --detector artifacts/detection/runs/20260831-1616_cc931df_36fbea/ckpt/best.pth
```

Kiểm nhận: bản `1740` không nạp được vào code hiện tại (PReLU, 80 px, `MEAN` đã bỏ), nên
chạy cùng vòng chấm đó trên worktree của commit `865b5d0`. Kết quả **trùng từng số** với §16.2
và §16.3: @0,50 BPCER 0,1316 / APCER 0,1714 / ACER 0,1515 · @0,90 0,2368 / 0,0000 / **0,1184** ·
@0,99 0,2500 / 0,0000 / 0,1250; `live_kho` 12/12, `live_xa` 2/20, `attack_anh` 0/12 lọt,
`attack_gan` 0/3 lọt ở 0,90. Run mới `20260909-1116` (ReLU, 81 px) chấm bằng đúng lệnh trên
khi train xong, và so thẳng với bảng §16.2.

---

## 21. Run ReLU 81 px chấm xong 60 epoch — chưa thay được `1740`

Chuỗi resume `20260910-0947` → `1043` → `1538` → `20260911-1112_a3fd8e1_526ccc` chạy hết
60 epoch lúc 14:00 ngày 11/09. Val trên mirror CelebA-Spoof đi xuống đều tới epoch cuối:

| epoch | 37 | 39 | 53 | 55 | 57 | **59** |
|---|---|---|---|---|---|---|
| val EER | 0,1604 | 0,1561 | 0,1584 | 0,1554 | 0,1535 | **0,1526** |
| val AUC | 0,9277 | 0,9306 | 0,9333 | 0,9351 | 0,9361 | **0,9363** |

`best.pth` là epoch 59. Chấm bộ 111 khung bằng đúng lệnh §20:

| Ngưỡng | | epoch 37 | **epoch 59** | `1740` (§16.2) |
|---|---|---|---|---|
| 0,50 | BPCER / APCER / **ACER** | 0,6711 / 0,0286 / **0,3498** | 0,4342 / 0,0286 / **0,2314** | 0,1316 / 0,1714 / **0,1515** |
| **0,90** | BPCER / APCER / **ACER** | 0,8289 / 0,0000 / **0,4145** | 0,6842 / 0,0000 / **0,3421** | 0,2368 / 0,0000 / **0,1184** |
| 0,99 | BPCER / APCER / **ACER** | 1,0000 / 0,0000 / **0,5000** | 0,8421 / 0,0000 / **0,4211** | 0,2500 / 0,0000 / **0,1250** |
| | EER / AUC | 0,4523 / 0,6289 | **0,1712 / 0,8917** | — |

**Chưa đạt.** Ở điểm vận hành 0,90 bản mới chặn sạch mọi đòn tấn công nhưng **từ chối 68%
mặt thật** (BPCER 0,6842 so với 0,2368 của `1740`), tức ACER gấp **2,9 lần**. Theo §4.2 của
`CLAUDE.md`, model chọn theo số trên miền thiết bị chứ không theo val, nên run này **không
thay được gì** — và cũng chưa có gì để thay: `firmware/models/antispoof/` rỗng,
`contracts/models.lock.json` không có dòng antispoof, còn `1740` thì §20 đã ghi là không nạp
được vào code hiện tại (PReLU, 80 px, `MEAN` đã bỏ).

**Nhóm nào hỏng** — ở ngưỡng 0,90, kèm cỡ mặt đo bằng chính detector:

| Nhóm | n | cạnh mặt (px) | epoch 37 | **epoch 59** |
|---|---|---|---|---|
| `live_gan` | 12 | 686–700 | 12/12 | **12/12** |
| `live_vua` | 12 | **347–350** | 0/12 | **0/12** |
| `live_kho` | 12 | 316–319 | 0/12 | **11/12** |
| `live_xa` | 20 | 202–234 | 1/20 | **1/20** |
| `live_rat_xa` | 20 | 162–164 | 0/20 | **0/20** |
| ba nhóm tấn công | 35 | 117–2026 | 34/35 chặn | **35/35 chặn** |

**Không khung nào nằm ngoài miền phục vụ, và cỡ mặt không giải thích được kiểu hỏng.** Cạnh
nhỏ nhất trong cả bộ là 117 px, trên cả cổng recog 113 px lẫn cổng spoof 81 px của §3, nên
`--min-face-px 113` không rơi khung nào và ACER ở trên không phải chấm nhầm vào những khung
kiosk vốn loại ở bước `FACE_SMALL`. Quan trọng hơn: `live_vua` **347 px rớt sạch 0/12** trong
khi `live_kho` 316 px qua 12/12 và `live_xa` 218 px qua 17/20 ở ngưỡng 0,50 — **nhỏ hơn mà
lại qua**. Giới hạn phân giải thì phải đơn điệu theo cỡ; cái này không đơn điệu, nên nguyên
nhân nằm ở điều kiện chụp của từng nhóm chứ không ở khoảng cách.

Công thức `side ≈ 47,7/d` của §3 dựng cho OV5640 ở HVGA nên **không quy được px của bộ này
ra mét**: `phone_eval` chụp bằng điện thoại, khác độ phân giải và góc nhìn. Quy được là px
tuyệt đối, và px tuyệt đối thì đủ ở mọi nhóm.

**Nhưng hướng đi đúng, chỉ là chưa tới.** 23 epoch cuối kéo EER trên miền thiết bị từ
**0,4523 xuống 0,1712** và AUC từ 0,6289 lên 0,8917, trong khi val gần như đứng yên
(0,1604 → 0,1526). Nghĩa là model vẫn đang học đặc trưng tổng quát chứ không phải học thuộc
val, và lịch 60 epoch **hết trước khi đường cong phẳng**. `live_kho` đi từ 0/12 lên 11/12
trong đúng 23 epoch đó là bằng chứng rõ nhất.

Hai đường tiếp, chưa chọn: kéo dài lịch train quá 60 epoch trên đúng cấu hình này (~2,5 giờ
mỗi 23 epoch, rẻ, và số liệu đang ủng hộ), hoặc đi theo kết luận của ADR 0002 là **thu dữ
liệu bằng chính OV5640** (E3-T8) vì khoảng cách đo được nằm ở miền dữ liệu.

---

## 22. Vì sao `live_vua` rớt: nhánh wide phân loại căn phòng — đo 11/09

Từ §21: `live_vua` 347 px rớt 0/12 trong khi `live_kho` 316 px qua 12/12, tức không phải
khoảng cách. Chấm từng khung với các view bị cắt bỏ, model epoch 59, CPU:

| Nhóm | full (tight+wide) | **tight+tight** | wide+wide | tight+xám |
|---|---|---|---|---|
| `live_vua` | 0,20 | **0,98** | **0,01** | 0,15 |
| `live_rat_xa` | 0,36 | **0,83** | **0,04** | 0,12 |
| `live_xa` | 0,72 | 0,53 | 0,33 | 0,05 |
| `live_kho` | 0,94 | 0,90 | 0,84 | 0,03 |
| `live_gan` | 0,99 | 1,00 | 0,99 | 0,64 |
| `attack_anh` | 0,25 | 0,35 | **0,77** | 0,02 |
| `attack_xa` | 0,14 | 0,17 | **0,65** | 0,03 |

Hai điều đọc ra ngay. Với mặt thật, **view wide là thứ kéo điểm xuống**: `live_vua` nhìn
mặt không thì 0,98, nhìn nền không thì 0,01. Với tấn công thì ngược lại, **view tight mới
mang tín hiệu**: `attack_xa` nhìn mặt không vẫn bị chặn (0,17), nhìn nền không thì lọt
(0,65). Nghĩa là nhánh tight làm đúng việc; nhánh wide đang phán theo nền.

### 22.1 Nhân quả: đổi nền là đổi kết luận

Cùng khung 006 của mỗi nhóm, giữ nguyên view tight, chỉ đổi phần nền của view wide:

| Thao tác trên nền wide | `live_vua` | `live_rat_xa` | `live_kho` |
|---|---|---|---|
| Nguyên bản | 0,211 | 0,354 | 0,972 |
| Làm mờ Gauss r24, giữ vành 1,3× | **0,784** | **0,973** | 0,958 |
| Phẳng màu tường, mép sắc | 0,004 | 0,025 | **0,006** |
| Phẳng màu gỗ, mép sắc | 0,009 | 0,005 | 0,037 |
| Mặt nhóm này ghép lên nền `live_kho` | **0,803** | **0,953** | — |
| Mặt `live_kho` ghép lên nền `live_vua` | — | — | **0,221** |
| Mặt `live_xa` ghép lên nền `live_vua` | 0,252 | | |

Nền của `live_vua` và `live_rat_xa` là **cánh cửa gỗ nan dọc màu nâu đậm, viền thẳng**;
nền của `live_kho` và `live_xa` chủ yếu là tường trắng. Nền phẳng có mép cắt sắc hạ cả
`live_kho` xuống 0,006: một hình vuông sắc quanh mặt chính là dấu "ảnh cắt dán".

### 22.2 Không sửa được ở suy luận

Quét tỉ lệ wide trên cả bộ, ngưỡng 0,90:

| wide | BPCER | APCER | ACER | `live_kho` | `live_vua` | `live_rat_xa` | `live_xa` |
|---|---|---|---|---|---|---|---|
| 1,0× | 0,5658 | 0,0000 | 0,2829 | 6/12 | 12/12 | 2/20 | 1/20 |
| 1,4× | 0,3553 | 0,0571 | 0,2062 | 0/12 | 12/12 | 20/20 | 5/20 |
| 1,8× | 0,7500 | 0,0286 | 0,3893 | 4/12 | 0/12 | 1/20 | 2/20 |
| 2,2× | 0,6711 | 0,0000 | 0,3355 | 12/12 | 0/12 | 0/20 | 1/20 |
| 2,7× | 0,6842 | 0,0000 | 0,3421 | 11/12 | 0/12 | 0/20 | 1/20 |

Không mốc nào giữ được cả năm nhóm mặt thật; 1,4× cứu `live_vua` và `live_rat_xa` nhưng
giết `live_kho` và cho tấn công lọt. Mờ nền lúc suy luận trên cả bộ (giữ vành 1,0–1,6×, r12–24)
chỉ kéo ACER từ 0,3421 xuống 0,2763–0,3026, `live_vua` vẫn 0–3/12. Nhánh wide **giòn**, không
có tiền xử lý nào ổn định được nó.

### 22.3 Model học điều đó từ đâu

Mở 20 view wide đầu của shard train: mẫu tấn công là người **cầm ảnh in hay điện thoại trong
phòng thường** — trần ô, cửa, tường, tay; mẫu thật là **ảnh sự kiện của người nổi tiếng** —
phông studio, banner tài trợ, bokeh. Thống kê nền ngoài hộp mặt trên 1.950 mẫu đầu không
tách bằng độ sáng hay mật độ cạnh (thật 14,0 / tấn công 12,7), nên đường tắt nằm ở **kiểu
cảnh**, không ở một con số đơn lẻ. Kiosk đứng trong đúng một căn phòng thường.

Hai ghi chú về chính bộ `phone_eval`: mỗi thư mục là **một clip** (kích thước file đồng
đều, tên tuần tự), nên 12 khung là một điều kiện chụp chứ không phải 12 mặt độc lập; và
khung là video dọc nhồi vào 1280×720 với **hai dải đen**, `fitted_box` kéo dải đen vào crop
— kiosk thật không có dải đen này (§3 đã ghi ở mục "tiền kiểm hình học").

### 22.4 Sửa

Augment **hoán nền** trong tập train: phần view wide ngoài vành 1,5× quanh mặt thay bằng
view wide của một mẫu khác trong luồng, rút bất kể nhãn, mép hoà Gauss 12% cạnh mặt, cổng
`p = 0,5`. Lý do từng ràng buộc ở KẾ HOẠCH §3 lớp 2. Nhánh đối chứng: run `20260911-1411`
(không hoán nền, cùng checkpoint gốc epoch 59, cùng lịch 60 → 90) — hai run khác đúng một
biến. Nghiệm thu bằng lệnh §20, cả BPCER lẫn APCER.

### 22.5 Nhánh 1,5× / p 0,5 không dịch chuyển cơ chế — đo giữa run, 15:45

Run `20260911-1438` (hoán nền `keep 1,5×`, `p 0,5`, nhãn cho mượn theo luồng) fine-tune từ
`best.pth` epoch 59, chấm `best.pth` của nó lúc epoch 68 — đang ở đỉnh LR của warm restart,
nên ACER tuyệt đối so với epoch 59 là so lệch pha; cột đáng đọc là bảng cắt bỏ view:

| Nhóm | full | t+t | w+w | | full epoch 59 | w+w epoch 59 |
|---|---|---|---|---|---|---|
| `live_vua` | 0,16 | 0,97 | **0,03** | | 0,20 | 0,01 |
| `live_rat_xa` | 0,41 | 0,71 | 0,23 | | 0,36 | 0,04 |
| `live_xa` | 0,32 | 0,82 | 0,11 | | 0,72 | 0,33 |
| `live_kho` | 0,85 | 0,94 | 0,51 | | 0,94 | 0,84 |

Nhánh wide vẫn phủ quyết `live_vua` y như trước; ACER @0,90 0,4079, `live_vua` 0/12 ở mọi
ngưỡng. Val trong lúc đó **tốt hơn** (EER 0,1407 so với 0,1602 của đối chứng cùng epoch) — val
là split cùng lệch cảnh, nên nó không đo được điều này.

Vì sao gần như không tác dụng — đo trên ba shard train (6.000 mẫu):

| | `wide_scale` p10 / p50 / p90 | keep 1,5×: diện tích hoán đổi p50 | keep 1,2× |
|---|---|---|---|
| thật | 1,41 / **2,02** / 2,70 | 45% | 65% |
| tấn công | 1,19 / **1,77** / 2,69 | **28%** | 54% |

`keep_scale` tính theo cạnh mặt, nhưng view wide chỉ đạt ~1,8–2,0× mặt ở trung vị, nên vành
1,5× phủ 73–84% cạnh view và phần hoán đổi là một dải mỏng bên ngoài. Nan cửa sát đầu người
trong `live_vua` nằm trong vùng giữ. Thêm vào đó, mẫu cho mượn rút theo tỉ lệ luồng (≈ 2 tấn công
: 1 thật) nên nền hoán vào vẫn nghiêng về cảnh phòng thường.

Nhánh kế: `keep 1,2×`, `p 0,7`, nhãn cho mượn rút 50/50 từ hai vòng riêng; cùng checkpoint
gốc, cùng lịch 60 → 90. Run `1438` dừng ở epoch 68; `1411` vẫn là đối chứng.

Ghi chú nhãn: trong code `LIVE = 0`, `SPOOF = 1`; hai bảng thống kê shard ở §22.3 và §22.5 đọc nhãn theo
hằng đó. Luồng train là ≈ 2 tấn công : 1 thật, và mẫu **thật** là bên có nhiều ngữ cảnh hơn.

---

## 23. Tổng liều augment của run một-backbone — tính từ config, 11/09

`config.resolved.yaml` của `20260911-1634_d3b227e_325fb6`: lật 0,5 · nén lại 0,5 · quang học
0,5 · cắt crop 0,15 · che 0,25 · nghiêng 0,35 · trượt 0,5. Không tính lật:

| | |
|---|---|
| P(mẫu tới model nguyên vẹn) | **0,052** |
| Kỳ vọng số phép trên một mẫu | **2,25** |
| P(0 / 1 / 2 / 3 / 4 / 5 / 6 phép) | 0,052 / 0,210 / 0,336 / 0,268 / 0,111 / 0,022 / 0,002 |
| P(≥ 3 phép) | **0,403** |

Từng phép có bảng riêng ở §9, §12, §13, §15; tổng liều thì chưa có arm nào đo. Luật ở KẾ HOẠCH
§3 lớp 2 ("Tổng liều augment phải đo").

---

## 24. Khung RGB565 thô từ chính board — nhiễu, thu nhỏ, lượng tử, điểm sống — đo 11/09

Lần đầu có ảnh **đúng đường ảnh của kiosk**: RGB565 thô từ `drv_camera`, không JPEG, không
qua điện thoại. Ca `[manual]` "metered frames reach the host as raw rgb565" của
`drv_camera/test_apps/sensor` (commit `c8e661b`) chạy vòng phơi sáng 40 khung cho hội tụ, rồi
cứ 6 khung đo sáng lại dump một khung hex qua USB console, kèm `level / exposure / gain16`
của chính khung đó. Host lưu PNG không mất bit (5/6/5 nhân bit lên 8 như `unpack_rgb565`) vào
`raw/device/ov5640/images/<phiên>_<seq>.png` và `meta/…json`.

| | |
|---|---|
| Khung lưu được | **73** (phiên a 12, b 5, c 2, d 54), một người, một phòng, người di chuyển góc và cự ly |
| Tốc độ | ~10 s một khung 307 KB, 60 khung ≈ 10 phút |
| Rớt | phiên d: 6/60 khung về thiếu byte hoặc lẫn dòng log watchdog |
| Phơi sáng | **868 dòng ở cả 73 khung** (trần 70,5 ms); gain16 54–64, median **64** (trần 4×); `level` 13–34, median 26 so với mục tiêu 30 |

Phòng này thiếu sáng với cảm biến: hai điều khiển kịch trần mà vẫn dưới mục tiêu, đúng bệnh
E7-T17. Mọi số dưới đây là ở **gain 4×**, tức trường hợp nhiễu nhất của camera.

### 24.1 Nhiễu cảm biến: dải augment nặng gấp 3–8 lần thực tế

Kênh lục (6 bit, bước lượng tử = 4 trên thang 8 bit), khối 16×16 phẳng nhất (20% khối có
phương sai thấp nhất sau khi trừ mặt phẳng), 72 khung:

| | |
|---|---|
| σ nhiễu trung vị mỗi khung | **3,03** (1,85–3,37) |
| Phụ thuộc mức sáng | **không đo được** — hệ số shot noise khớp ra ~0 ở 60/72 khung |
| σ sau khi trừ nhiễu lượng tử `4/√12 = 1,15` | ≈ **2,8** |

Dải train hiện tại `PHOTON_RANGE (60, 600)`, `READ_SIGMA_RANGE (0, 5)` sinh ở mức 128 một
σ shot từ `√(255·128/600) = 7,4` tới `√(255·128/60) = 23,3`. Camera thật ở gain tối đa
cho ≈ 3. Comment trong `data.py` gọi dải này là "đường OV5640" nhưng §3 và §9 không có phép đo
nhiễu nào; đây là phép đo đầu tiên và nó bác dải đó.

Model không nhìn pixel cảm biến mà nhìn crop 81 px do trung bình vùng, nên đo lại sau khi
thu nhỏ cả khung bằng `Image.BOX` theo đúng hệ số mặt/81 của bộ ảnh (mặt 86–197 px):

| Hệ số thu | tương ứng cạnh mặt | σ trung vị | p10–p90 |
|---|---|---|---|
| 1,0 | 81 px | 3,03 | 1,85–3,37 |
| 1,7 | 138 px (median) | **2,65** | 2,32–2,85 |
| 2,4 | 194 px | **2,44** | 2,16–2,66 |

Trung bình 2,9–5,8 pixel mà σ chỉ giảm 10–20%: phần lớn "nhiễu" này có tương quan không gian
(ISP của OV5640 đã lọc), không phải nhiễu trắng từng pixel. Đích cho augment là **σ 2,2–2,9,
gần như phẳng theo mức sáng**.

Chốt (đã duyệt 11/09, sửa plan §3 và `data.py`): `PHOTON_RANGE (8000, 16000)`,
`READ_SIGMA_RANGE (1,5; 3,0)`:

| photons / read | σ ở mức 30 | 128 | 230 |
|---|---|---|---|
| 16000 / 1,5 (nhẹ nhất) | 1,65 | 2,07 | 2,42 |
| 8000 / 3,0 (nặng nhất) | 3,16 | 3,62 | 4,04 |

Dải cũ ở cùng ba mức: 7,4–23,3 ở mức 128. Cổng `p=0,5` của nhóm quang học không đổi nên bộ ba
liều ở §23 giữ nguyên.

### 24.2 Thu nhỏ trung bình vùng (board) so với bilinear (train): không có khoảng cách

51 khung có mặt, cùng crop 1,0×, resize về 81 bằng `Image.BOX` (tương ứng `resample_square`
trên board) và `Image.BILINEAR` (đường train), chấm bằng model hai nhánh `1112`:

| | |
|---|---|
| Trung bình (BOX − BILINEAR) | **−0,003** |
| Lệch lớn nhất một khung | 0,049 (`a_001`: 0,834 so 0,883) |
| Sai khác pixel trung bình ở 81 px | 1,3–2,7 mức |

Không cần đổi cách resize ở bên nào.

### 24.3 Lượng tử 5/6/5: ảnh hưởng nhỏ và hai chiều

Áp lượng tử RGB565 (nhân bit lên như board) lên 111 khung `phone_eval` rồi chấm lại, cùng
model `1112`:

| Nhóm | n | as-is | 565 | Δ | qua @0,90 |
|---|---|---|---|---|---|
| attack_anh | 12 | 0,236 | 0,192 | −0,045 | 0 → 0 |
| attack_gan | 3 | 0,301 | 0,275 | −0,026 | 0 → 0 |
| attack_xa | 20 | 0,179 | 0,186 | +0,007 | 0 → 0 |
| live_gan | 12 | 0,993 | 0,995 | +0,002 | 12 → 12 |
| live_kho | 12 | 0,940 | 0,913 | −0,028 | 11 → **9** |
| live_rat_xa | 20 | 0,407 | 0,460 | +0,052 | 0 → 0 |
| live_vua | 12 | 0,227 | 0,267 | +0,039 | 0 → 0 |
| live_xa | 20 | 0,709 | 0,780 | +0,070 | 2 → **4** |

Không có chiều nhất quán và không nhóm nào đổi kết luận. Theo luật 1 của §3 lớp 2, chưa đủ
khoảng cách để thêm phép mô phỏng 565 vào train.

### 24.4 Điểm sống trên khung camera thật — một người, một phòng

Detector ở 160×120 tìm được mặt ở **51/73** khung (22 khung không có hộp: người ra mép khung,
quay nghiêng sâu, hoặc mờ chuyển động). Cạnh mặt 86–197 px trong khung 480×320, median
**138 px**, tức 29–66 px ở đầu vào detect, median 46.

Model `1112` (hai nhánh, mốc đang so), crop BOX, ngưỡng 0,90:

| Điểm sống | Khung |
|---|---|
| ≥ 0,90 | **39** (76%) |
| 0,50 – 0,90 | 4 |
| < 0,50 | **8** (16%): `b_002` 0,32 · `c_000` 0,03 · `d_005` 0,11 · `d_016` 0,04 · `d_019` 0,46 · `d_030` 0,02 · `d_033` 0,08 · `d_037` 0,06 |

BPCER@0,90 = **12/51 = 23,5%** trên cùng một người thật, cùng phòng, chỉ đổi chỗ đứng và góc.
(Tiếp ở §25 với số nền trên hai bộ mới.)
`d_016` là bàn tay che mồm (bảng che ở KẾ HOẠCH §3 nói che mồm vô hại — trên camera thật
thì không). Các khung còn lại rớt khi người rời khỏi giữa khung: đúng cơ chế §22, nhánh wide
đọc căn phòng. Đây là bộ thước cho arm một-backbone sắp tới, và là bằng chứng trên miền
thiết bị rằng con số ACER trên `phone_eval` không phải chuyện riêng của điện thoại.

---

## 25. Số nền của `1112` trên LCC-FASD và SynthASpoof — đo 11/09

Hai bộ mới về (§1.2 KẾ HOẠCH), cắt bằng `xdomain_crop.py` theo hộp detector ở 160×120
(LCC evaluation: 7.555/7.580 có mặt; SynthASpoof: 2.000 ảnh mỗi kênh, đủ mặt). Chấm bằng
model hai nhánh `20260911-1112`, ngưỡng **0,996929** khớp trên `test:0:10` của CelebA-Spoof,
tức đúng cách firmware sẽ dùng một ngưỡng cố định:

| Bộ | n | live / attack | AUC | APCER | BPCER | HTER | EER |
|---|---|---|---|---|---|---|---|
| CelebA `test:10:` (nhà) | 39.072 | | 0,951 | 0,126 | 0,151 | 0,138 | 0,135 |
| **LCC-FASD evaluation** | 7.555 | 314 / 7.241 | **0,780** | 0,055 | **0,589** | 0,322 | 0,277 |
| SynthASpoof `bonafide` | 2.000 | 2.000 / 0 | | | **0,344** | | |
| SynthASpoof `printattack` | 2.000 | 0 / 2.000 | | 0,010 | | | |
| SynthASpoof `samsung_replayattack` | 2.000 | 0 / 2.000 | | 0,019 | | | |
| SynthASpoof `ipad_replayattack` | 2.000 | 0 / 2.000 | | **0,281** | | | |
| SynthASpoof `webcam_replayattack` | 2.000 | 0 / 2.000 | | 0,118 | | | |
| NUAA | 5.110 | 3.362 / 1.748 | 0,992 | 0,004 | **0,500** | 0,252 | 0,033 |

Cùng một hình ở cả ba bộ ngoài: ngưỡng khớp trên CelebA-Spoof **đuổi 34–59% người thật** đi
mà gần như không cho tấn công lọt. NUAA có EER 3,3% nên tách được, chỉ lệch ngưỡng; LCC-FASD
EER 27,7% là không tách được ở miền đó, đúng bộ có thật và giả cùng phòng chụp lại bằng điện
thoại. iPad là kênh phát lại khó nhất (APCER 28%), gấp 15 lần Samsung.

Đây là mốc để so arm một-backbone có LCC training và SynthASpoof train trong pool
(`train_split` 7 spec, hash config `271c09`). Với arm đó, LCC evaluation và SynthASpoof test
không còn hoàn toàn "khác miền": chúng là phần giữ lại của bộ đã train một phần, và bảng
phải ghi rõ như vậy.
