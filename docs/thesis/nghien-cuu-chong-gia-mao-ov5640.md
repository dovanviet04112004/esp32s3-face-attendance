# Chống giả mạo khuôn mặt trên camera OV5640

Nhật ký nghiên cứu ngày 14/09/2026. Ghi cho chương thực nghiệm của báo cáo. Toàn bộ số
trong tài liệu này đo trên **khung ảnh do chính board chụp** — không có số nào lấy từ tập
kiểm thử công khai.

> Mục tiêu đặt ra: dìm sâu điểm của ảnh giả **và** không chặn oan mặt thật. Hai vế cùng
> lúc, không chấp nhận đánh đổi.

---

# 1. Đặt vấn đề

Nhánh anti-spoof đạt kết quả tốt trên các tập công khai nhưng **sụp trên thiết bị**. Ba
model được chấm lại bằng đúng file INT8 mà board nạp, trên 64 khung mặt thật và 21 khung
ảnh giả do OV5640 chụp:

| Model | AUC | ACER tốt nhất | Giả lọt khi chặn oan ≤ 5% |
|---|---|---|---|
| 3 kênh, bản đang nằm trên board | 0,6473 | 34,6% | 81,0% |
| chroma 4 kênh, 13/09 | 0,8668 | 17,3% | 33,3% |
| pool cân lại, 14/09 | 0,8438 | 19,8% | 66,7% |

Bản 3 kênh đang chạy trên board để lọt **81% ảnh giả**. Bản chroma tốt hơn hẳn nhưng vẫn
để lọt một phần ba. Đáng chú ý: bản train mới nhất, tuy tốt hơn trên mọi thước đo gián
tiếp, lại **tệ hơn trên thiết bị** — hiện tượng này quay lại nhiều lần trong ngày và được
phân tích ở §4.1.

## 1.1. Kiểu tấn công đang xét

Ảnh chân dung kiểu ảnh thẻ, hiển thị trên màn hình điện thoại, đưa sát ống kính. Đây là
kiểu tấn công rẻ nhất và dễ thực hiện nhất với một kiosk chấm công.

Điểm khiến nó khó: model chấm ảnh thẻ là **thật** với điểm 0,999. Nó học *phong cách ảnh*
chứ không học *bề mặt sống*. Nội dung khung hình — một chân dung chính diện, nền sạch, ánh
sáng đều — chính là thứ đẩy điểm lên, bất kể chân dung ấy đang nằm trên một tấm kính.

---

# 2. Dữ liệu và giao thức đo

| Hạng mục | Giá trị |
|---|---|
| Cảm biến | OV5640, chế độ `FRAMESIZE_HVGA` |
| Khung thô | 480 × 320, `rgb565_be` |
| Tổng khung đã chụp | 125 |
| Bề rộng hộp mặt đo được | 64 – 198 px |
| Đầu vào model | 81 × 81, 4 kênh (RGB + bão hoà màu) |

Sau khi chạy detector và lọc nhãn: **21 khung ảnh giả** và **64 khung mặt thật** dùng để
chấm; **51 khung không nhãn** tách riêng, chỉ dùng cho phép thích nghi thống kê ở §5 và
không bao giờ được chấm điểm.

## 2.1. Hai cái bẫy nhãn phải sửa trước khi đo bất cứ thứ gì

Cả hai đều làm hỏng số đo một cách âm thầm, và cả hai chỉ lộ ra khi **mở ảnh ra nhìn**:

- Trong 125 khung chỉ có 52 khung mang trường `is_spoof`. 73 khung còn lại từng bị coi mặc
  định là mặt thật. Kiểm bằng mắt toàn bộ 73 khung xác nhận chúng **đúng là mặt thật**, nên
  chúng trở thành một tập hợp lệ — nhưng sự trùng khớp ấy là may, không phải đúng quy trình.
- Bảy khung `spoof1309_000` đến `spoof1309_006` mang nhãn *giả* nhưng thực tế là **ảnh mặt
  thật**. Detector tình cờ trượt đúng những khung đó nên chưa phép đo nào bị hỏng, nhưng nếu
  nó bắt được thì mọi con số của cả ngày đã sai.

> Bài học: **không suy đoán cái gì đang ở trước ống kính**. Chỉ đọc ảnh thô có nhãn, và
> nhãn phải được kiểm bằng mắt trước khi tin.

## 2.2. Cách chấm

Mỗi khung đi qua đúng đường mà firmware chạy: detector YuNet lấy hộp mặt lớn nhất → cắt
`tight` tỉ lệ 1,0× → đưa về 81 × 81 → thêm kênh bão hoà → chấm bằng **file INT8**, không
phải bằng trọng số float. Điểm báo cáo là xác suất lớp *thật*.

---

# 3. Phát hiện chính — đặc trưng bề mặt chuẩn hoá theo cỡ mặt

## 3.1. Định nghĩa

Với mỗi khung, lấy ảnh xám của vùng mặt ở đúng 81 × 81 mà model nhìn, chuẩn hoá về trung
bình 0 và độ lệch chuẩn 1, rồi lấy trung bình trị tuyệt đối của **Laplace** (tổng đạo hàm
bậc hai theo hai trục). Gọi số này là **độ nét bề mặt**.

