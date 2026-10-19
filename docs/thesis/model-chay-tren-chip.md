# Một model chạy trên ESP32-S3 như thế nào

Ghi cho chương triển khai của báo cáo. Chín câu hỏi về đường đi của dữ liệu khi ba model của kiosk
chạy trên chip, theo đúng thứ tự đã hỏi: trọng số và tensor nằm ở đâu, khung camera tới model ra sao,
mặt được nắn và embedding được chuẩn hoá thế nào, rồi so hai runtime và các bản vá đưa model lên chip.

Bộ model là bộ đang deploy: detect `1616` (YuNet), spoof `0118_5d7b35` (MiniFASNet V1SE PReLU),
recog `2106` (MobileFaceNet-ECA, trọng số FRBench). Runtime deploy là ESP-DL 3.3.11; TFLite Micro +
esp-nn là bản đối chứng. Số đo dẫn về `docs/measurements/`; số chưa đo đánh dấu 🔬.

1. Một model chạy thế nào: trọng số, tensor, flash, PSRAM
2. Trọng số và arena khác nhau thế nào, có nạp cả hai vào cache không
3. Khung 480×320 đi từ camera tới model
4. `align_face` nắn mặt về toạ độ đầu vào của recog
5. `l2norm` làm gì
6. TFLM + esp-nn và ESP-DL: vì sao TFLM phải đăng ký op
7. Bảng op của recog trên TFLM
8. Bản vá bên Python và module tự viết bên C
9. So với esp-sr: hai hướng vá

---

## 1. Một model chạy thế nào: trọng số, tensor, flash, PSRAM

> **Hỏi.** Một model chạy gồm tensor arena và trọng số. Tensor để ở PSRAM, trọng số để ở flash và
> cũng chép lên PSRAM. Quá trình một model chạy diễn ra thế nào?

Có đúng hai thứ, trọng số và tensor, nhưng ESP-DL không có một "tensor arena" dùng chung. Mỗi model
tự giữ một khối PSRAM cho tensor của riêng nó. Trọng số có hai bản: bản gốc nằm trong file trên flash,
bản làm việc nằm ở PSRAM. Lúc chạy, model chỉ đọc bản ở PSRAM.

```
          khởi động (1 lần)                    mỗi lượt chạy
FLASH ───────────────────────▶ PSRAM ◀──────────▶ cache 64 KB ◀──▶ CPU lõi 1
file .espdl     chép trọng số   · trọng số (bản chép)                lệnh SIMD
(ánh xạ, chỉ đọc)               · khối tensor của từng model
                                · khung camera
```

### 1.1 CPU đọc flash và PSRAM thế nào

Flash 16 MB và PSRAM 8 MB là hai chip nằm ngoài ESP32-S3, CPU không đọc thẳng được. MMU ánh xạ cả
hai vào dải địa chỉ, và mọi lần đọc dữ liệu đều đi qua cache dữ liệu 64 KB, mỗi dòng 64 B
(`firmware/sdkconfig.defaults.esp32s3`):

- **Trúng cache:** đọc gần như tức thì.
- **Trượt cache:** CPU đứng chờ trong lúc cache kéo 64 B qua bus. Flash chạy bus 4 dây (QIO), PSRAM
  chạy bus 8 dây (octal), cùng 80 MHz, nên lấp một dòng từ PSRAM nhanh hơn.

RAM nội 512 KB nhanh nhất nhưng gần như đã hết chỗ: Wi-Fi, TLS, stack các task, đệm DMA của màn và
giao diện giữ gần hết. Bản `fleet` đo trên kiosk ngày 10/10 chỉ còn 8.399 B trống (`ram.md` §12).
Model vì thế không dùng RAM nội.

### 1.2 Lúc khởi động: nạp một lần

Code ở `firmware/components/ai_engine/src/ai_engine_espdl.cpp` (`ai_engine_init`) và
`src/core/espdl/espdl_model.cpp` (`EspdlModel::init`):

1. `sys_storage_models_open` ánh xạ cả partition `models_x` (2,25 MB) vào dải địa chỉ. Không chép
   byte nào, tốn 0 byte RAM.
2. Với từng nhánh, `sys_storage_model_find` trả về con trỏ vào chính vùng ánh xạ đó.
3. `dl::Model` dựng model từ con trỏ đó, qua ba bước:
   - **Đọc đồ thị:** xếp các op theo thứ tự chạy thành một danh sách, mỗi op một module.
   - **Chép trọng số** (`param_copy`): cấp chỗ trong PSRAM rồi chép trọng số, bias, hệ số PReLU từ
     flash sang. Đây là bước tốn thời gian nhất lúc nạp.
   - **Lập kế hoạch bộ nhớ cho tensor** (`MEMORY_MANAGER_GREEDY`): ESP-DL chạy thử một lượt trên giấy
     để biết mỗi tensor sinh ra ở op nào và hết người đọc sau op nào. Những tensor không sống cùng lúc
     được xếp chồng lên cùng một chỗ. Kết quả là một khối duy nhất, cấp một lần trong PSRAM
     (`max_internal_size = 0`). Khối này đóng vai trò của arena.

Còn hàng nghìn object nhỏ: module, tên tensor, shape. `ExternalMallocGuard` đẩy chúng sang PSRAM; bỏ
guard thì ba model lấy 94 KB RAM nội (`latency.md` §13.5).

Trọng số và khối tensor lấy từ bảng `profile_memory` của ESP-DL trong log bản dò 14/10; thời gian dựng
lấy từ `bench_ai` 17–18/10, lượt sinh ra `runtime_compare.md`:

| Nhánh | File `.espdl` trên flash | Trọng số = bản chép ở PSRAM | Khối tensor ở PSRAM | Dựng mất |
|---|---:|---:|---:|---:|
| detect (YuNet) | 192,9 KB | 78,4 KB | 187,5 KB | 62 ms |
| spoof (MiniFASNet) | 577,1 KB | 464,2 KB | 568,8 KB | 123 ms |
| recog (MobileFaceNet-ECA) | 1.345,8 KB | 1.194,6 KB | 820,8 KB | 192 ms |

- **Object nhỏ:** thêm 73–89 KB mỗi model.
- **Tổng:** cả ba lấy 3.574 KB PSRAM và 0 KB RAM nội; `bench_ai` còn 4.500 KB PSRAM trống sau khi nạp.
- **Trên kiosk thật** PSRAM còn chứa 4 khung camera (1,2 MB), khung màn và các hàng đợi. Bản `fleet`
  ngày 10/10 còn 2.034.524 B trống với bộ model 24/09; bộ 14/10 lấy thêm 168 KB và chưa đo lại trên
  kiosk 🔬.
- **File lớn hơn phần trọng số** vì còn chứa mô tả đồ thị và cặp vào/ra mẫu cho `model->test()`.

### 1.3 Mỗi khung hình: chạy

Phần này chạy trong `ai_task`, trên lõi 1.

1. Camera dùng DMA ghi khung 480×320 RGB565 vào một trong 4 bộ đệm khung ở PSRAM.
2. `letterbox_frame` thu khung về 160×120, đổi sang int8 rồi ghi thẳng vào tensor đầu vào của detect
   (57.600 B). Tensor này nằm sẵn trong khối tensor của detect, không qua buffer trung gian nào.
