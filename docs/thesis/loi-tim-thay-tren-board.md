# Ba lỗi chỉ phần cứng thật mới lộ ra

Ghi cho chương thực nghiệm của báo cáo. Cả ba lỗi dưới đây **không** làm build fail,
**không** bị code review bắt, và **không** bị bất kỳ test nào trên máy tính phát hiện. Cả
ba đều được tìm ra trong một buổi lắp cảm biến VL53L1X lên board thật, ngày 09/09/2026.

Điểm chung khiến chúng đáng viết vào báo cáo: **hàm báo thành công trong khi phần cứng
chưa làm được việc**. Sai không nằm trong dòng code nào, nó nằm ở *giả định về thế giới bên
ngoài chip*.

---

## Lỗi 1 — Cuộc đua khởi tạo bus I2C

### Hiện tượng

`drv_ioexp` trượt 3 trong 4 test case, luôn ở lần ghi đầu tiên, với `ESP_ERR_INVALID_RESPONSE`
(thiết bị không ACK). Chạy lại nhiều lần vẫn trượt. Sau đó tự khỏi và pass 4/4, rồi lại
trượt sau khi rút điện cắm lại.

Một lỗi lúc có lúc không là loại khó nhất, vì nó dụ người gỡ đi tìm nguyên nhân sai.

### Những nguyên nhân đã loại, kèm cách loại

| Giả thuyết | Cách kiểm | Kết quả |
|---|---|---|
| PCF8574 là linh kiện 100 kHz, bus đang 400 kHz | Hạ `scl_speed_hz` xuống 100 kHz cho riêng nó | Vẫn trượt → **loại** |
| Phần cứng hỏng hoặc đấu sai | `probe` / `write` / `read` từ một app khác | Cả ba `ESP_OK` → **loại** |
| `sdkconfig` hai app khác nhau | `diff` toàn bộ khoá I2C, GPIO, clock, PSRAM | Giống hệt → **loại** |
| Giao dịch đầu sau khi tạo bus luôn trượt | Ghi ngay sau `i2c_new_master_bus()` ở app khác | `ESP_OK` → **loại** |
| Latch của PCF8574 sống qua reset chip | Rút điện để về trạng thái nguội | Tái hiện được, nhưng không giải thích được vì sao có lúc chạy |
| Có người chạm lại dây | Hỏi trực tiếp | Không → **loại** |

Bước quyết định là **quét cả ba địa chỉ thay vì chỉ một**. Lúc đó lỗi đổi hình dạng hoàn
toàn: không con nào trả lời, kể cả GT911 và VL53L1X vốn vừa chạy bình thường. Nghĩa là
**cả bus chết**, không phải một thiết bị — và tôi đã chẩn sai suốt vì `drv_ioexp` tình cờ
là thứ đầu tiên chạm vào bus.

### Nguyên nhân

Đo mốc thời gian ACK đầu tiên của từng thiết bị, tính từ lúc chip boot:

| Mốc | t+ |
|---|---|
| `bsp_board_init()` trả về `ESP_OK` | **4 ms** |
| PCF8574 `0x20` ACK lần đầu | **5 ms** |
| VL53L1X `0x29` ACK lần đầu | **17 ms** |
| GT911 `0x5D` ACK lần đầu | **57 ms** |

Ở t+4 ms **không thiết bị nào trả lời**, trong khi SDA và SCL đều đã ở mức cao — nên đây
không phải chuyện thiếu điện trở treo, mà là thiết bị chưa kịp sẵn sàng.

`i2c_new_master_bus()` thành công chỉ có nghĩa **ESP32 đã cấu hình xong ngoại vi của nó**.
Nó không biết, và không thể biết, đầu dây bên kia có ai trả lời hay chưa. `bsp_board_init()`
lấy kết quả đó rồi trả `ESP_OK`, và mọi driver phía sau hiểu thành "bus dùng được".

Từ đó thành một cuộc đua vài millisecond: driver nào chạm bus **ngay** sau `bsp_board_init()`
thì NACK; driver nào tình cờ chậm vài ms — vì in log, vì tính toán gì đó — thì chạy. Nên mỗi
lần sửa code là lỗi lại đổi mặt.

### Vì sao suốt quá trình phát triển không ai thấy