Phép chuẩn hoá tương phản trước khi lấy đạo hàm là phần quan trọng: nó khiến số đo **không
phụ thuộc độ sáng hay độ tương phản**, chỉ phụ thuộc vào việc bề mặt có kết cấu hay không.
Da người có lỗ chân lông, sợi tóc, vi tương phản; mặt kính thì không.

Một lớp tích chập **không tự tính được** đại lượng này, vì phép chia cho độ lệch chuẩn toàn
ảnh là phi tuyến — cùng loại lý do đã dùng để thêm kênh bão hoà màu thứ tư.

## 3.2. Số thô, và vì sao nó chưa đủ

| Nhóm | p5 | trung vị | p95 |
|---|---|---|---|
| 64 khung mặt thật | 0,130 | 0,167 | 0,218 |
| 21 khung ảnh giả | 0,099 | 0,106 | 0,131 |

Hai dải gần như tách rời, nhưng một ngưỡng cố định thì chưa sạch:

| Ngưỡng | Giả lọt | Thật bị chặn oan |
|---|---|---|
| 0,120 | 3 / 21 | 1 / 64 |
| 0,130 | 2 / 21 | 5 / 64 |
| 0,135 | 0 / 21 | 7 / 64 |
| 0,150 | 0 / 21 | 18 / 64 |

## 3.3. Nhiễu phải loại: cỡ mặt

Toàn bộ 21 khung giả có bề rộng mặt **145 – 174 px** vì điện thoại được đưa sát ống kính,
trong khi các khung mặt thật nằm sát ngưỡng đều chỉ **64 – 143 px**. Giả thuyết cạnh tranh
là hiển nhiên: có thể ảnh giả mịn chỉ vì **ngoài tiêu cự**, chứ không phải vì nó là màn hình.

Phép đối chứng trực tiếp — các khung **mặt thật cùng cỡ** với điện thoại:

| Khung | Bề rộng mặt | Độ nét | Điều kiện sáng |
|---|---|---|---|
| `toi1209_005` | 198 px | 0,310 | thiếu sáng |
| `toi1209_001` | 190 px | 0,242 | thiếu sáng |
| `toi1209_003` | 170 px | 0,152 | thiếu sáng |
| `toi1209_002` | 162 px | 0,226 | thiếu sáng |
| `toi1209_006` | 144 px | 0,208 | thiếu sáng |
| `s20260911c_001` | 143 px | 0,211 | văn phòng |
| `s20260911d_027` | 143 px | 0,139 | văn phòng |
| **21 khung ảnh giả** | **145 – 174 px** | **0,096 – 0,135** | phòng |

Mặt thật ở 170 – 198 px vẫn nét gấp đôi ảnh giả **cùng cỡ**, kể cả khi chụp thiếu sáng. Giả
thuyết ngoài tiêu cự bị loại.

Củng cố thêm: khớp đường xu hướng trên riêng 64 khung mặt thật cho
`độ nét = +0,00067 × bề rộng + 0,099`. **Độ dốc dương** — mặt càng to càng nét, đúng trực
giác. Vậy mà 21 khung giả lại là những khung **to nhất và mịn nhất**, tức chúng đi ngược
đúng chiều mà nhiễu cỡ mặt lẽ ra phải đẩy chúng.

## 3.4. Kết quả sau khi trừ xu hướng cỡ mặt

| Nhóm | Khoảng phần dư | Số khung |
|---|---|---|
| Ảnh giả | −0,120 … **−0,062** | 21 |
| Mặt thật | **−0,061** … +0,078 | 64 |

**AUC = 1,0000. Không một khung nào chồng lấn.**

Kiểm vào đúng những khung khó nhất mà model không xử được:

| Khung | Điểm model | Độ nét | Kết luận theo bề mặt |
|---|---|---|---|
| `spoof1309_025` | 0,999 | 0,135 | thấp hơn cả 64 khung thật |
| `spoof1309_027` | 0,999 | 0,128 | thấp hơn cả 64 khung thật |
| `toi1209_005` | 0,895 | 0,310 | cao hơn cả 21 khung giả |
| `toi1209_003` | 0,748 | 0,152 | cao hơn cả 21 khung giả |

Đây là kết quả duy nhất trong cả ngày **chạm được cả hai vế** của mục tiêu: nó dìm đúng hai
khung giả cứng đầu nhất, đồng thời cứu đúng những khung mặt thật mà các phương án khác chặn
oan.

Tuy nhiên con số AUC 1,0000 này **chưa qua kiểm chéo**. §3.6 cho thấy phần lớn nó là hệ quả
của việc ngưỡng được đặt vừa khít vào hai điểm biên, và khi kiểm trung thực thì nó tụt xuống.

## 3.5. Vì sao model hiện tại không dùng được manh mối này

Đo độ nét **trên chính pool huấn luyện, sau khi đã chạy đủ chuỗi tăng cường dữ liệu**
(4.000 mẫu):

| Nhóm | p5 | trung vị | p95 |
|---|---|---|---|
| Mặt thật trong pool | 0,096 | 0,186 | 0,325 |
| Ảnh giả trong pool | 0,091 | 0,190 | 0,355 |

**AUC = 0,479 — tức gần như bằng tung đồng xu.** Chuỗi tăng cường (nén JPEG ngẫu nhiên
30–95, nhiễu cảm biến, nhoè chuyển động, phơi sáng, vignette) đã **cố tình** triệt tiêu manh
mối chất lượng ảnh.