3. `model->run()` chạy lần lượt từng module trong danh sách. Mỗi module làm bốn việc:
   - đọc tensor vào (kết quả của op trước) và trọng số, cả hai từ PSRAM qua cache;
   - tính bằng lệnh SIMD 128 bit của lõi Xtensa LX7: mỗi lệnh làm 16 phép nhân int8 và cộng dồn vào
     thanh ghi tích luỹ;
   - đưa kết quả về int8 bằng phép dịch bit. Làm được vậy vì ESP-DL dùng thang là luỹ thừa của 2 và
     điểm 0 bằng 0, nên không cần phép nhân;
   - ghi tensor ra vào chỗ đã định trong khối. Khi không op nào còn đọc tensor đó, chỗ của nó được
     tensor sau dùng lại.

   Kernel xử lý theo từng hàng hoặc từng dải để phần đang tính nằm gọn trong cache. Lúc chạy không có
   `malloc` nào: sau 50 lượt, heap không đổi một byte.
4. `decode_faces` đọc thẳng các tensor ra của detect, lấy hộp mặt và 5 điểm mốc, rồi lọc hộp trùng
   (NMS).
5. **Spoof:** khi hộp mặt đứng yên qua 2 lần detect, `crop_face` cắt mặt từ khung gốc 480×320, không
   cắt từ ảnh 160×120. Ảnh 80×80 được ghi vào tensor vào của spoof, model chạy và trả về điểm live.
6. **Recog:** nếu điểm live đạt `live_min`, `align_face` dùng 5 điểm mốc nắn mặt về 112×112 và ghi
   vào tensor vào của recog. Model chạy, ra vector 512 chiều, vector được chuẩn hoá về int8 (§5).
   Cuối cùng `svc_facedb_lookup` so cosine với bảng mặt, bảng này cũng nằm ở PSRAM.

Thời gian một mặt, median 50 lượt xen kẽ ba model, `bench_ai` 17–18/10 (`runtime_compare.md`):

| | Rảnh | Có tải preview |
|---|---:|---:|
| detect | 33,2 ms | 34,0 ms |
| spoof | 73,8 ms | 83,6 ms |
| recog | 246,7 ms | 278,9 ms |
| **Cả ba nối nhau** | **353,6 ms** | **406,2 ms** |

"Có tải" là lúc lõi 0 chép một khung 300 KB mỗi 70 ms, như preview thật. Hai lõi dùng chung đường vào
PSRAM nên model chậm thêm khoảng 15% (`latency.md` §16).

### 1.4 Trọng số đã có trên flash, sao còn chép sang PSRAM

Flash và PSRAM đều nằm ngoài chip và đều đọc qua cache. Chỗ khác nhau là bus khi cache trượt: PSRAM
8 dây, flash 4 dây. Đo 23/09 trên năm model: chép trọng số sang PSRAM làm model nhanh hơn từ 3% ở
detect tới 25% ở recog w64 (KẾ HOẠCH §3 lớp 5).

Cái giá phải trả:

- **Bộ nhớ:** bản chép tốn 1.737 KB PSRAM.
- **Thời gian khởi động:** chép cả ba file (2.115 KB) từ flash sang PSRAM đo được 111 ms.
- **An toàn trọng số:** flash chỉ đọc nên không gì ghi đè được trọng số. PSRAM thì khác: một lần ghi
  tràn heap có thể âm thầm làm hỏng trọng số mà không crash (KẾ HOẠCH §6.3). Vì vậy `bench_ai` chạy
  `model->test()` để so từng bit với mô phỏng, và kiểm heap qua 50 lượt.

Nếu tắt `AI_WEIGHTS_PSRAM_*`, trọng số được đọc thẳng từ vùng ánh xạ flash: tốn 0 byte RAM nhưng chậm
hơn.

### 1.5 "Tensor arena" là khái niệm của TFLM

Trong bản đối chứng TFLM, arena là một khối do firmware tự cấp, chia làm hai vùng:

- **Đuôi:** metadata, sống suốt đời model, nên cộng dồn qua các model.
- **Đầu:** activation, chỉ sống trong một lần `Invoke`, nên các model dùng chung và chỉ cần bằng cỡ
  của model lớn nhất.

Vì vậy cỡ arena là `Σ tail + max(head)` (KẾ HOẠCH §3.8). TFLM cũng xếp phần đầu bằng một bộ lập kế
hoạch tham lam (`greedy_memory_planner.cc`), nhưng xếp bên trong arena firmware đưa cho nó. Trọng số
TFLM đọc tại chỗ từ flash, tốn 0 byte RAM.

ESP-DL không nhận arena từ ngoài. Mỗi model giữ khối riêng nên bộ nhớ cộng dồn: 187,5 + 568,8 + 820,8
= 1.577 KB cho tensor. Bù lại, trên cùng ba model, ESP-DL nhanh hơn TFLM 5,4 lần (`latency.md` §13.1).

---

## 2. Trọng số và arena khác nhau thế nào, có nạp cả hai vào cache không

> **Hỏi.** Trọng số và arena có tác dụng khác gì nhau, vì sao lại tách hai phần, và có nạp cả hai
> vào cache không?

Trọng số là bản thân model. Arena là chỗ làm việc cho một lần chạy. Hai thứ này tách nhau từ bản
chất, runtime nào cũng vậy, không phải dự án tự chọn chia ra. Trong TFLM, arena chỉ giữ tensor cộng
metadata của chúng; trọng số không bao giờ nằm trong arena.

| | Trọng số | Tensor (thứ arena giữ) |
|---|---|---|
| Là gì | Các con số model học được lúc train: hệ số tích chập, bias, hệ số PReLU | Dữ liệu của đúng khung đang xử lý: ảnh vào, feature map sau từng lớp, đầu ra |
| Đổi khi nào | Không đổi, tới khi nạp model mới | Mỗi khung một bộ mới |
| Truy cập | Chỉ đọc | Ghi rồi đọc |
| Sống bao lâu | Suốt lúc máy chạy | Từ op sinh ra nó tới op cuối cùng đọc nó |
| Cỡ do đâu | Số tham số của kiến trúc | Cỡ feature map (cao × rộng × kênh) và số tensor phải sống cùng lúc |
| detect / recog | 78,4 KB / 1.194,6 KB | 187,5 KB / 820,8 KB |

So với C cho dễ hình dung: trọng số giống một mảng `const` nằm trong flash, còn tensor giống biến cục
bộ trên stack. Hàm chạy xong thì chỗ của biến cục bộ được lời gọi sau dùng lại.

### 2.1 Vì sao phải để riêng

Bốn khác biệt trong bảng kéo theo bốn cách xử lý khác nhau:

- **Chỉ đọc hay phải ghi.** Trọng số để được ở flash: TFLM đọc thẳng ở đó, tốn 0 byte RAM. Tensor thì
  không bao giờ để ở flash được, vì muốn ghi flash phải xoá cả sector 4 KB trước, vừa chậm vừa làm
  mòn chip.
- **Sống mãi hay sống ngắn.** Tensor nào hết người đọc thì chỗ của nó nhường cho tensor sau, nên bộ
  lập kế hoạch xếp chồng được chúng. 187,5 KB của detect là đỉnh của những tensor sống cùng một lúc,
  không phải tổng mọi tensor. Trọng số thì không xếp chồng được: lớp nào cũng cần trọng số của nó ở
  mọi khung.