Vì **reset chip không tái hiện được nó**. Reset chỉ khởi động lại ESP32; các thiết bị I2C
vẫn đang có điện và đã sẵn sàng từ lâu, nên chúng ACK ngay ở t+0. Chỉ **lần cấp điện đầu**
mới có vùng chết đó, mà lúc phát triển thì hầu như không ai rút điện — người ta bấm reset,
hoặc nạp lại firmware.

Hệ quả nếu không tìm ra: lỗi sẽ xuất hiện đúng lần đầu người dùng cắm điện máy chấm công,
tức chỗ khó gỡ nhất.

### Cách sửa

`bsp_board_init()` không trả về tới khi bus thật sự chở được giao dịch: thăm dò những thiết
bị có địa chỉ cố định lúc cấp nguồn (`0x20`, `0x29`) tới khi cả hai ACK, trần **500 ms**
(khoảng 9 lần mốc 57 ms đo được), quá trần thì trả `ESP_ERR_NOT_FOUND` kèm địa chỉ nào im.

GT911 **không** nằm trong danh sách chờ: địa chỉ của nó do trình tự reset quyết định, nên
`drv_touch_init()` tự lo con của mình.

### Bằng chứng đã sửa

Trên board, sau khi rút điện cắm lại — đúng điều kiện đã làm nó trượt 4 lần liền:

```
I (390) bsp_board: i2c ready after 10 ms
I (390) drv_ioexp: pcf8574 at 0x20, shadow 0xFF
4 Tests 0 Failures 0 Ignored
```

Kèm một test hồi quy mới: *"init trả về một bus đã chở được một lần ghi"* — đúng cái mà
trước đó không test nào kiểm.

---

## Lỗi 2 — Giả định giá trị mặc định của chân ngắt

### Hiện tượng

Chân ngắt của VL53L1X giương **đủ 20/20 lần**, đúng nhịp, nhưng **mọi lần đọc dữ liệu ngay
sau đó đều trả `ESP_ERR_TIMEOUT`**: cảm biến báo chưa có dữ liệu.

Đây là dạng nguy hiểm hơn lỗi 1 về mặt chẩn đoán, vì nó **giả vờ đang chạy**. Đếm số ngắt
thì thấy đủ, nhịp thì đúng, chỉ có số đọc ra là luôn rỗng.

### Nguyên nhân

Driver không gọi `VL53L1X_SetInterruptPolarity()`, tức để cảm biến ở giá trị mặc định của
nó. Tài liệu của ST ghi rõ trong chính header:

> `1 = active high (default), 0 = active low`

Mặc định là **active high**: chân **lên cao** khi đo xong, và **xuống thấp** khi
`ClearInterrupt`. Còn driver lại bắt **cạnh xuống** (`GPIO_INTR_NEGEDGE`).

Nên ngắt giương đúng vào lúc dữ liệu **vừa bị đọc xong và xoá**, chứ không phải lúc có dữ
liệu. Cảm biến trả lời "chưa sẵn sàng" là hoàn toàn đúng.

Comment trong code lúc đó còn ghi ngược sự thật — rằng chip kéo chân xuống khi đo xong.
Một comment nói trái phần cứng thì tệ hơn không có comment, vì nó chặn người sau khỏi đi
kiểm lại.

### Vì sao lúc bình thường không gặp

Vì **đếm ngắt thì thấy đúng**. Ai kiểm cũng sẽ kiểm điều dễ kiểm nhất: chân ngắt có giương
không? Có, 20 trên 20, đúng nhịp 100 ms. Nhìn vào đó thì mọi thứ đang hoạt động.

Chỉ khi **thật sự đọc dữ liệu sau mỗi ngắt** mới lộ ra là chưa lần nào có dữ liệu. Mà cái
đó chỉ xảy ra khi viết tầng dùng cảm biến — tức muộn hơn nhiều so với lúc viết driver.

Thêm nữa, nếu chỉ đọc theo chu kỳ (polling) mà không dựa vào ngắt thì hệ **vẫn chạy đúng**,
chỉ tốn điện hơn. Lỗi sẽ ngủ tới đúng lúc ai đó bật chế độ ngủ sâu và trông vào chân ngắt
để đánh thức.

### Cách sửa