Đó là lựa chọn đúng về nguyên tắc — chất lượng ảnh thường không tổng quát giữa các camera,
và để model bám vào nó là mời gọi một lối tắt hỏng. Nhưng hệ quả là: trên chính thiết bị
này, model **đã được huấn luyện để phớt lờ** đúng đặc trưng ăn tiền nhất.

Hệ quả thiết kế: không thể sửa bằng cách thêm một kênh đầu vào thứ năm, vì pool không có
tín hiệu để dạy model dùng kênh đó. Đường khả thi là **một cổng kiểm tra độc lập** chạy song
song với model, hoặc bổ sung ảnh giả thật sự mịn vào pool.

## 3.6. Kiểm chéo, và phép ghép với điểm model

Hai câu hỏi phải trả lời trước khi tin vào §3.4: biên phân tách rộng bao nhiêu so với độ
tản của chính dữ liệu, và ghép thêm điểm model vào có mở rộng được biên không.

Quy về đơn vị **độ lệch chuẩn của nhóm mặt thật** để so được giữa hai đại lượng khác thang:

| Bộ phân biệt | Biên giữa hai lớp |
|---|---|
| Riêng độ nét, đã trừ xu hướng cỡ mặt | +0,0013 tuyệt đối = **+0,046 σ** |
| Riêng điểm model | **−0,3297** — âm, tức hai lớp chồng lấn |
| Ghép tuyến tính hai tín hiệu, quét toàn bộ góc 0 – 90° | góc tối ưu = **0°** |

Góc tối ưu bằng 0° có nghĩa rất cụ thể: **trọng số tốt nhất cho điểm model là 0**. Thêm điểm
model vào không mở rộng được biên dù chỉ một chút. Hai tín hiệu không bù cho nhau — những
khung mà model chấm sai cũng chính là những khung nằm sát biên của độ nét.

Kiểm chéo **bỏ-một-ra** trên cả 85 khung (mỗi lượt khớp lại đường xu hướng và đặt lại ngưỡng
trên 84 khung còn lại, rồi chấm khung bị bỏ ra):

| Kết quả | Số khung |
|---|---|
| Phân loại đúng | **83 / 85** |
| Sai | 2 — `spoof1309_025` và `toi1209_003` |

Hai khung sai **chính là hai điểm biên** ở §3.4: ảnh giả nét nhất (−0,062) và mặt thật mịn
nhất (−0,061). Nói cách khác, **AUC 1,0000 ở §3.4 phần lớn là hệ quả của việc ngưỡng được
đặt vừa khít giữa đúng hai khung này**. Khi không cho phép nhìn trước chúng, cả hai đều bị
phân loại nhầm.

> Đánh giá đúng mực: đặc trưng bề mặt là **bộ phân biệt đơn lẻ mạnh nhất tìm được trong cả
> ngày** (97,6% dưới kiểm chéo, so với 0,8668 AUC của model), nhưng biên **0,046 σ** là quá
> hẹp để chốt một ngưỡng cố định đem nạp lên board. Nó là một hướng có cơ sở, **chưa phải
> một lời giải**.

---

# 4. Các hướng đã thử và đã bị số liệu bác bỏ

Phần này giữ lại đầy đủ vì nó là nội dung thực nghiệm có giá trị: mỗi dòng là một giả
thuyết hợp lý bị chính phép đo đóng lại.

## 4.1. Nhóm 1 — chỉnh model và dữ liệu huấn luyện

| Hướng | Phép đo | Vì sao đóng |
|---|---|---|
| Chỉnh ngưỡng `live_min` | Phân bố điểm hai miền | Hai miền đẩy phân bố ngược chiều nhau; không có ngưỡng nào tốt cho cả hai |
| Cổng lọc theo bão hoà màu | Điểm từng khung | Mặt thật văn phòng 0,282–0,376 nằm lọt trong dải ảnh giả 0,131–0,413 |
| Đặc trưng màu thay thế (`chroma_hp`) | AUC riêng miền văn phòng | 0,5397 — ngang mức ngẫu nhiên |
| Cân lại pool theo độ khó từng kênh | 90 epoch, 3h19 | Gián tiếp tăng đẹp (iPad 0,8729→0,9718) nhưng **thiết bị giảm** 0,8668→0,8438 |
| Thêm 20.000 mặt thật MS1MV3 | Dừng ở epoch 2 | Cùng cơ chế với dòng trên, dừng sớm để khỏi tốn 3 giờ |
| Tinh chỉnh trên 85 khung thiết bị | Kiểm chéo 3 phần | **Mọi cấu hình đều tệ hơn bản gốc** — xem §4.3 |

## 4.2. Nhóm 2 — nghi ngờ đường ảnh và lượng tử hoá

| Hướng | Phép đo | Vì sao đóng |
|---|---|---|
| Lượng tử hoá INT8 làm hỏng | APCER float vs INT8 | 0,238 so với 0,286 — chênh nhỏ, không giải thích được mức sụp |
| Đường chụp của board làm hỏng | Mô phỏng lại đường chụp | AUC 0,7996 → 0,8194, đi đúng chiều nhưng quá nhỏ |
| Lệch JPEG / bộ lấy mẫu lại | 3 đường cắt khác nhau | Chênh nhau trong 0,03 AUC |
| Nâng độ phân giải camera | Độ nét ở 81 px vs 128 px | **0,9859 so với 0,9747** — manh mối ở 81 px còn rõ hơn, phép co ảnh không xoá mất gì |