- **Dùng chung giữa các model.** Ba model chạy lần lượt, nên TFLM cho chúng dùng chung phần activation
  (`max(head)`). Trọng số thì không chung được, mỗi model một bộ riêng.
- **Cỡ lớn theo hai kiểu.** Detect là model mảnh, ít kênh, ảnh vào lại to, nên tensor lớn hơn trọng
  số. Recog rộng và sâu nên ngược lại: trọng số nhiều hơn tensor.

### 2.2 Có nạp cả hai vào cache không

Không có bước "nạp vào cache" nào cả, cache là phần cứng tự lo:

- CPU đọc một địa chỉ chưa có trong cache thì cache tự kéo dòng 64 B chứa địa chỉ đó lên.
- Cache đầy thì tự đẩy dòng cũ ra; dòng nào đã bị ghi thì được ghi về PSRAM lúc đẩy ra.

Thứ duy nhất firmware tự chép là trọng số, từ flash sang PSRAM, một lần lúc khởi động.

Nhưng đúng là cả hai đều đi qua cache. Mọi lần CPU đọc hay ghi bộ nhớ ngoài, dù flash hay PSRAM, đều
qua cache dữ liệu 64 KB, và cache không phân biệt trọng số với tensor. TFLM cũng thế: trọng số đọc từ
flash, tensor nằm ở PSRAM, cả hai qua cùng một cache.

Cache chỉ có 64 KB, trong khi ba model chiếm 3,5 MB. Nên lúc nào cache cũng chỉ giữ một lát mỏng: vài
hàng của tensor vào, phần trọng số của lớp đang tính, vài hàng của tensor ra. Tới khung sau, các dòng
đó đã bị đẩy ra từ lâu, nên lượt nào cũng phải kéo trọng số từ PSRAM lên lại.

Hai thứ dùng cache theo hai kiểu khác nhau:

- **Trọng số được dùng lại rất nhiều trong một lớp.** Tích chập áp cùng một bộ trọng số lên mọi vị trí
  của feature map. Ví dụ lưới 40×30 thì mỗi trọng số được dùng 1.200 lần trong một lượt, nên kéo lên
  cache một lần là dùng được nhiều lần.
- **Tensor chỉ được đọc trong một khoảng ngắn.** Op sau đọc nó, có khi thêm một phép cộng ở nhánh tắt,
  rồi thôi. Cái khó là một feature map thường to hơn cả cache, nên phần đầu đã bị đẩy về PSRAM trước
  khi op sau kịp đọc tới.

Vì vậy kernel chạy theo hàng hoặc theo dải: mỗi lần xử lý vài hàng, để hàng vào, trọng số và hàng ra
cùng vừa cache. Ở detect, mỗi cặp tích chập 1×1 + depthwise còn được gộp thành một op
`PointwiseDepthwise`, chạy theo dải qua vùng đệm 8 KB. Nhờ vậy tensor nằm giữa hai op không bao giờ
phải ghi đầy ra PSRAM rồi đọc lại (`latency.md` §14.8). Spoof và recog trong bộ deploy không có cặp
nào, vì giữa hai tích chập của chúng có PReLU (§8).

Có một cách bắt cache kéo trước dòng kế tiếp, gọi là autoload. Đo thử thì chỉ nhanh thêm 0,7–6,2% tuỳ
nhánh (`latency.md` §14.7). Kiosk không bật vì đó là cấu hình của cả chip, mà camera, màn hình và
Wi-Fi cũng đi qua cache dữ liệu.

---

## 3. Khung 480×320 đi từ camera tới model

> **Hỏi.** Ảnh 480×320 ban đầu được đưa vào queue, rồi các model sau cắt ảnh bằng cách đọc ở địa chỉ
> ban đầu đó?

Đúng gần hết, chỉ một chỗ khác: queue không chứa ảnh mà chỉ chứa con trỏ tới khung (`camera_fb_t *`,
4 byte). 300 KB điểm ảnh không di chuyển đi đâu. Chúng nằm yên trong bộ đệm PSRAM mà DMA của camera
đã ghi vào, và ba model cùng đọc ở đúng địa chỉ đó.

```
cảm biến ──DMA──▶ [khung 1][khung 2][khung 3][khung 4]    4 × 300 KB ở PSRAM
                      │
cam_task (lõi 0): grab → vẽ preview → offer_to_ai ──▶ q_frame_ai (1 ô, giữ con trỏ)
                                                         │
ai_task (lõi 1):                        xQueueReceive ◀──┘
                    detect ─┐
                    spoof  ─┼─ cùng đọc frame->buf
                    recog  ─┘
                    drv_camera_release → khung trả về cho cảm biến
```

### 3.1 Đường đi của một khung

Code ở `firmware/main/app_tasks.c` và `firmware/components/svc_vision/src/`:

1. `cam_task` lấy khung bằng `drv_camera_grab()` và vẽ preview từ chính bộ đệm đó.
2. `offer_to_ai` bỏ con trỏ vào `q_frame_ai`. Queue chỉ có một ô và khung mới nhất được giữ: nếu AI
   chưa lấy khung trước, khung đó được trả lại cho camera để nhường chỗ.
3. `ai_task` lấy con trỏ ra. `svc_vision_step` bọc `frame->buf` thành
   `ai_engine_frame_t {pixels, width, height}`. Bước này vẫn dùng đúng địa chỉ cũ, không chép gì.
4. Chạy xong cả lượt, `ai_task` mới trả khung cho camera ghi khung mới vào (`drv_camera_release`).

### 3.2 Mỗi model đọc gì từ khung gốc

- **detect:** `letterbox_frame` đọc cả khung, thu về 160×120 rồi ghi vào tensor vào của detect. Hộp
  mặt và 5 điểm mốc ra theo toạ độ 160×120. `ai_engine_face_to_frame` dùng tỉ lệ thu và phần viền đen
  để đổi chúng về toạ độ 480×320.
- **spoof:** `crop_face` chỉ đọc vùng trong hộp mặt, ở độ phân giải gốc, rồi đưa về 80×80.
- **recog:** `align_face` đọc vùng quanh 5 điểm mốc trên khung gốc rồi nắn về 112×112.

Thứ duy nhất bị chép là bản đã thu nhỏ hoặc đã cắt, ghi vào tensor vào của từng model: 57,6 KB,
19,2 KB và 37,6 KB. Khung đầy đủ không bao giờ bị chép.

### 3.3 Vì sao làm vậy được

- **Cả ba model chạy trên cùng một khung, trong cùng một `step`** (`VisionPipeline::step`). Spoof và
  recog dùng đúng hộp mặt detect vừa tìm trên khung ấy, nên hộp và điểm ảnh luôn khớp nhau.
- **Không cần khoá, cũng không cần chép.** Mỗi lúc chỉ một task giữ khung. Sau `offer_to_ai`,
  `cam_task` không đụng lại khung đó nữa, và camera chỉ ghi lại vào bộ đệm sau `drv_camera_release`.
  Nên không ai ghi vào khung trong lúc AI đang đọc.

Cái giá là AI giữ khung suốt cả lượt, tới khoảng 350 ms khi có mặt cần xác minh. Vì vậy camera cần
đúng 4 bộ đệm: một cho AI giữ, một nằm chờ trong queue, một cho `cam_task` đang vẽ, một cho cảm biến
đang ghi. Với 3 bộ đệm, preview chỉ được 8,1 fps; với 4 bộ đệm là 14,18 fps (KẾ HOẠCH §6.3).