Lập trình phân cực **active low** ngay trong `drv_tof_init()` thay vì trông vào mặc định.
Đây cũng là điều mà lập luận an toàn chân strapping trong tài liệu thiết kế vốn đã giả định:
"cảm biến chỉ kéo chân xuống sau khi được cấu hình".

### Bằng chứng đã sửa

Trước khi sửa: 20 ngắt, **0** lần đọc thành công. Sau khi sửa:

```
irq 2:  65535 mm   t=631 ms
irq 3:  65535 mm   t=731 ms
...
irq 20: 65535 mm   t=2431 ms
ready line fired 20 of 20 expected
```

**Cách nhau đúng 100 ms**, bằng chính chu kỳ giữa hai lần đo đã cấu hình — nên ngắt giờ
giương đúng lúc có dữ liệu, và đường đọc chạy trọn 20/20.

(Giá trị `65535` là "không có mục tiêu", do màng bảo vệ lúc vận chuyển còn dán trên cửa sổ
cảm biến — nó chặn hồng ngoại 940 nm. Không liên quan tới lỗi phân cực.)

---

## Lỗi 3 — Con số đúng theo datasheet, sai theo mạch thật

### Hiện tượng

`drv_touch` trượt 4 trong 6 test case. `esp_lcd_touch_new_i2c_gt911()` luôn thất bại ở bước
đọc thanh ghi cấu hình, trả `ESP_ERR_INVALID_RESPONSE`.

Đáng chú ý: bus scan **có** thấy GT911 ở `0x5D`, nhưng ngay trong app của `drv_touch` thì
nó mất ở **cả hai** địa chỉ khả dĩ (`0x5D` và `0x14`). Nghĩa là bộ điều khiển không chỉ ở
sai địa chỉ — nó không trả lời gì cả.

### Cách truy

Bước quyết định là **so một xung reset làm bằng tay với chuỗi reset của driver**:

| | RST giữ thấp | Chờ sau khi nhả RST | INT lúc reset | Kết quả |
|---|---|---|---|---|
| Xung tay trong test | **100 ms** | 100 ms | không đụng | GT911 trả lời `0x5D` |
| `select_address()` của driver | **10 ms** | 50 ms | kéo thấp | không trả lời |

Ba biến khác nhau, nên phải khoá từng biến:

| Thử | Kết quả |
|---|---|
| Nâng mốc chờ **sau** khi nhả RST 50 → 100 ms | vẫn trượt → **không phải** |
| Trả INT về input sau khi chốt địa chỉ | vẫn trượt → **không phải** |
| Nâng mốc giữ RST **thấp** 10 → 100 ms | **`init` thành công**, `gt911 at 0x5D, 320x480` |

### Nguyên nhân

Chân RST của GT911 **không đi qua GPIO của ESP32, nó đi qua PCF8574**. Con đó là ngõ ra
**bán song hướng** (quasi-bidirectional): kéo xuống thì mạnh, nhưng **đẩy lên chỉ khoảng
100 µA**. Nên cạnh lên của đường RST do điện dung của module quyết định, không do driver.

Datasheet GT911 ghi RST cần giữ thấp ≥ **100 µs**. Chọn 10 ms là **thừa 100 lần** so với con
số đó — và vẫn không đủ, vì con số đó nói về một chân được lái bằng **ngõ ra đẩy-kéo thông
thường**, không phải qua một bộ mở rộng chỉ đẩy được 100 µA.

### Vì sao lúc bình thường không gặp

Đây là lỗi khó phát hiện nhất trong ba lỗi, vì **nó không trông giống lỗi ở bất kỳ đâu**:

- **Code review không thể bắt.** Dòng code là `vTaskDelay(pdMS_TO_TICKS(10))` với hằng số
  tên là `APP_TOUCH_RST_HOLD_MS`. Người review tra datasheet, thấy 100 µs, kết luận 10 ms
  là quá đủ. Kết luận đó **đúng theo datasheet** và sai theo mạch.
- **Sai không nằm ở con số mà ở mô hình.** Cả người viết và người review đều đang hình dung
  một chân GPIO đẩy-kéo. Không ai sai phép tính; mọi người sai cùng một giả định về mạch.
- **Không mô phỏng được.** Không có công cụ nào trên máy tính biết rằng chân này đi qua
  PCF8574 và bao nhiêu điện dung nằm trên nó.