Dòng cuối đáng nói riêng. Giả thuyết ban đầu rất thuyết phục: OV5640 là cảm biến 5 MP bị
gộp pixel xuống 480 × 320 ngay trong sensor, và phép gộp là một phép trung bình — nó phải
xoá vân moiré, tức dấu hiệu kinh điển của màn hình. Phép đo cho thấy điều ngược lại: đặc
trưng phân biệt **mạnh hơn** ở độ phân giải thấp. Nhờ đó **không phải đụng vào firmware
camera**, tiết kiệm một nhánh công việc đáng kể.

## 4.3. Tinh chỉnh trên dữ liệu thiết bị

Câu hỏi thực tế: nếu thu thêm khung ảnh từ chính board rồi huấn luyện tiếp, có sửa được
không? Để trả lời **trước khi** tốn thời gian thu dữ liệu, chạy kiểm chéo 3 phần trên 85
khung đang có, **chỉ tinh chỉnh tham số của lớp chuẩn hoá**, mọi tham số khác đóng băng:

| Cấu hình | AUC | ACER | Giả trên 0,75 | Thật dưới 0,75 |
|---|---|---|---|---|
| **Bản gốc, không tinh chỉnh** | **0,8668** | **0,1425** | 10 / 21 | **2 / 64** |
| 3 epoch, lr 0,0005 | 0,7634 | 0,2526 | 4 / 21 | 25 / 64 |
| 2 epoch, lr 0,0002 | 0,7946 | 0,2277 | 5 / 21 | 20 / 64 |
| 5 epoch, lr 0,001 | 0,4866 | 0,4345 | 1 / 21 | 58 / 64 |
| 12 epoch, lr 0,01 | 0,0060 | 0,5000 | — | 64 / 64 |

Mọi liều lượng đều dìm được ảnh giả nhưng **kéo sập phía mặt thật nặng hơn nhiều**. Ở liều
cao nhất, thứ tự điểm đảo ngược hoàn toàn (AUC 0,0060).

> 85 khung là **quá ít để tinh chỉnh có giám sát**, kể cả khi đã hạn chế chỉ động vào tham
> số chuẩn hoá. Phép đo này đã ngăn một đề nghị thu dữ liệu chưa có căn cứ.

---

# 5. Thích nghi thống kê không giám sát

Khác hẳn tinh chỉnh: **không đụng một trọng số nào**. Chỉ tính lại trung bình và phương sai
đang cất trong các lớp chuẩn hoá, bằng 51 khung **không nhãn** của thiết bị. Không cần nhãn,
không cần huấn luyện, chạy trên máy chủ khoảng hai phút.

Model có 35 lớp chuẩn hoá. Chỉ thích nghi các lớp **gần pixel nhất** — nơi đọc độ sáng,
tương phản và dải màu thô, tức đúng những thứ khác nhau giữa ảnh dataset và cảm biến OV5640.

| Số lớp thích nghi | AUC | ACER | Giả lọt ≤5% | Giả trên 0,75 |
|---|---|---|---|---|
| 0 — bản gốc | 0,8755 | 0,1575 | 47,6% | 10 / 21 |
| 3 | 0,8535 | 0,1630 | 61,9% | 4 / 21 |
| 8 | 0,9011 | 0,1392 | 52,4% | 2 / 21 |
| **12** | 0,9267 | **0,1154** | 42,9% | **2 / 21** |
| **20** | **0,9377** | 0,1245 | **28,6%** | 3 / 21 |
| 35 — toàn bộ | 0,7729 | 0,1868 | 100% | 5 / 21 |

Thích nghi **toàn bộ 35 lớp thì sụp**, và lý do rõ ràng: các lớp sâu chứa thống kê đã mang
nghĩa *thật / giả*, mà 51 khung dùng để thích nghi **toàn là mặt thật**. Tính lại thống kê
lớp sâu trên dữ liệu một lớp duy nhất thì model mất luôn khái niệm về lớp kia.

Cả dải 8 – 20 lớp đều tốt hơn bản gốc. Việc kết quả **không phụ thuộc vào một con số cụ
thể** là điều đáng tin hơn bản thân con số tốt nhất.

## 5.1. Cái giá phải trả, và chẩn đoán

| Khung mặt thật | Trước | Sau 12 lớp |
|---|---|---|
| `toi1209_005` | 0,895 | **0,135** |
| `toi1209_003` | 0,748 | **0,172** |
| `toi1209_001` | 0,870 | **0,422** |

Ba khung mặt thật bị chặn oan, và **cả ba đều thuộc phiên chụp thiếu sáng**. Trong khi đó
51 khung dùng để thích nghi **toàn bộ thuộc một phiên ánh sáng văn phòng** (11 + 2 + 2 + 36
= 51). Phiên chụp sáng phòng thì không hề hấn (0,928 – 0,990).

Vậy đây không phải model học sai, mà là tập thích nghi **chỉ phủ một điều kiện sáng**. Cách
vá đúng là bổ sung vài chục khung thiếu sáng **không cần nhãn** — cùng cơ chế đã kéo 10
khung giả xuống còn 2.

---

# 6. Ba lần kết luận sai trong chính ngày làm việc này

Giữ lại vì chúng dạy về phương pháp đo nhiều hơn là về bài toán.

## Sai 1 — đo trên dữ liệu thô thay vì dữ liệu model thật sự thấy