---

## 4. `align_face` nắn mặt về toạ độ đầu vào của recog

> **Hỏi.** `align_face` đọc vùng quanh 5 điểm mốc trên khung gốc rồi nắn về 112×112. Vậy từ ảnh ngang
> hay ảnh ngược, nó xoay về đúng toạ độ đầu vào?

Có hai việc riêng, làm ở hai chỗ khác nhau. Lật ngược thì cảm biến làm, trước khi khung tới PSRAM.
`align_face` chỉ sửa ba thứ: đầu nghiêng, cỡ mặt và vị trí mặt.

### 4.1 Khung tới PSRAM đã đứng thẳng

- **Ảnh ngược:** module camera gắn lens phía trên đầu nối, nên ảnh gốc của nó bị lộn ngược. Driver bật
  `vflip = 1` để OV5640 tự lật ảnh ngay trong cảm biến, và bật `hmirror = 1` để preview giống soi
  gương (`drv_camera.c`, KẾ HOẠCH §2.1). Không có code nào xoay cả khung bằng phần mềm.
- **Ảnh ngang:** khung 480×320 nằm ngang chỉ có nghĩa là góc nhìn rộng, còn người đứng trước kiosk vẫn
  thẳng đứng trong khung. Màn dọc 320×480 chỉ hiện lát giữa 213×320 rồi phóng cho kín màn; model thì
  đọc cả khung.
- **Detect:** khung được thu đúng 1/3, còn 160×107, đặt vào tensor 160×120, thừa 6 hàng đen phía trên
  và 7 hàng phía dưới (`letterbox.cpp`). Hộp mặt và 5 điểm mốc ra theo toạ độ 160×120, rồi được đổi về
  khung gốc bằng `(toạ độ − viền) / (1/3)`.

### 4.2 `align_face` nắn mặt thế nào

Code ở `firmware/components/ai_engine/src/recognition/align.cpp`. Recog được train trên ảnh MS1MV3 cắt
theo một khuôn cố định: 5 điểm mốc luôn nằm ở đúng các vị trí này trên lưới 112×112.

| Điểm mốc | Vị trí trên lưới 112×112 |
|---|---|
| Mắt bên trái ảnh | (38,3; 51,7) |
| Mắt bên phải ảnh | (73,5; 51,5) |
| Mũi | (56,0; 71,7) |
| Khoé miệng trái | (41,5; 92,4) |
| Khoé miệng phải | (70,7; 92,2) |

Có hai bước:

1. **`fit()`** tìm một phép biến đổi gồm xoay một góc θ, phóng đều một hệ số s và dời đi, sao cho 5
   điểm mốc detect tìm được rơi gần nhất vào 5 vị trí trên. Đây là bình phương tối thiểu dạng đóng
   nên không cần lặp, và không giới hạn góc xoay. Ví dụ đầu nghiêng 20° thì đường hai mắt nghiêng 20°,
   phép fit ra θ ≈ −20°, và ảnh ra có hai mắt nằm ngang ở hàng ~51,6.
2. **Vòng warp** đi qua từng điểm của ảnh đích 112×112. Với mỗi điểm, nó dùng phép biến đổi ngược để
   tìm điểm đó nằm ở đâu trên khung gốc. Chỗ đó thường là toạ độ lẻ, nên nó lấy 4 pixel RGB565 xung
   quanh và nội suy song tuyến. Điểm rơi ra ngoài khung thì lấy pixel ở mép. Kết quả được lượng tử về
   int8 và ghi thẳng vào tensor vào của recog. Đi theo ảnh đích thay vì ảnh nguồn thì ô nào của
   112×112 cũng có giá trị, không bị lỗ khi phóng to.

Tóm lại, dù mặt nằm ở góc nào của khung, to hay nhỏ, nghiêng bao nhiêu, recog luôn nhận một mặt đặt
đúng như lúc train.

### 4.3 Những thứ align không sửa được

- **Quay trái/phải, cúi/ngửa.** Đây là xoay trong không gian ba chiều: phía mặt bị khuất thì phép biến
  đổi phẳng không vẽ lại được. Pipeline đo góc quay ngang bằng chính 5 điểm mốc: chiếu vectơ từ trung
  điểm hai mắt tới mũi lên trục hai mắt. Phép đo này không đổi khi đầu chỉ nghiêng. Lúc đăng ký,
  pipeline chỉ giữ mẫu có góc quay nằm trong khoảng cho phép.
- **Ảnh gương.** Phép fit không bao giờ lật gương. Không cần lật, vì mặt lúc đăng ký và lúc chấm công
  đều lấy từ khung đã qua cùng `hmirror` của kiosk, nên luôn cùng chiều. Lật gương vẫn có một bẫy, đã
  sập một lần: dấu của góc quay ngang phải đo trên board mới biết, không suy ra bằng lập luận được
  (KẾ HOẠCH §4.5.5h.2).
- **Mặt nghiêng quá nhiều.** Phép fit làm được với mọi góc, nhưng nó cần 5 điểm mốc. Detect không tìm
  ra mặt thì không có gì để nắn.

---

## 5. `l2norm` làm gì

> **Hỏi.** `l2norm` là làm gì?

`l2norm` chuẩn hoá vector embedding mà recog trả ra cho dài đúng 1. Sau bước này vector chỉ còn mang
hướng, không còn mang độ dài. Code ở hàm `normalized_int8` trong
`firmware/components/ai_engine/src/recognition/l2norm.cpp`; bản Python
`ml/src/facepipe/tasks/recognition/postproc/l2norm.py` phải khớp nó từng bước.

### 5.1 Ba bước

Recog trả ra 512 số int8, mỗi số nhân với thang 2^exp. Đó là một điểm trong không gian 512 chiều, coi
như "dấu vân" của khuôn mặt. Ví dụ dưới đây rút gọn còn 3 chiều cho dễ nhìn.

1. **Giải lượng tử:** nhân mỗi số int8 với thang để ra số thực. Ví dụ ra vector (3, 4, 0).
2. **Chia cho độ dài:** độ dài = √(3² + 4² + 0²) = 5, nên vector thành (0,6; 0,8; 0), dài đúng 1. Nếu
   vector toàn số 0 (khung hỏng) thì nó giữ nguyên là 0: mẫu số có sàn 1e-10 nên không bao giờ chia
   cho 0.
3. **Lượng tử lại về int8:** mỗi vector có một scale riêng, chọn sao cho phần tử lớn nhất thành ±127,
   tức dùng hết 8 bit. Ở ví dụ, phần tử lớn nhất là 0,8, nên scale = 0,8/127 và vector int8 ra
   (95, 127, 0). Kết quả là 512 byte cộng một số scale; cặp này ghi vào bản ghi của `faces.bin`, nhỏ
   hơn 4 lần so với lưu float32 (KẾ HOẠCH §6.2.4).

### 5.2 Vì sao bỏ độ dài

Model recog được train bằng ArcFace. Loss này chuẩn hoá vector trước khi so, nên danh tính chỉ nằm ở
hướng của vector. Độ dài thì dao động theo từng lần chụp: ảnh mờ hay rõ, sáng hay tối. Theo KẾ HOẠCH
§4.5.6, hai lần chụp cùng một mặt lệch nhau về độ dài còn nhiều hơn hai người khác nhau lệch nhau về
hướng. Ở ví dụ trên, lần chụp sau có thể ra (6, 8, 0), nhưng chia cho độ dài xong vẫn là (0,6; 0,8; 0).