- **Và chưa ai chạy `drv_touch` trên board.** Task `E7-T6` đã được đánh dấu hoàn thành. Lần
  đầu chạy thật là buổi này, và nó trượt 4 trong 6 case.

Nếu không chạy thử, lỗi này sẽ xuất hiện ở dạng "màn hình cảm ứng không ăn" — một triệu
chứng mà người ta sẽ đi nghi dây, nghi panel, nghi LVGL, trước khi nghi một con số đã được
đối chiếu với datasheet.

### Bằng chứng đã sửa

```
I (543) drv_touch: gt911 at 0x5D, 320x480
./main/test_touch.c:31:controller opens on the shared bus:PASS
```

Từ 4 trượt xuống **3 trượt**. Phần còn lại nằm ở `esp_lcd_touch_gt911_read_data` — một lỗi
**khác**, chưa truy ra nguyên nhân, và đã ghi vào backlog `E7-T14` cùng ba giả thuyết đã
loại. **Không thêm workaround cho nguyên nhân chưa biết**: chính nguyên tắc đó là lý do ba
lỗi trên tìm được thật thay vì bị che lấp.

---

## Bài học rút ra cho báo cáo

**1. Hàm trả `ESP_OK` chỉ nói về phần nó kiểm soát.** `i2c_new_master_bus()` cấu hình
ngoại vi của ESP32 và báo thành công — đúng, và vô dụng cho câu hỏi "bus dùng được chưa".
Ranh giới giữa "cấu hình xong" và "hoạt động được" là chỗ phải tự kiểm, không suy ra.

**2. Đọc giá trị mặc định thì không bằng lập trình nó.** Mọi thanh ghi cấu hình mà driver
phụ thuộc nhưng không ghi vào đều là một giả định không được kiểm chứng. Nó đúng cho tới
khi đổi lô linh kiện, đổi firmware của module, hoặc đọc sai datasheet ngay từ đầu.

**3. Lỗi "lúc có lúc không" thường là cuộc đua thời gian.** Và cách thoát khỏi vòng đoán
mò là **đo mốc thời gian**, không phải thử từng giả thuyết. Ở lỗi 1, sáu giả thuyết bị loại
mà không tiến thêm được bước nào; một phép đo mốc ACK đầu tiên thì kết thúc vấn đề.

**4. Mở rộng phạm vi quan sát trước khi đào sâu.** Suốt nhiều lần chạy tôi tin đây là lỗi
của một thiết bị, chỉ vì nó là thiết bị đầu tiên bị chạm tới. Quét cả ba địa chỉ — một
thay đổi nhỏ — cho thấy cả bus im lặng và lật ngược toàn bộ chẩn đoán.

**5. Điều kiện thử phải khác điều kiện phát triển.** Cả hai lỗi đều đòi một trạng thái mà
quá trình phát triển không bao giờ tạo ra: lỗi 1 cần **cấp điện lần đầu** thay vì reset;
lỗi 2 cần **thật sự đọc dữ liệu** sau ngắt thay vì chỉ đếm ngắt. Test nào cũng chỉ kiểm
được thứ nó chịu làm.

**6. Đánh dấu "xong" mà chưa chạy trên board thì chưa xong.** `drv_ioexp` và `drv_touch`
đều đã được đánh dấu hoàn thành trong backlog. Lần đầu chạy thật, `drv_ioexp` trượt 3 trong
4 case và `drv_touch` trượt 4 trong 6.

**7. Con số trong datasheet gắn với một mô hình mạch, không phải với chân bất kỳ.** Mốc
"RST ≥ 100 µs" đúng cho chân được lái bằng ngõ ra đẩy-kéo. Chân đó đi qua bộ mở rộng chỉ
đẩy được 100 µA thì con số mất hiệu lực — không phải vì datasheet sai, mà vì **điều kiện áp
dụng đã khác**. Mọi hằng số thời gian lấy từ datasheet đều nên ghi kèm *nó giả định cách
lái chân nào*.

**8. Cách gỡ hiệu quả nhất là so một lần chạy được với một lần không chạy được, rồi khoá
từng biến một.** Ở lỗi 3, hai bên lệch nhau ba tham số; thử lần lượt thì hai cái đầu loại
được và cái thứ ba là nguyên nhân. Nhanh hơn nhiều so với đọc lại code lần thứ mười.