Đo độ nét trên các shard **chưa qua tăng cường** cho AUC 0,376, tức manh mối chỉ **ngược
chiều** so với thiết bị. Kết luận rút ra lúc đó: pool đang dạy model điều sai, cần một lần
huấn luyện lại ba giờ để sửa.

Đo lại trên đúng đường tăng cường mà `SpoofShardDataset` chạy: AUC **0,479**, tức gần như
vô nghĩa — chuỗi tăng cường đã trung hoà manh mối từ trước. **Kết luận cũ sai, và lần huấn
luyện ba giờ ấy sẽ vô ích.**

> Pool thô và pool sau tăng cường là **hai phân bố khác nhau**. Chỉ cái thứ hai mới nói
> được model học gì.

## Sai 2 — mô phỏng đường chụp bằng phép lấy mẫu lại

Để kiểm giả thuyết lệch miền, co ảnh pool xuống cỡ mặt của thiết bị rồi lượng tử về RGB565.
Kết quả: pool **nét lên** thay vì mịn đi. Nguyên nhân không nằm ở đường chụp mà ở chính
phép đo — đường hai bước dùng bộ lọc `BOX` bị đem so với đường một bước dùng `BILINEAR`.
Chênh lệch đo được là **hiện vật của bộ lọc nội suy**, không phải của board.

## Sai 3 — báo động giả về tầng nạp model

Khi so checkpoint với trọng số vừa nạp, thấy 217/252 tensor khác nhau, kể cả
`classifier.weight` — thứ mà phép thích nghi không bao giờ đụng tới. Kết luận vội: tầng nạp
model có lỗi, **mọi số đo trong ngày đều đáng nghi**.

Thực tế: lúc soi checkpoint chỉ in 10 khoá đầu tiên nên bỏ sót khoá `ema` nằm sau. Hàm nạp
lấy bản trung bình trượt EMA là **đúng như thiết kế**. Không có lỗi nào.

Tuy vậy lần soi đó lại lộ ra **hai lỗi thật** trong chính script thích nghi:

1. Ghi trọng số đã thích nghi vào nhánh sai của checkpoint, nên bản xuất INT8 sẽ âm thầm
   mất sạch phần thích nghi.
2. Đặt cả model vào chế độ huấn luyện khiến **toàn bộ 35 lớp** cập nhật thống kê chứ không
   chỉ các lớp được chọn.

Bảng ở §5 là số **sau khi sửa** cả hai.

## 6.1. Hai bài học phương pháp lặp lại nhiều lần

- **34 khung chỉ để gợi ý, không để quyết định.** Khi rà 23 bản lưu trung gian, bản ở epoch
  11 tốt nhất trên 34 khung (AUC 0,9670) nhưng tập độc lập 716 khung đảo ngược thứ tự (bản
  cuối 0,9291 so với bản lưu 0,8373). Chọn model trên tập quá nhỏ chính là khớp quá mức vào
  tập kiểm thử.
- **Thước đo gián tiếp tăng thì thiết bị giảm.** Lặp lại ở cả hai lần huấn luyện trong ngày.
  Càng hợp phân bố của pool thì càng lệch khỏi camera thật.

---

# 7. Giới hạn của phát hiện ở §3

| Giới hạn | Chi tiết | Mức nghiêm trọng |
|---|---|---|
| Biên phân tách quá hẹp | Giả cao nhất −0,062 so với thật thấp nhất −0,061, cách nhau **0,001** tức **0,046 σ** | Cao — chưa đủ để chốt một ngưỡng cố định |
| Kiểm chéo hụt hai khung | 83/85 dưới bỏ-một-ra; hỏng đúng hai điểm biên (§3.6) | Cao — AUC 1,0000 không lặp lại được khi đánh giá trung thực |
| Ghép với điểm model không cứu được | Quét toàn bộ góc cho trọng số tối ưu của điểm model bằng **0** | Cao — không có tín hiệu thứ hai để bù |
| Chỉ một phương tiện tấn công | 21 khung đều là ảnh thẻ, **một** điện thoại, **một** phiên chụp | Cao — điều duy nhất còn có thể lật ngược kết quả |
| Đường xu hướng khớp trên chính tập chấm | Độ dốc rất nhỏ (0,02 trên 30 px) nên ảnh hưởng ít, nhưng vẫn là khớp trên dữ liệu đang đánh giá | Trung bình |
| Chưa kiểm ảnh in | Giấy in có kết cấu riêng, có thể rơi vào vùng khác hẳn màn hình | Trung bình |
| Điểm model đo bằng bản float | Bản chroma **chưa từng được xuất INT8**; chênh lệch float↔INT8 đo trước đó là APCER 0,238 ↔ 0,286 | Thấp |

---

# 8. Bước kiểm chứng tiếp theo

Một phép thử duy nhất, khoảng **10 khung**, và ý nghĩa của kết quả được chốt **trước** khi
chụp để tránh diễn giải theo ý muốn:

| Cần chụp | Số khung |
|---|---|
| Ảnh giả bằng **một điện thoại khác** (kích thước điểm ảnh và lớp phủ màn khác) | ≈ 5 |
| Ảnh giả bằng **ảnh in trên giấy** | ≈ 5 |

**Nếu** chúng cũng rơi xuống dưới −0,062 thì đặc trưng bề mặt là tính chất thật của phương
tiện tấn công, và có cơ sở để xây một cổng kiểm tra độc lập chạy song song với model.