Vì chỉ còn hướng, so hai khuôn mặt nghĩa là so góc giữa hai vector, đo bằng cosine. Cosine càng gần 1
thì hai mặt càng giống nhau; gần 0 là hai mặt không liên quan. Ngưỡng `match_min_score` đặt trên chính
con số cosine này.

### 5.3 Phép so nằm ở đâu

Hàm so là `CosineLinearMatcher::best` trong `firmware/components/svc_facedb/src/embedding_index.cpp`.
Nó làm hai việc:

- Nhân vô hướng hai vector int8 bằng một nhân assembly SIMD (`dot_s8_esp32s3.S`).
- Chia kết quả cho căn của tích bình phương độ dài hai vector. Bình phương độ dài của các mẫu trong
  bảng được tính sẵn từ trước.

Scale không có mặt trong phép so, vì cosine triệt tiêu mọi hệ số dương.

### 5.4 Đã chia độ dài lúc so rồi, sao vẫn cần l2norm

- **Điểm cosine không đổi.** Phép so trên kiosk đã tự chia cho độ dài của cả hai vector, nên bỏ l2norm
  đi thì điểm cosine vẫn y hệt.
- **512 số int8 cũng gần như không đổi.** Scale được chọn theo phần tử lớn nhất, nên dù có chuẩn hoá
  hay không, vector int8 ra gần như giống nhau.
- **Thứ l2norm thật sự đổi là con số scale.** Có l2norm thì int8 × scale luôn dựng lại đúng một vector
  dài 1, ở bất cứ đâu:
  - phía Python khi chấm model (`l2norm.py`);
  - mẫu kiosk báo lên server;
  - mẫu server đẩy sang các kiosk khác.

Nhờ vậy, mọi nơi đọc mẫu đều hiểu nó cùng một cách.

---

## 6. TFLM + esp-nn và ESP-DL: vì sao TFLM phải đăng ký op

> **Hỏi.** So sánh kiến trúc của TFLite + esp-nn với ESP-DL. Vì sao bên TFLite + esp-nn phải đăng ký
> op?

Cả hai runtime đều cần một bảng tra op. TFLM bắt mình tự điền bảng, ESP-DL tự điền hết. Mọi khác biệt
về flash và về lỗi thiếu op đều đến từ chỗ đó.

### 6.1 Ba cái tên trong "TFLite + esp-nn"

- **TFLite Micro (TFLM)** là runtime: bộ đọc file, bộ cấp bộ nhớ (arena) và vòng chạy từng node.
- **esp-nn** chỉ là thư viện kernel: các hàm tối ưu cho S3 như `esp_nn_conv_s8` hay `esp_nn_add_s8`.
  Nó không biết model là gì.
- **esp-tflite-micro** là lớp nối hai thứ trên. Lúc build, nó bỏ file kernel tham chiếu của TFLM cho 7
  op (add, conv, depthwise_conv, fully_connected, mul, pooling, softmax) và thay bằng bản trong
  `kernels/esp_nn/`, là bản gọi sang esp-nn.

ESP-DL thì gói tất cả trong một: runtime, kernel và định dạng file riêng. Trên máy tính có ESP-PPQ để
lượng tử và xuất file.

### 6.2 Vì sao TFLM phải đăng ký op

File `.tflite` chỉ là dữ liệu. Nó ghi kiểu "node 5 là op số 3 (CONV_2D)", không chứa code. Runtime cần
một bảng đổi số op ra code, gồm các hàm init, prepare và invoke của kernel. Bảng đó là *resolver*.

Vi điều khiển không nạp code động được. Thứ gì bảng trỏ tới thì linker phải giữ lại trong flash, thứ gì
không ai trỏ tới thì bị bỏ. Nên nội dung bảng quyết định cỡ flash:

- **`AllOpsResolver`** khai gần như mọi op, kéo theo mọi kernel, làm flash phình ra. CLAUDE.md §6 cấm
  dùng.
- **`MicroMutableOpResolver<N>`** chỉ khai đúng op model dùng: detect 6 op, spoof 9, recog 10
  (`firmware/components/ai_engine/src/<nhánh>/tflm/ops.cpp`). `N` là cỡ một mảng tĩnh, không cấp phát
  heap.

Cái giá là danh sách phải khớp với model. Thiếu một op thì `AllocateTensors` từ chối đồ thị ngay trên
board. Vì vậy `ml/src/facepipe/export/tflite_op_check.py` đọc các file `ops.cpp` và đối chiếu với file
`.tflite` trước khi nạp.

esp-nn không đổi gì ở bước đăng ký. Vẫn là `AddConv2D()`; nó trỏ vào bản esp-nn hay bản C tham chiếu
là do lớp nối quyết định lúc build. Op nào lớp nối không có bản esp-nn thì chạy bằng C tham chiếu:
PAD, MEAN, LOGISTIC, RESIZE, PRELU. Riêng MEAN rất đáng chú ý: esp-nn có kernel cho nó, nhưng lớp nối
không có file `reduce.cc`, nên kernel đó thành code chết. 32,1 ms của MEAN trong spoof TFLM đo 19/09
vì thế chạy bằng C (`latency.md` §12.2).

### 6.3 ESP-DL cũng có bảng, chỉ là tự điền

- File `.espdl` gọi op bằng tên chuỗi như `"Conv"` hay `"Add"`. `ModuleCreator` đổi tên ra hàm dựng
  module.
- Hàm khởi tạo của `dl::Model` gọi `register_dl_modules()`, đăng ký sẵn 71 module có trong thư viện.
  Dự án đăng ký thêm 7 module tự viết qua `register_espdl_modules()` trong `espdl_model.cpp`, ví dụ
  `PointwiseDepthwise`, mà không phải sửa code của Espressif.
- Bảng trỏ tới cả 71 module nên linker giữ hết: **858 KB** flash, cộng 21 KB `libfbs_model`, so với
  145 KB của TFLM + esp-nn. Muốn bớt thì phải sửa code Espressif, mà CLAUDE.md §6 cấm. Đó là lý do
  slot OTA phải lên 2,75 MB (KẾ HOẠCH §6.1).
- Thiếu op thì cũng chết như TFLM, mà còn nặng hơn: ESP-DL không có bản C dự phòng. Op lạ làm việc
  dựng dừng giữa chừng, đồ thị không có đầu ra. Op `Expand` trong bản FRBench đầu tiên gây boot lặp
  129 lần chính vì vậy. `ml/src/facepipe/export/espdl_op_check.py` đối chiếu op với đúng bản esp-dl mà
  firmware build cùng, cộng các module `ai_engine` tự đăng ký.

Tóm lại, TFLM nghĩa là "khai cái mình cần": flash nhỏ, nhưng phải giữ danh sách khớp với model. ESP-DL
nghĩa là "khai sẵn tất cả": không có danh sách để giữ, nhưng flash lớn. Cả hai đều cần một bước kiểm op
lúc xuất model.

### 6.4 So kiến trúc

| | TFLM + esp-nn (đối chứng) | ESP-DL (deploy) |
|---|---|---|
| File model | `.tflite`, op là số | `.espdl`, op là tên; trọng số xếp sẵn theo kiểu kernel cần, căn 16 B |
| Tra op | Resolver tự khai | Tự đăng ký 71 module, cộng 7 của dự án |
| Flash của runtime | 145 KB | 858 KB + 21 KB |
| Kernel | esp-nn cho 7 op, còn lại C tham chiếu | Mọi op có kernel assembly cho S3, không có đường dự phòng |
| Lượng tử | Trọng số per-channel; activation có zero point; đổi thang bằng hệ số nhân 32 bit rồi dịch | Per-tensor, đối xứng, thang luỹ thừa 2; đổi thang chỉ là dịch bit |
| Phép nhân SIMD | Zero point ép nhân 16 bit (`ee.vmulas.s16`): 8 số mỗi lệnh | Nhân thẳng 8 bit (`EE.VSMULAS.S8`): 16 số mỗi lệnh |
| Bộ nhớ tensor | Một arena do firmware cấp, ba model chung: Σ tail + max(head) | Mỗi model tự lập kế hoạch rồi tự cấp, cộng dồn |
| Trọng số | Đọc tại chỗ trên flash | Chép sang PSRAM |
| Kiểm trên chip | So hậu xử lý với golden (`contracts/golden/`) | `model->test()` so từng bit với mô phỏng ESP-PPQ |

Hai phép đo tốc độ, mỗi phép một bộ model:

| Bộ model, một lượt ba model, rảnh | TFLM + esp-nn | ESP-DL |
|---|---:|---:|
| Bộ cũ `1616` / `1050` / `1750`, đo 23/09 (`latency.md` §13.1) | 1.271 ms | 234 ms (5,4 lần) |
| Bộ đang deploy, đo 17–18/10 (`runtime_compare.md`) | 3.717,7 ms | 353,6 ms (10,5 lần) |

### 6.5 Chênh lệch tốc độ nằm ở kernel, không nằm ở các op chạy C

Ở bộ TFLM đo 19/09, **94,1%** thời gian cả pipeline đã nằm trong kernel esp-nn; bốn op chạy C chỉ chiếm
phần còn lại, 74,7 ms (`latency.md` §12.2). Vậy ESP-DL nhanh hơn ở chính conv và depthwise, chủ yếu
nhờ lượng tử đối xứng. Không có zero point thì không phải trừ nó trước khi nhân, nên nhân thẳng được ở
8 bit, mỗi lệnh 128 bit làm gấp đôi số phép tính. KẾ HOẠCH §3 lớp 4 ghi đây là phần lớn của mức nhanh
5,6 lần đo ở trial 23/09.

ESP-DL cũng phải trả giá cho luật lượng tử ấy. Per-tensor kém per-channel, nên phải bật layerwise
equalization: tắt đi thì spoof chỉ giữ được 40/62 mặt thật trên 87 khung.

---

## 7. Bảng op của recog trên TFLM

> **Hỏi.** Phải đăng ký ở `recognition/tflm/ops.cpp`. Từng dòng ở đó để làm gì?

File `firmware/components/ai_engine/src/recognition/tflm/ops.cpp` là bảng op của nhánh recog khi build
bằng TFLM. Chạy op check trên đúng file recog mà bench TFLM nạp:

```
make tflite-op-check MODEL=artifacts/recognition/tflite/mobilefacenet_eca_int8_q1_2106_9a6954.tflite BRANCH=recognition
```

Kết quả: đồ thị có **189 node nhưng chỉ 10 loại op**, khớp đủ 10 dòng `Add…` trong file, không thiếu
loại nào.

### 7.1 Từng dòng trong file

- **`MicroMutableOpResolver<10>`**: bảng cố định 10 ô, là một mảng tĩnh, không dùng heap. Số 10 là số
  *loại* op, không phải số node: 47 node CONV_2D dùng chung một kernel conv. Gọi `Add` tới lần thứ 11
  thì bảng báo lỗi.
- **`recog_ops()` và `s_registered`**: bảng được điền một lần, ở lần gọi đầu tiên.
  `TfliteModelBase::init` đưa bảng cho `MicroInterpreter`. Trong lúc đọc file `.tflite`, interpreter
  tra số op của từng node trong bảng này để lấy kernel.

### 7.2 Mỗi dòng `Add…` phục vụ phần nào của MobileFaceNet-ECA

| Dòng | Op | Số node | Dùng ở đâu | Kernel |
|---|---|---:|---|---|
| `AddConv2D` | CONV_2D | 47 | Tích chập đầu, các tích chập 1×1, và 15 tích chập theo kênh của ECA | esp-nn |
| `AddDepthwiseConv2D` | DEPTHWISE_CONV_2D | 17 | Depthwise của từng khối, và GDC 7×7 ở cuối | esp-nn |
| `AddAdd` | ADD | 12 | Nhánh tắt residual | esp-nn |
| `AddMul` | MUL | 15 | ECA nhân feature với trọng số kênh | esp-nn |
| `AddFullyConnected` | FULLY_CONNECTED | 1 | Lớp cuối ra vector 512 chiều | esp-nn |
| `AddPrelu` | PRELU | 33 | Hàm kích hoạt sau các tích chập | C tham chiếu |
| `AddMean` | MEAN | 15 | ECA lấy trung bình trên H×W | C tham chiếu |
| `AddLogistic` | LOGISTIC | 15 | Sigmoid của ECA | C tham chiếu |
| `AddReshape` | RESHAPE | 30 | Đổi dáng tensor, 2 lần mỗi khối ECA | C tham chiếu |
| `AddPad` | PAD | 4 | Đệm viền, đứng riêng thành op | C tham chiếu |

Cứ một khối ECA là sáu node nối nhau: MEAN → RESHAPE → CONV_2D → RESHAPE → LOGISTIC → MUL
(`ECAModule.across_channels_2d` trong `ml/src/facepipe/tasks/recognition/model/mobilefacenet_eca.py`).
Có 15 khối, nên MEAN, LOGISTIC, MUL đều là 15 và RESHAPE là 30.

### 7.3 Sửa file này thì chuyện gì xảy ra

- **Bỏ một dòng, ví dụ `AddPrelu()`:** đồ thị vẫn còn 33 node PRELU. Lúc boot, `AllocateTensors` từ
  chối đồ thị, `ai_engine_init` trả lỗi, và kiosk không có recog. `make tflite-op-check` bắt được lỗi
  này ngay trên máy tính: nó đọc chính các dòng `s_resolver.AddXxx()` trong file này rồi đối chiếu với
  đồ thị.
- **Thêm một op model không dùng:** vẫn chạy bình thường, nhưng kernel của op đó bị link vào và tốn
  flash vô ích.
- **Đổi model:** sửa danh sách này rồi chạy lại op check trước khi nạp.

### 7.4 Tốc độ

5 trong 10 loại op không có bản esp-nn, nên chạy bằng C tham chiếu của TFLM. Chúng chiếm 97 trên 189
node. Cùng model này, recog chạy (`runtime_compare.md`):

| Runtime | Thời gian |
|---|---:|
| ESP-DL | 246,4 ms |
| TFLM + esp-nn | 2.704,3 ms |
| TFLM, esp-nn chạy bản C | 12.854,3 ms |

Lượt đo này chưa có bảng thời gian theo từng op, nên chưa tách được bao nhiêu trong 2,7 s là của 5 op
chạy C 🔬.