**Nếu không**, đặc trưng này chỉ đúng cho một chiếc điện thoại và phải loại bỏ.

Song song và độc lập với phép thử trên, một việc **đã có bằng chứng** và làm được ngay: bổ
sung vài chục khung mặt thật **không nhãn** ở điều kiện thiếu sáng để mở rộng tập thích nghi
ở §5, vá đúng ba khung bị chặn oan ở §5.1.

---

# 9. Sinh ảnh giả từ dữ liệu sẵn có — hướng đi và lý do bị bác bỏ

Ràng buộc thực tế: không tiếp cận được board, nên không chụp thêm được khung nào. Câu hỏi
đặt ra: có thể lấy ảnh mặt thật đã có, **mô phỏng cho giống ảnh qua OV5640**, rồi đưa vào
huấn luyện không?

Ý tưởng có cơ sở vật lý rõ ràng. Ảnh giả là **ảnh chụp lại của một ảnh**: nó mất một thế hệ
độ phân giải mà mặt sống không mất. Mô phỏng đúng điều đó — chứ không phải chỉ làm mờ nửa
ảnh giả — thì không phải dạy mẹo.

## 9.1. Thiết kế và hiệu chuẩn

Mỗi ảnh mặt thật trong pool sinh ra hai bản, **cùng khuôn mặt, cùng cỡ, cùng đường cảm biến**,
khác đúng một thứ:

| Nhánh | Phép biến đổi |
|---|---|
| Mặt thật | co về cỡ mặt ngẫu nhiên 64 – 198 px → lượng tử RGB565 → đưa về 81 × 81 |
| Ảnh giả | thêm một bước **trước đó**: co xuống `k` lần rồi phóng lại, mô phỏng màn hình đã mất chi tiết |

Hiệu chuẩn `k` theo độ nét đo được trên thiết bị (mặt thật 0,167 · ảnh giả 0,106):

| Nhánh mô phỏng | p5 | trung vị | p95 | Lệch trung vị so thiết bị |
|---|---|---|---|---|
| Mặt thật | 0,118 | 0,186 | 0,297 | +0,019 |
| Giả `k` = 0,55 | 0,083 | 0,136 | 0,228 | +0,030 |
| **Giả `k` = 0,35** | 0,062 | **0,103** | 0,174 | **−0,003** |
| Giả `k` = 0,25 | 0,051 | 0,083 | 0,136 | −0,023 |

`k` = 0,35 trúng gần như tuyệt đối.

## 9.2. Phép thử thứ nhất — mô phỏng có tái hiện được cái khó không

Khớp một con số thống kê thì chưa đủ. Nếu model hiện tại bắt được ngay ảnh giả mô phỏng thì
mô phỏng đã tạo ra một bài dễ, và huấn luyện trên đó vô ích. Chấm 800 cặp bằng model chroma:

| Nhánh | Trung vị điểm | Lọt ≥ 0,75 |
|---|---|---|
| Mặt thật mô phỏng | 0,994 | 91,1% |
| Giả `k` = 0,55 | 0,992 | 89,9% |
| Giả `k` = 0,35 | **0,989** | **88,1%** |
| Giả `k` = 0,25 | 0,987 | 87,2% |

**Model bị lừa sạch** — đúng như nó bị lừa bởi ảnh giả thật (0,999). Mô phỏng tái hiện đúng
chế độ hỏng. Đến đây hướng đi trông rất thuận.

## 9.3. Phép thử thứ hai — kiểm cơ chế, và kết quả bác bỏ

Vẫn còn một lỗ hổng: `k` được hiệu chuẩn để **khớp con số** độ nét, mà khớp một con số
**không chứng minh cùng cơ chế**. Hai cơ chế khác nhau có thể cho cùng một độ nét.

Phổ tần phân biệt được chúng. Mất một thế hệ độ phân giải để lại **chỗ gãy rồi phẳng** (năng
lượng bị cắt trên tần số cắt, còn lại nền nhiễu). Nhoè ống kính thì suy giảm **đều và đơn
điệu**. So phổ trung bình của 21 khung giả thật với từng ứng viên:

| Ứng viên | Lệch so với phổ ảnh giả thật |
|---|---|
| **Nhoè ống kính σ = 0,7** | **0,192** |
| Mặt thật, không biến đổi gì | 0,218 |
| Mất thế hệ `k` = 0,45 | 0,356 |
| Mất thế hệ `k` = 0,35 | 0,396 |
| Mất thế hệ `k` = 0,28 | 0,447 |

**Cả ba bản mô phỏng đều tệ hơn cả việc không biến đổi gì.** Đường cong của chúng lộ rõ chỗ
gãy (`k` = 0,45 cho chuỗi −2,95 → −3,22 → −3,18 → −3,37), trong khi phổ ảnh giả thật mượt và
đơn điệu suốt dải.

Kết luận: ảnh giả trên thiết bị **không phải** ảnh chụp lại mất độ phân giải, mà gần với
**mặt thật bị lọc thông thấp nhẹ**. Huấn luyện theo thiết kế ở §9.1 sẽ dạy model bám vào
**chỗ gãy do phép phóng to sinh ra** — một hiện vật không tồn tại trong ảnh giả thật.

## 9.4. Vì sao không chuyển sang mô phỏng bằng chính phép lọc thông thấp