Bên ESP-DL không có file tương đương cho từng nhánh, vì 71 module có sẵn tự đăng ký hết. Chỗ gần nhất
là `register_espdl_modules()` trong `espdl_model.cpp`; hàm đó chỉ đăng ký 7 module do dự án tự viết.

---

## 8. Bản vá bên Python và module tự viết bên C

> **Hỏi.** Các bản vá bên Python có tác dụng gì? Còn các bản viết thêm bên C để đăng ký module tự
> viết thì sao?

Python sửa đồ thị trước khi nó thành file `.espdl`. C chạy những op mới mà đồ thị đã sửa có chứa. Hai
bên khớp nhau qua bốn thứ: **tên op, tên thuộc tính, cách xếp trọng số và phép làm tròn**.

### 8.1 Vì sao phải vá

ESP-PPQ 1.3.11 (Python) lượng tử, mô phỏng và xuất file `.espdl`; esp-dl 3.3.11 (C) chạy file đó. Bản
vá xử lý hai loại lỗi:

- **Mô phỏng lệch chip.** ESP-PPQ tính một kiểu, chip tính kiểu khác. Hậu quả là `model->test()` hỏng,
  hoặc thước chấm chấm nhầm số nguyên.
- **Đúng nhưng chậm.** Đồ thị xuất ra tính đúng, nhưng rơi vào đường chậm của esp-dl: `Transpose` bị
  chèn thêm, ReLU6 chạy bằng bảng tra, PReLU chạy riêng, số kênh không chia hết cho 16, trọng số to
  hơn cache.

Mỗi bản vá trong `ml/src/facepipe/compress/quant/esp_ppq_patches.py` là một context manager. Nó thay
tạm vài hàm của ESP-PPQ, chỉ trong lúc nhánh nào khai nó ở `ml/configs/common/quant.yaml` đang lượng
tử, mô phỏng hoặc xuất. Có hai loại:

- **Bản vá xuất: không đổi một số nguyên nào**, nên bật ở mọi hàng của nhánh (`esp_ppq_patches`). Mỗi
  bản có test so số nguyên của bản xuất có vá và không vá.
- **Bản vá làm tròn: đổi số nguyên chip ra** (`rounding_patches`). Loại này luôn kèm phần mô phỏng
  phép làm tròn mới. Nó chỉ được dựng thành hàng biến thể của thang lượng tử, và thước chất lượng quyết
  có giữ hay không (KẾ HOẠCH §3.7).

| Nhánh | Bản vá xuất | Bản vá làm tròn |
|---|---|---|
| detect | `im2col_convolutions`, `pointwise_depthwise` | `clip_as_relu` |
| spoof | `cache_sized_convolutions`, `padded_channels`, `im2col_convolutions`, `pointwise_depthwise`, `mul_add`, `spatial_mean` | `fused_prelu`, `prelu_on_input_grid` |
| recog | `cache_sized_convolutions`, `channel_conv`, `im2col_convolutions`, `pointwise_depthwise`, `mul_add` | `fused_prelu`, `prelu_on_input_grid` |

### 8.2 Mỗi bản vá Python đi với module C nào

Module C nằm ở `firmware/components/ai_engine/src/core/espdl/`.

| Bản vá Python | Op mới trong `.espdl` | Module C | Đường chậm bị bỏ | Có trong bộ deploy |
|---|---|---|---|---|
| `cache_sized_convolutions` | `ConvSlices` | `espdl_conv_slices.cpp` | Tích chập 1×1 có trọng số ≥ 64 KB phải đọc lại từ PSRAM ở mỗi điểm | spoof, recog |
| `channel_conv` | `ChannelConv` | `espdl_channel_conv.cpp` | 5 op của ECA: Squeeze, 2 Transpose, Conv 1-D, Unsqueeze | recog |
| `im2col_convolutions` | `ConvIm2col` | `espdl_conv_im2col.cpp` + `conv_row_s8_esp32s3.S` | Tích chập đầu trên 3 kênh RGB chạy đường không căn 16 | cả ba |
| `pointwise_depthwise` | `PointwiseDepthwise` | `espdl_pointwise_depthwise.cpp` + 3 file `.S` | Tensor giữa 1×1 và depthwise đi một vòng qua PSRAM | detect |
| `mul_add` | `MulAdd` | `espdl_mul_add.cpp` + `mul_add_s8_esp32s3.S` | Tích của cổng ECA/SE ghi ra PSRAM rồi mới cộng | spoof, recog |
| `spatial_mean` | `SpatialMean` | `espdl_spatial_mean.cpp` | `ReduceMean` cộng bằng vòng C tổng quát | spoof |
| `fused_prelu` (làm tròn) | `ConvPRelu` | `espdl_conv_prelu.cpp` | PRelu chạy riêng, vì `Conv` của esp-dl bỏ trống con trỏ alpha | không |
| `padded_channels` | không có op mới | dùng `Conv` của esp-dl | Kênh lệch 16, đệm thêm kênh 0 | spoof |
| `clip_as_relu` (làm tròn) | không có op mới | `Relu` gộp vào `Conv` | ReLU6 chạy riêng bằng bảng tra | detect |

Bảy op mới ứng với đúng bảy dòng `register_module` trong `register_espdl_modules()`. `pointwise_depthwise`
chỉ ghép được cặp 1×1 → depthwise đứng sát nhau. Ở spoof và recog, PReLU đứng giữa hai tích chập, nên
cặp chỉ xuất hiện khi `fused_prelu` gộp PReLU vào tích chập trước. Hàng gộp PReLU của hai nhánh ấy
trượt cửa chất lượng, nên bộ deploy của chúng không có cặp `PointwiseDepthwise` nào (`latency.md`
§14.19).

### 8.3 Đi qua một cặp cụ thể: `ChannelConv`

1. **Phía Python.** `channel_conv_from` tìm chuỗi Squeeze → Transpose → Conv 1-D → Transpose →
   Unsqueeze. Nó xoá 5 op đó và chèn một op kiểu `"ChannelConv"`, mang thuộc tính `kernel_shape` và
   `pads`, giữ nguyên trọng số và lưới lượng tử. Bộ xuất ghi node ấy vào `.espdl`.
2. **Trên board.** `dl::Model` đọc thấy tên `"ChannelConv"`, tra ra `channel_conv_from` bên C.
   `ChannelConv::deserialize` đọc đúng ba thuộc tính `kernel_shape`, `pads`, `quant_type`; lệch bất kỳ
   thứ gì thì từ chối.
3. **Lúc chạy.** `forward` tính tích chập 1-D dọc theo kênh, làm tròn half-up rồi bão hoà int8 y như
   đoạn cuối nhân của esp-dl. Vì vậy số nguyên không đổi, và `model->test()` vẫn khớp từng bit.
4. **Kết quả.** 15 `ChannelConv` tốn 0,7 ms, thay cho 30 `Transpose`, 30 `Squeeze`/`Unsqueeze` và 15
   Conv 1-D (`latency.md` §14.7).

Sửa một bên mà quên bên kia thì hỏng ngay: module từ chối lúc dựng, hoặc `test()` lệch. Phần mô phỏng
còn phải chép theo mã máy của nhân esp-dl (`objdump`), không chép theo mã C. Lý do là esp-dl build với
`-ffast-math -O3`, nên trình biên dịch đã đổi thứ tự các phép float (KẾ HOẠCH §3.7).

### 8.4 Kết quả trên kiosk