Nếu dựng dữ liệu đúng theo cơ chế vừa đo được thì việc đó **chính là làm mờ riêng nửa ảnh
giả**. Khi độ mờ là khác biệt duy nhất giữa hai lớp, model học đúng một luật: *mờ thì là
giả*. Một khuôn mặt thật hơi lệch nét sẽ bị chặn, và một màn hình độ phân giải cao đưa đúng
tiêu cự sẽ lọt.

Đây là ranh giới giữa **mô phỏng** và **mẹo**: mô phỏng tái tạo một cơ chế vật lý có thật;
mẹo gán một biến đổi nhân tạo cho đúng một lớp. §9.1 thuộc loại thứ nhất nhưng sai cơ chế;
phương án thay thế thuộc loại thứ hai.

> Giá trị giữ lại của mục này: §9.2 chứng minh model **mù hoàn toàn** trước khác biệt thế
> hệ ảnh, và §9.3 cho thấy phổ tần là công cụ đủ rẻ để bác bỏ một giả thuyết cơ chế **trước
> khi** tiêu ba giờ huấn luyện. Chi phí của cả mục: khoảng 25 phút.

---

# 10. Trục thời gian — chưa kiểm được, không phải đã bác bỏ

Mọi phép đo từ §1 đến §9 đều chấm **từng khung rời**. Nhưng board chạy video khoảng 14 fps,
và mặt người sống thì luôn có vi chuyển động — chớp mắt, đổi biểu cảm, đầu lắc nhẹ. Ảnh tĩnh
trên màn hình thì đứng im, chỉ còn nhiễu cảm biến.

Trục này hấp dẫn vì hai lý do: nó **độc lập hoàn toàn** với đặc trưng bề mặt ở §3, và nó
**khó lách hơn** — muốn qua thì kẻ tấn công phải chiếu video chứ không phải giơ một tấm ảnh.

Đo khác biệt giữa hai khung liên tiếp trong cùng phiên:

| Phiên | Nhãn | Cách nhau | Khác biệt trung vị |
|---|---|---|---|
| `live1309` | thật | 6 s | **0,168** |
| `spoof1309` | **giả** | 6 s | **0,274** |
| `s20260911a` | thật | 9 s | 0,581 |
| `s20260911d` | thật | 6 s | 0,627 |
| `toi1209` | thật | 0 s | 1,073 |

AUC gộp là 0,7856, nhưng **con số đó không dùng được**: phiên `live1309` là người thật mà
còn tĩnh hơn cả điện thoại (0,168 so với 0,274). Một người ngồi yên thì ít đổi hơn một cái
màn hình cầm trên tay.

Nguyên nhân nằm ở **thang thời gian sai**. App dump mất 6 – 9 giây mỗi khung, nên thứ đo
được là *người có đổi tư thế không* — phụ thuộc vào việc họ ngồi yên đến đâu. Trên board các
khung cách nhau khoảng **70 ms**, và ở thang đó thứ đo được là *có vi chuyển động nào vượt
trên nhiễu cảm biến không* — một chế độ hoàn toàn khác.

> Kết luận: trục thời gian **chưa được kiểm**, và dữ liệu hiện có **không thể kiểm nó**.
> Muốn kiểm phải có một chuỗi khung ở tốc độ video, tức phải sửa app dump hoặc ghi thẳng
> trên board. Đây là hướng chưa khai thác duy nhất còn lại sau khi §3 đến §9 đã đóng.

---

# 11. Đổi đích giám sát — trục chưa đụng tới

## 11.1. Nhìn lại: mười hai hướng đã đóng đều nằm cùng một phía

Xếp lại toàn bộ §3 – §10 theo *thứ bị thay đổi*:

| Nhóm | Các hướng đã thử | Kết quả |
|---|---|---|
| Đổi **dữ liệu** model ăn | cân lại pool · MS1MV3 · ảnh giả tổng hợp · mô phỏng đường chụp | đóng hết |
| Đổi **cách chấm** đầu ra | chỉnh ngưỡng · cổng bão hoà · ghép với đặc trưng bề mặt | đóng hết |
| Đổi **trọng số sau train** | tinh chỉnh trên khung device · thích nghi BN | đóng hoặc chỉ được một nửa |
| Đổi **câu hỏi bắt model trả lời** | — | **chưa thử lần nào** |

Cả ngày không hề đụng tới hàm mục tiêu. Nó vẫn là cross-entropy nhị phân từ đầu dự án.

## 11.2. Vì sao một nhãn toàn cục là chỗ hỏng

Cross-entropy nhị phân hỏi model đúng **một câu** cho cả khung hình. Một câu thì trả lời
được bằng **bố cục tổng thể**, và số đo cho thấy model đang làm đúng thế:

| | Điểm |
|---|---|
| Ảnh thẻ trên màn hình (`spoof1309_025`, `027`) | **0,999** |
| Mặt thật thiếu sáng (`toi1209_005`) | 0,135 |

Nó không phân loại *bề mặt sống* — nó phân loại *phong cách ảnh*. Chân dung chính diện, nền
sạch, sáng đều thì ăn điểm cao, bất kể chân dung ấy nằm trên da hay trên kính. Điều này đã
ghi từ trước trong hồ sơ dự án và §1.1 lặp lại; đến đây thì nó là **giả thuyết trung tâm**.

## 11.3. Bản đồ không gian vẫn còn, chỉ đang bị vứt

Chuỗi hạ mẫu của MiniFASNetV2-SE với đầu vào 81 × 81:

```
81 → stem(s2) → 41 → down_2(s2) → 21 → down_3(s2) → 11 → down_4(s2) → 6
                                                                      ↓
                                                    head  →  6 × 6 × 256
                                                                      ↓
                                             head_dw (depthwise 6×6)  →  1 × 1
```

`head_dw` dùng kernel **6×6** — đúng bằng cả bản đồ — nên nó gộp toàn bộ thông tin không
gian về một điểm trước khi phân loại. Bản đồ 6 × 6 vẫn tồn tại đầy đủ ngay trước đó.

Gắn thêm **một conv 1×1, 256 → 1** vào bản đồ ấy cho **36 quyết định độc lập**, mỗi ô phủ
khoảng 13 × 13 điểm ảnh đầu vào. Khi từng mảnh bề mặt phải tự đứng vững một mình thì
**không còn bố cục toàn cục nào để bám vào**.

Hàm mục tiêu mới: `L = CE(nhãn) + λ · BCE(bản đồ 6×6)`.

Nhãn bản đồ là hằng số theo lớp, vì crop **đã là** khuôn mặt — giá trị nằm ở chỗ ép model
tính cục bộ, không ở chỗ khoanh vùng. Đây là dạng rẻ nhất của pixel-wise supervision: bản đồ
độ sâu giả cần chạy một bộ khớp 3DMM trên cả pool, bản đồ nhị phân thì không cần gì thêm.

| | |
|---|---|
| Tham số thêm khi train | **257** |
| Tham số thêm trên board | **0** — đầu phụ bỏ lúc xuất |
| Arena / latency / 81 × 81 | không đổi |
| Cần dữ liệu mới | không |
| Cần board | không |

## 11.4. SSDG — bước hai

Nhắm vào chế độ hỏng đã lặp **2/2 lần** trong ngày: proxy tăng thì thiết bị giảm (§4.1).
SSDG ép đặc trưng của **mặt thật** không phân biệt được giữa các miền, còn **tấn công** thì
cho tách theo miền — tức tối ưu thẳng cho một miền chưa từng thấy, đúng vị trí của OV5640.

Nhãn miền đã nằm sẵn trên shard (`synth_ipad`, `synth_samsung`, `unique_replay`…) nên không
phải gắn lại. Giá: thêm lớp đảo gradient và bộ lấy mẫu triplet bất đối xứng — đủ lớn để phải
đo riêng, nên chạy sau và chỉ khi bước một đạt.

## 11.5. Tiêu chí nghiệm thu, chốt trước khi chạy

21 khung tấn công + 64 khung mặt thật của OV5640, **giữ hoàn toàn ngoài tập huấn luyện**.

| Điều kiện | Ngưỡng |
|---|---|
| ACER | **< 0,1425** |
| Khung mặt thật bị chặn | **≤ 2 / 64** |

Thiếu một trong hai là trượt. Chốt trước để lúc đọc kết quả không có chỗ diễn giải theo ý
muốn — đây là lỗi đã mắc hai lần trong ngày (§6.1).

**Tiền lệ cần ghi nhớ khi đọc kết quả**: hai lần huấn luyện ngày 14/09 đều làm số trên thiết
bị **tệ đi**. Khác biệt của lần này là cả hai lần đó chỉ đổi *dữ liệu*, còn đây đổi *đích
giám sát*. Đó là lý do để kỳ vọng khác, **không phải** bằng chứng rằng nó sẽ khác.

---

**Trạng thái chốt cuối ngày 14/09/2026.** Model tốt nhất cho board vẫn là bản chroma 4 kênh
ngày 13/09, và nó **chưa từng được nạp lên board** — board vẫn đang chạy bản 3 kênh để lọt
81% ảnh giả.

Mục tiêu đặt ra ở đầu tài liệu **chưa đạt**. Bảng tổng kết mọi thứ đã đo được trên thiết bị:

| Phương án | Kết quả tốt nhất trên thiết bị | Trạng thái |
|---|---|---|
| Model 3 kênh (đang chạy trên board) | AUC 0,6473 · lọt 81,0% | Kém nhất, cần thay |
| Model chroma 4 kênh | AUC 0,8668 · lọt 33,3% | Tốt nhất trong các model |
| + thích nghi thống kê 20 lớp | AUC 0,9377 · lọt 28,6% | Miễn phí, nhưng chặn oan 3 khung thiếu sáng (§5.1) |
| Đặc trưng bề mặt đơn lẻ | 83/85 dưới kiểm chéo | Mạnh nhất, nhưng biên 0,046 σ — chưa nạp được |
| Ghép model + bề mặt | Không hơn bề mặt đơn lẻ | Đã loại (§3.6) |
| Sinh ảnh giả tổng hợp từ pool | Không chạy | Đã loại bằng phổ tần trước khi train (§9.3) |

Không phương án nào trong bảng đủ để chốt. Hai việc còn lại, theo thứ tự:

1. **§8** — chụp ~10 khung bằng phương tiện tấn công thứ hai. Đây là phép thử duy nhất còn
   có thể khiến đặc trưng bề mặt trở nên đáng tin (nếu biên rộng ra trên dữ liệu mới) hoặc
   bị loại hẳn.
2. **§5.1** — bổ sung vài chục khung mặt thật không nhãn ở điều kiện thiếu sáng, vá phần
   chặn oan của phép thích nghi thống kê. Việc này **đã có bằng chứng** và độc lập với mục 1.