Một mặt qua cả ba nhánh, đo bằng bản dò trên kiosk (`latency.md` §14.18–14.19):

| Bản vá đang bật | Thời gian |
|---|---:|
| Chưa vá | 444,8 ms |
| Chỉ bản vá xuất | 333,8 ms (−25%) |
| Chồng thêm bản vá làm tròn | 251,6 ms (−43,4%) |
| Bộ đang deploy, sau cửa chất lượng | 349,3 ms |

Bộ đang deploy chậm hơn dòng thứ hai vì hai lý do. Hàng gộp PReLU của spoof và recog trượt cửa chất
lượng. Hàng spoof được chọn lại mang một lớp int16. Riêng detect giữ được `clip_as_relu`.

---

## 9. So với esp-sr: hai hướng vá

> **Hỏi.** Liên hệ với các bản vá bên esp-sr. Có phải có hai hướng: bên này vá thêm module mới, tối ưu
> cả cách bố trí để trọng số vừa cache; còn esp-sr chỉ vá trong phạm vi esp-dl?

esp-sr là dự án nhận dạng giọng nói trên ESP32-S3 của cùng tác giả, repo riêng, cũng chạy model bằng
ESP-PPQ và esp-dl. Đúng là có hai hướng, nhưng chỗ "trọng số vừa cache" thì ngược lại: đó chính là bản
vá của esp-sr. Ranh giới thật giữa hai hướng nằm ở chỗ khác.

### 9.1 Những gì lấy từ esp-sr

- **Bộ khung.** Quy trình bốn bước (đúng → nhanh → chất lượng → chốt), bộ hạ tầng (`ptq_espdl`,
  `mixed_espdl`, `qat_espdl`, `espdl_profile`, bản dò) và kiểu sổ `PATCHES` + `applied()` đều có từ
  esp-sr. Chủ repo chốt theo quy trình này ngày 12/10 (TASKS E9-T32).
- **esp-sr có 16 bản vá, không cái nào cần module C.** Firmware esp-sr không tự đăng ký module nào.
  Các bản vá bên đó chia ba nhóm:
  - sửa mô phỏng cho khớp chip: `requantise_graph_inputs`, `fuse_passive_ops_on_graph_inputs`,
    `rmsnorm`/`layernorm`/`softmax_as_espdl`;
  - sửa đồ thị cho esp-dl nạp được: `conv_caches_along_time`, `simplify_without_bn_fusion`,
    `fuse_erf_gelu`, `fuse_tanh_gelu`;
  - dọn bản xuất, chỉ dùng op esp-dl đã có: `lean_transposes`, `lean_quantizers`, `aligned_pointwise`,
    `copies_by_broadcast`, `cache_sized_convolutions`, `identity_convolutions_dropped`,
    `channel_scales_as_mul`.
- **Mỗi bên vá theo model của mình.** esp-sr vá GELU, LayerNorm, RMSNorm, Softmax, cache theo trục
  thời gian: đó là các khối của model giọng nói. Bên mặt vá PReLU, ReLU6, ECA, SE, depthwise: các khối
  của CNN.

### 9.2 Trọng số vừa cache: esp-sr làm được chỉ bằng đồ thị

`cache_sized_convolutions` vốn của esp-sr. Nó cắt một tích chập 1×1 có trọng số lớn thành vài tích
chập nhỏ, mỗi cái có trọng số không quá nửa cache, rồi nối kết quả lại bằng `Concat`. Các lát đều là
`Conv` thường của esp-dl, nên không cần dòng C nào.

Đây là bản vá duy nhất được port sang, với ngưỡng hạ xuống "≥ cache": trọng số đúng 64 KB vẫn phải đọc
lại từ PSRAM. Lợi chủ yếu đến từ chính cách của esp-sr: recog từ 299,1 xuống 264,5 ms (−11,6%), spoof
từ 83,2 xuống 79,9 ms (−4,0%). Bên này chỉ thêm `ConvSlices`, ghi thẳng từng lát vào đúng kênh của
tensor ra để bỏ lượt `Concat` chép lại. Phần này chỉ được thêm khoảng 3 ms, recog từ 266,2 xuống
263,0 ms (`latency.md` §14.2, §14.6).

esp-sr cũng bố trí lại dữ liệu bằng các op có sẵn: `aligned_pointwise` gộp cột vào kênh cho đủ 16
kênh, `lean_transposes` bớt các `Transpose` thừa. `aligned_pointwise` đã được đo cho spoof rồi bỏ: ghép
4 cột thì số phép nhân-cộng tăng gấp bốn, tính ra ~0,6 chu kỳ cho mỗi phép có ích, trong khi hiện chỉ
0,21–0,25. Kênh lệch 16 vì thế xử lý bằng `padded_channels` (`latency.md` §14.2).

### 9.3 Ranh giới thật: chọn op nào, hay một op đi qua bộ nhớ ra sao

Viết lại đồ thị quyết định đồ thị có những op nào, shape ra sao, trọng số cắt thế nào. Nhưng esp-dl
vẫn chạy từng op một trên cả tensor: đọc tensor vào từ PSRAM, ghi trọn tensor ra về PSRAM, gọi nhân
SIMD cho từng điểm. esp-sr dừng ở đây.

Module C quyết định vòng lặp bên trong op, tức op đi qua bộ nhớ thế nào. Chỉ bên này làm việc đó, và
nó mua được ba thứ mà đồ thị không diễn tả được:

- **Tensor trung gian ở lại cache, không chỉ trọng số.** `PointwiseDepthwise` chạy theo dải hàng, mỗi
  dải chiếm tối đa 1/8 cache. Đầu ra của tích chập 1×1 không bao giờ nằm trọn trong PSRAM, vì
  depthwise đọc nó ngay khi còn trong cache. Ở detect, op này làm nhanh hơn 5,0–5,5%. Trên hàng có gộp
  PReLU, spoof nhanh hơn 10,0% và recog 2,9%, nhưng hàng ấy không vào bộ deploy (§8.2, `latency.md`
  §14.8). `MulAdd` cũng vậy: tích nằm luôn trong thanh ghi.
- **Gọi nhân theo hàng thay vì theo điểm.** Lớp vỏ của esp-dl gọi nhân 1×1 cho từng điểm và nạp lại
  tham số mỗi lần. `ConvIm2col` với `conv_row_s8_esp32s3.S` gọi một lần cho cả hàng, nên tích chập đầu
  của recog từ 17,4 xuống 8,5 ms (`latency.md` §14.7).
- **Những việc esp-dl không làm được.** `Conv` của esp-dl 3.3.11 bỏ trống con trỏ PReLU, nên mới có
  `ConvPRelu`. esp-dl cũng không có lệnh min int8 PIE nào gọi được từ ngoài để kẹp ReLU6 trong cùng
  nhân, nên mới có `clamp_s8_esp32s3.S`.

### 9.4 Đánh đổi

Hướng esp-sr không có code C phải giữ, nhưng chỉ bỏ được phần thừa quanh các op. Hướng bên này nhanh
hơn ở những chỗ trên. Đổi lại, mỗi module là một hợp đồng hai phía: Python ghi op ra, C đọc op vào, và
cả hai phải ra cùng từng số nguyên. Mỗi lần nâng esp-dl khỏi bản 3.3.11 đang ghim thì phải soát lại tất
cả các hợp đồng này.
