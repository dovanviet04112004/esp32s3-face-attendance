# Những lỗi chỉ phần cứng thật mới lộ ra

Ghi cho chương thực nghiệm của báo cáo. Tất cả các lỗi dưới đây **không** làm build fail,
**không** bị code review bắt, và **không** bị bất kỳ test nào trên máy tính phát hiện. Tất
cả đều được tìm ra trong hai buổi lắp và nghiệm thu ngoại vi trên board thật, 09/09/2026.

Điểm chung khiến chúng đáng viết vào báo cáo: **hàm báo thành công trong khi phần cứng chưa
làm được việc**. Sai không nằm trong dòng code nào, nó nằm ở *giả định về thế giới bên ngoài
chip*.

Chương này gồm hai phần. Phần A là bốn lỗi đã tìm ra nguyên nhân và đã sửa. Phần B là **hai
lần tôi kết luận sai nguyên nhân** — giữ lại vì chúng dạy nhiều hơn phần A: cả hai đều sinh
ra từ cùng một cơ chế, và cơ chế đó là thứ dễ tái phạm nhất.

---

# Phần A — Lỗi thật, nguyên nhân đã chứng minh

## Lỗi 1 — Cuộc đua khởi tạo bus I2C

### Hiện tượng

`drv_ioexp` trượt 3 trong 4 test case, luôn ở lần ghi đầu tiên, với `ESP_ERR_INVALID_RESPONSE`
(thiết bị không ACK). Chạy lại nhiều lần vẫn trượt. Sau đó tự khỏi và pass 4/4, rồi lại
trượt sau khi rút điện cắm lại.

### Nguyên nhân

Đo mốc thời gian ACK đầu tiên của từng thiết bị, tính từ lúc chip boot:

| Mốc | t+ |
|---|---|
| `bsp_board_init()` trả về `ESP_OK` | **4 ms** |
| PCF8574 `0x20` ACK lần đầu | **5 ms** |
| VL53L1X `0x29` ACK lần đầu | **17 ms** |

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

Đo lại nhiều lần sau khi đã sửa cho thấy đúng quy luật đó: khởi động nguội báo
`i2c ready after 10 ms`, còn mọi lần reset nóng đều báo `i2c ready after 0 ms`.

Hệ quả nếu không tìm ra: lỗi sẽ xuất hiện đúng lần đầu người dùng cắm điện máy chấm công,
tức chỗ khó gỡ nhất.

### Cách sửa

`bsp_board_init()` không trả về tới khi bus thật sự chở được giao dịch: thăm dò những thiết
bị có địa chỉ cố định lúc cấp nguồn (`0x20`, `0x29`) tới khi cả hai ACK, trần **500 ms**,
quá trần thì trả `ESP_ERR_NOT_FOUND` kèm địa chỉ nào im.

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

### Một phần của lỗi này vẫn còn mở

Bảng loại trừ ban đầu có một dòng ghi *"có người chạm lại dây → hỏi trực tiếp → không"*.
Chủ repo trả lời đúng: không ai chạm dây. Nhưng về sau phát hiện **đầu cắm lớp cảm ứng trên
module LCD chưa vào hẳn**, mà SDA/SCL của GT911 đi qua chính đầu cắm đó. Nên câu hỏi đặt ra
đã sai: cần hỏi *"có tiếp xúc nào lỏng không"* chứ không phải *"có ai chạm dây không"*.

Vì thế **hai quan sát trong lỗi này phải coi là chưa đáng tin**: lần "cả bus chết khi quét
ba địa chỉ", và mốc *GT911 ACK lần đầu ở t+57 ms*. Cả hai đo trong lúc đầu cắm còn lỏng.
Phần cốt của lỗi 1 không phụ thuộc vào chúng — nó dựa trên hai thiết bị nằm trên dây riêng
(`0x20` và `0x29`) và trên phép nghiệm thu nguội — nhưng con số 57 ms thì phải đo lại.

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

## Lỗi 3 — Một chốt an toàn biến màn hình chết thành board không boot được

Lỗi này do chính tôi tạo ra khi sửa lỗi khác. Giữ lại trong báo cáo vì nó là ví dụ sạch cho
một loại sai: **xử lý lỗi đúng ở tầng dưới, sai ở tầng trên**.

### Hiện tượng

Sau khi thêm một phép kiểm mã sản phẩm vào `drv_touch_init()` — đọc thanh ghi `0x8140`, đòi
đúng ba byte `"911"`, không đúng thì trả `ESP_ERR_NOT_FOUND` — thì màn hình **không lên đèn
nền** nữa. Trông y như đèn nền chết.

### Nguyên nhân

`app_main()` bọc mọi bước khởi tạo trong `ESP_ERROR_CHECK`. Nên khi `drv_touch_init()` trả
lỗi, `ESP_ERROR_CHECK` gọi `abort()` → chip reset → boot lại → lại trượt ở đúng chỗ đó.

Vòng lặp ấy chạy khoảng 150 ms một lượt. Đèn nền được bật ở bước trước đó nên nó **có** sáng,
nhưng chỉ sáng trong phần cuối của mỗi 150 ms rồi tắt khi chip reset. Mắt người nhìn ra là
**màn tối hẳn**, không phải "màn nhấp nháy".

### Vì sao lúc bình thường không gặp

Vì phép kiểm mới **đúng**: nó phát hiện đúng một panel không phục vụ thanh ghi. Cái sai nằm
ở chỗ khác — ở **quyết định cả hệ phải chết theo**. Và quyết định đó đã nằm sẵn trong
`app_main()` từ trước, chỉ chưa có ngoại vi nào trả lỗi nên chưa ai thấy.

Nói cách khác: thêm một phép kiểm trung thực vào tầng dưới đã **kích hoạt** một khiếm khuyết
có sẵn ở tầng trên. Triệu chứng thì hiện ra ở một bộ phận hoàn toàn khác (đèn nền), nên nó
kéo người gỡ đi sai hướng — chính tôi đã đi sai hướng đó.

### Cách sửa

Chia ngoại vi thành hai loại, ghi vào tài liệu thiết kế §6.2.2:

- **Chặn boot**: `sys_storage`, `ai_engine`, `bsp_board`, `drv_lcd`, `drv_ioexp`, `drv_camera`
  — thiếu cái nào thì máy chấm công không làm được việc của nó.
- **Suy giảm chức năng**: `drv_touch` — panel chết thì mất màn hình cài đặt, không mất việc
  chấm công. Ghi log mức cảnh báo rồi đi tiếp.

```c
ESP_ERROR_CHECK(drv_ioexp_init());
// A dead panel costs the settings screen, not the kiosk (KEHOACH 6.2.2).
const esp_err_t touch = drv_touch_init();
if (touch != ESP_OK) {
    ESP_LOGW(TAG, "touch absent: %s", esp_err_to_name(touch));
}
```

### Bằng chứng đã sửa

```
W (1007) app_main: touch absent: ESP_ERR_NOT_FOUND
I (1754) drv_camera: sensor 0x5640 up at 480x320 rgb565 in psram
I (6180) app_tasks: preview 13.556 fps
```

Boot **một lần**, không abort, preview chạy — trong khi cảm ứng vẫn đang lỗi.

---

## Lỗi 4 — Một chân lỏng, và cả đường ghi vẫn báo thành công

### Hiện tượng

Màn hình chỉ còn **sáng trơ**: đèn nền bật, không có nội dung gì. Trong khi đó log firmware
hoàn toàn khoẻ:

```
I (847) drv_lcd: st7796 up at 320x480, 2 bounce of 30720 B
I (1745) drv_camera: sensor 0x5640 up at 480x320 rgb565 in psram
I (14607) app_tasks: preview 14.187 fps
```

Mọi lệnh SPI trả `ESP_OK`. Số fps đều đặn. Không một dòng lỗi nào.

### Cách truy

Phép đo tách được "dữ liệu không tới panel" khỏi "tới nhưng sai" là **tô màu trơn** qua đúng
đường driver mà preview dùng: đỏ 2,5 s → xanh lá 2,5 s → xanh dương 2,5 s ngay trong
`app_main()`, trước khi khởi tạo camera.

Cả ba lần tô đều trả `ESP_OK`, và **kính không đổi màu lần nào**. Vậy dữ liệu không tới
panel, mà bus SPI không có cách nào biết điều đó.

Ở bước sau, một lần khởi động **có** hiện màu đỏ rồi những lần sau lại không — dấu hiệu đặc
trưng của tiếp xúc chập chờn, không phải của lỗi logic. Chủ repo tìm ra một chân cắm lỏng
trong bó dây SPI của LCD và cắm lại toàn bộ; màn chạy lại ngay.

### Vì sao lúc bình thường không gặp

Vì **SPI tới panel là bus một chiều**. Không có ACK như I2C, và module này không đấu đường
`SDO` về, nên firmware không có bất kỳ đường phản hồi nào. `esp_lcd_panel_draw_bitmap()` trả
`ESP_OK` nghĩa là *DMA của ESP32 đã đẩy xong số byte đó ra chân*, hết. Nó không nói gì về
việc đầu dây bên kia có nhận được hay không — và **không thể nói**.

Đây chính là bài học của lỗi 1 nhưng ở dạng mạnh hơn: ở lỗi 1, bus I2C ít nhất còn NACK để
báo có chuyện. Ở đây thì hoàn toàn im lặng, và cách duy nhất phát hiện là **mắt người nhìn
vào kính**.

Hệ quả cho thiết kế nghiệm thu: mọi phép nghiệm thu LCD chỉ dựa trên mã trả về đều **vô
giá trị**. Bộ test `drv_lcd/test_apps/panel` có 9 case pass, mà 8 trong 9 chỉ kiểm mã trả
về; case duy nhất kiểm bằng mắt thì bị gắn thẻ `[manual]` và bị bỏ qua mặc định. Nên "9/9
PASS" hoàn toàn tương thích với một màn hình không hiện gì.

### Cách sửa

Về phần cứng: cắm lại chân lỏng. Về phần phương pháp, ba điều:

1. `drv_lcd_fill()` một màu trơn là **phép nghiệm thu rẻ nhất và mạnh nhất** cho toàn tuyến
   panel. Nó không cần camera, không cần model, và cho câu trả lời nhị phân.
2. Câu "SPI trả `ESP_OK`" **không được** dùng làm bằng chứng panel đang chạy trong bất kỳ
   báo cáo nghiệm thu nào.
3. Điều kiện nghiệm thu trong backlog cho mọi thứ liên quan đến màn hình phải viết dưới dạng
   *nhìn thấy gì trên kính*, không phải *hàm trả về gì*.

---

## Lỗi 5 — Thư viện làm một việc không ghi trong hợp đồng của nó

### Hiện tượng

Để hết xé hình khi preview di chuyển, `drv_lcd` cần đọc vị trí tia quét của panel
(`GET_SCANLINE`, `0x45`) qua đường `SDO`. Một chương trình thăm dò tự dựng bus SPI đọc được
**hoàn hảo**: giá trị đi theo thứ vừa ghi, bộ đếm dòng tăng đều và cuộn vòng, đo được chu kỳ
quét cho 18 mức thanh ghi. Đưa đúng đoạn code đó vào firmware thật, mọi phép đọc trả `0xFFFF`.

Bisect từng bước khởi tạo cho ra một ranh giới sắc: đọc được **cho tới giao dịch đầu tiên mà
`esp_lcd` gửi cho panel**, sau đó chết vĩnh viễn — reset panel, gửi lại nguyên chuỗi khởi tạo
của chương trình thăm dò, nới xung CS từ 1 lên 1000 µs, đều không cứu được.

### Nguyên nhân

Trong `esp_lcd_panel_io_spi.c`, callback sau mỗi giao dịch gọi `gpio_ll_output_disable()` trên
chân DC, và callback trước giao dịch kế mới bật lại. Nghĩa là **giữa hai giao dịch của
`esp_lcd`, chân DC không được lái**. Lệnh đọc của `drv_lcd` đi bằng một thiết bị SPI khác trên
cùng bus, chỉ gọi `gpio_set_level(DC, 0)` — mức được ghi vào thanh ghi nhưng driver đang tắt,
chân thả nổi, điện trở kéo lên trên module giữ nó ở mức cao. Panel thấy `0x45` đến với DC =
cao, tức là **dữ liệu**, và im lặng.

Chương trình thăm dò không gặp vì nó tự sở hữu DC từ đầu đến cuối.

### Vì sao lúc bình thường không gặp

Vì hành vi đó **không sai với chính `esp_lcd`**: nó luôn bật DC trước khi gửi và chỉ tắt sau
khi xong, nên mọi giao dịch của nó đều đúng. Nó chỉ sai với người thứ hai dùng chung chân —
và hợp đồng công khai của `esp_lcd` không nói gì về việc chân DC sẽ ở trạng thái nào lúc nó
không dùng. Đọc header thì không thấy; phải đọc mã nguồn.

Cùng buổi còn một bẫy cùng loại ở tầng dưới: `spi_bus_initialize()` nối chân MISO vào ngoại
vi nhưng **để driver ngõ ra của chân đó bật**. ESP lái chân SDO, panel không thể kéo nó xuống.
Thăm dò không gặp vì trên chip vừa reset, chân đó chưa bị ai bật ngõ ra.

### Cách sửa

`drv_lcd` bật lại ngõ ra DC ngay trước mỗi lệnh đọc, và tắt ngõ ra MISO một lần khi tạo
thiết bị đọc. Không sửa `esp_lcd`, không thay thư viện: hai dòng, đúng chỗ ranh giới đã đo.

### Bằng chứng đã sửa

```
I (848) drv_lcd: st7796 up at 320x480, 2 bounce of 30720 B, scanline reads 15
I (10284) app_tasks: preview 14.245 fps
```

Và trên kính: chủ repo xác nhận khấc **hết hẳn**, màn không nhấp nháy ở nhịp quét 23 Hz.

---

## Lỗi 6 — Dòng tổng kết màu xanh che hai lần panic

### Hiện tượng

Bộ test của `sys_storage` chưa từng chạy trên board. Đi chạy nó thì bước đầu đã lộ một điều:
**nó không biên dịch được** — `sys_storage_model_find()` đã thêm tham số thứ tư từ nhiều commit
trước, còn test vẫn gọi theo chữ ký cũ. Không ai thấy vì không gì build các test app, và task
`E7-T10` đã được đánh dấu hoàn thành trên một bộ test không thể chạy.

Sửa một dòng cho nó biên dịch, nạp lên board, log kết thúc bằng:

```
11 Tests 0 Failures 0 Ignored
```

Nhưng phía trên dòng đó, cùng một lần cắm điện, có **ba lần boot**. Hai lần đầu dừng ở case
thứ tám rồi chip tự reset (`rst:0xc RTC_SW_CPU_RST`); lần thứ ba mới chạy hết. Bộ lọc log tôi
dùng lúc đầu chỉ giữ các dòng `PASS`/`FAIL` nên **tôi đã đọc kết quả này là "11/11"** — đúng
cái mà bất kỳ ai nhìn vào dòng tổng kết cũng sẽ đọc.

### Nguyên nhân

```
***ERROR*** A stack overflow in task main has been detected.
```

Case đó đặt hai mảng 16 record (2 × 768 B) trên stack rồi gọi `fopen`/`fwrite`/`fsync` qua
LittleFS mười sáu lần. Task chạy test có **3.584 B** stack. Đo sau khi đưa hai mảng ra ngoài:
đường ghi file tự nó đã ăn **~2,2 KB** — nên với hai mảng còn trên stack thì tràn là chắc chắn,
không phải ngẫu nhiên.

Lần boot thứ ba "qua" vì kernel chỉ phát hiện tràn stack **lúc chuyển ngữ cảnh**, bằng cách
kiểm một vùng canh ở đáy stack. Cùng một vết tràn, nếu lúc chuyển ngữ cảnh vùng canh chưa bị
đè, thì không bị bắt — bộ nhớ vẫn đã bị ghi lem, chỉ là không ai báo. **Kết quả "pass" của lần
thứ ba là kết quả của một chương trình đã hỏng bộ nhớ.**

### Vì sao lúc bình thường không gặp

Ba lớp che chồng lên nhau, lớp nào cũng bình thường một cách hợp lý:

1. Không gì build test app, nên lỗi biên dịch tồn tại mà không ai biết.
2. Test runner tự reset sau panic và **chạy tiếp từ đầu**, nên chuỗi log cuối cùng luôn kết
   thúc bằng một lần chạy trọn — và dòng tổng kết chỉ đếm lần đó.
3. Người đọc log lọc theo `PASS`/`FAIL`. Panic không phải `FAIL`; nó không có trong bộ lọc.

Firmware thật chưa bị vì `sys_storage_append()` chưa được ai gọi. Khi `svc_attendance` gọi nó
từ task riêng, con số 2,2 KB đó phải nằm trong ngân sách stack của task ấy — mà bảng stack
trong tài liệu thiết kế §5 chưa từng có số đo cho việc này.

### Cách sửa

Hai mảng thành `static`. Test in luôn mức stack cao nhất của task để lần sau có số thay vì có
cảm giác. Bật kiểm stack `STRONG` cho test app này (mới có 1 trong 9 test app bật). Và bộ lọc
đọc log: **đếm số lần boot trong một lần cắm điện** — một bộ test đúng thì boot đúng một lần.

### Bằng chứng đã sửa

```
=== số lần boot: 1 | panic: 0
main task stack left after 16 appends: 1348 B of 3584
11 Tests 0 Failures 0 Ignored
```

---

# Phần B — Hai lần tôi kết luận sai nguyên nhân

Hai mục dưới đây không phải lỗi của hệ thống, mà là lỗi của người gỡ. Chúng vào báo cáo vì
cùng sinh ra từ một cơ chế duy nhất, và cơ chế đó tốn nhiều thời gian hơn cả ba lỗi thật ở
trên cộng lại.

## Sai 1 — Gán công cho một thay đổi, trong lúc phần cứng đang chập chờn

### Tôi đã kết luận gì

Rằng `drv_touch` không chạy vì **mốc giữ chân RST ở mức thấp quá ngắn**: 10 ms là không đủ,
phải 100 ms. Lập luận nghe rất thuyết phục: chân RST của GT911 không đi qua GPIO của ESP32
mà đi qua PCF8574, con này kéo xuống thì mạnh nhưng **đẩy lên chỉ khoảng 100 µA**, nên mốc
"RST ≥ 100 µs" trong datasheet — vốn viết cho một chân đẩy-kéo thông thường — mất hiệu lực.

Bằng chứng tôi đưa ra: nâng 10 → 100 ms thì `init` thành công, log ra
`gt911 at 0x5D, 320x480`.

### Vì sao nó sai

Ba điều, mỗi điều đủ để bác:

1. **Nguyên nhân thật là đầu cắm lớp cảm ứng trên module LCD chưa vào hẳn.** Sau khi cắm
   lại, probe đọc **72/72 lần đúng `"911"`** — 4 kiểu trình tự reset × 3 tốc độ bus × 6 mốc
   thời gian — kèm thanh ghi cấu hình `version 0x61, x_max 320, y_max 480, 5 điểm`.
2. **Chính phép đo đó bác con số 100 ms.** Một trong bốn kiểu trình tự là *"RST giữ thấp
   **10 ms**"*, và nó đọc đúng `"911"` ở mọi mốc thời gian, mọi tốc độ bus. Tức 10 ms **đủ**,
   và thay đổi tôi làm không phải là thứ đã sửa được gì.
3. **Lập luận cơ chế của tôi tự mâu thuẫn.** Nguồn đẩy 100 µA yếu của PCF8574 làm chậm
   **cạnh lên** của RST. Giữ RST ở mức **thấp** lâu hơn không tác động gì tới cạnh lên. Câu
   chuyện vật lý tôi kể không nối được với con số tôi sửa — mà tôi vẫn viết nó vào báo cáo.

### Cơ chế đã lừa tôi

Phần cứng chập chờn **chế ra quan hệ nhân quả**. Khi một hệ có lúc chạy có lúc không, thì
bất kỳ thay đổi nào cũng có xác suất nhất định được theo sau bởi một lần chạy được. Người
gỡ nhìn thấy "sửa X → chạy" và kết luận X là nguyên nhân. Bốn giả thuyết trước đó đều bị
loại theo đúng cách ngược lại: "sửa Y → vẫn trượt → loại Y" — trong khi Y hoàn toàn có thể
đúng mà vẫn trượt vì tiếp xúc.

Nói gọn: **trong điều kiện chập chờn, cả phép xác nhận lẫn phép loại trừ đều mất hiệu lực.**

### Đáng lẽ phải làm gì

**Bật tắt lại thay đổi đó.** Một thay đổi chỉ được coi là nguyên nhân khi đảo nó về thì lỗi
**quay lại**, và làm lại thì lỗi **mất đi** — lặp vài lần. Tôi không làm phép đảo đó; tôi
chỉ có một chiều "sửa rồi chạy".

Và trước cả điều đó: **một lỗi lúc có lúc không thì phải chốt độ ổn định trước, chưa chốt
xong thì chưa được đi tìm nguyên nhân.** Cách chốt là đếm: chạy 10 lần khởi động, ghi lại
bao nhiêu lần đạt. Một con số như 3/10 tự nó đã nói "đây là tiếp xúc", trước khi bàn tới
datasheet.

## Sai 2 — Kết luận về thiết bị, trong lúc chưa đo dụng cụ đo

### Tôi đã kết luận gì

Đi tìm cách đọc vị trí tia quét của panel (để sửa lỗi xé hình khi ảnh di chuyển), tôi cần
một chân ESP32 làm ngõ vào cho đường `SDO` của module LCD. Lần lượt dùng `GPIO48` rồi
`GPIO38`, và cả hai lần đều kết luận: **module không đấu đường SDO ra chân**, đọc thanh ghi
nào cũng ra một mức cố định.

### Vì sao nó sai

Vì cả hai chân đó **không thể làm ngõ vào trên board này**, và tôi chưa đo điều đó trước khi
kết luận về module. Sau khi đo mức nền của từng chân với **không cắm gì cả**:

| Chân | Bật kéo lên | Bật kéo xuống | Kết luận |
|---|---|---|---|
| GPIO45 | 20/20 mức cao | 0/20 | trống thật, đọc ngõ vào được |
| GPIO43 | 20/20 mức cao | 0/20 | trống thật, đọc ngõ vào được |
| **GPIO38** | 20/20 | **20/20** | **board ghim mức cao** |
| **GPIO48** | **0/20** | 0/20 | **board ghim mức thấp** |
| GPIO0 | 20/20 | 20/20 | board ghim cao (điện trở kéo của nút BOOT) |

Chân bị ghim mức thì mọi phép đọc đều ra chính mức đó, bất kể đầu dây bên kia là gì. Hai
kết luận của tôi về module vì thế **không chứa thông tin nào về module**.

Khi chuyển sang `GPIO43` — chân đã đo là trống thật — và panel đã lành dây, phép thử
**ghi vào rồi đọc ra** cho kết quả ngược hẳn:

| Ghi vào `MADCTL` | Đọc lại được |
|---|---|
| `0x00` | `0x00` |
| `0xC0` | `0xC0` |

Số đọc **đi theo** số ghi, nên module **có** đấu đường SDO thật và panel **có** trả dữ liệu.
Kết luận cũ sai hoàn toàn.

### Cơ chế đã lừa tôi

Giống hệt sai 1 ở dạng khác: **kết luận về đối tượng đo trong lúc chưa kiểm dụng cụ đo.**
Ở sai 1, dụng cụ là đường tiếp xúc đang chập chờn. Ở sai 2, dụng cụ là chính chân GPIO.
Trong cả hai trường hợp, phép đo cho ra số liệu trông rất ổn định và rất thuyết phục —
`0x08627E` lặp lại y nhau 10 lần, hay `0xFF` lặp lại ở cả 9 lệnh đọc — mà **độ ổn định đó
đến từ chỗ hỏng, không đến từ đối tượng**.

Đây là điểm phản trực giác đáng viết nhất của cả chương: người gỡ thường coi *ổn định* là
dấu hiệu của *đúng*. Một giá trị sai mà lặp lại y nguyên 10 lần thì thuyết phục hơn nhiều
một giá trị lúc đúng lúc sai. Nhưng chân bị ghim mức, dây bị đứt, hay bus bị kẹt đều cho ra
số liệu **cực kỳ ổn định**.

### Đáng lẽ phải làm gì

**Đo đường nền trước, bằng một giá trị đã biết trước câu trả lời.**

- Với một chân GPIO: bật kéo lên rồi kéo xuống, đòi nó đi theo. Chân nào không đi theo thì
  không dùng được làm ngõ vào — biết điều này **trước khi** cắm gì vào.
- Với một đường đọc thanh ghi: đọc một thanh ghi mà mình **vừa tự ghi vào**, và tốt hơn nữa
  là ghi vài giá trị khác nhau rồi đòi số đọc đi theo. Đọc `ID` của chip thì không đủ, vì
  không biết trước nó phải ra gì.
- Với một đường ghi: tô một màu trơn rồi **nhìn bằng mắt**. Mã trả về không phải bằng chứng.

Ba phép trên rẻ hơn nhiều so với thời gian tôi đã tiêu, và mỗi phép đều cho câu trả lời nhị
phân không cần suy luận.

---

# Bài học rút ra cho báo cáo

**1. Hàm trả `ESP_OK` chỉ nói về phần nó kiểm soát.** `i2c_new_master_bus()` cấu hình ngoại
vi của ESP32 và báo thành công — đúng, và vô dụng cho câu hỏi "bus dùng được chưa".
`esp_lcd_panel_draw_bitmap()` báo DMA đã đẩy xong byte ra chân — đúng, và vô dụng cho câu
hỏi "panel có nhận được không". Ranh giới giữa "cấu hình xong" và "hoạt động được" là chỗ
phải tự kiểm, không suy ra.

**2. Bus một chiều thì không có nghiệm thu bằng mã trả về.** I2C còn NACK; SPI tới panel thì
không có gì. Với mọi ngoại vi chỉ ghi mà không đọc được, điều kiện nghiệm thu **phải** viết
dưới dạng quan sát vật lý: thấy màu gì trên kính, nghe tiếng cạch nào, đo được bao nhiêu volt.

**3. Chốt độ ổn định trước khi đi tìm nguyên nhân.** Lỗi lúc có lúc không phải được đếm
trước: 10 lần khởi động, đạt bao nhiêu lần. Chưa có con số đó thì mọi phép xác nhận và mọi
phép loại trừ đều vô hiệu — vì một thay đổi vô can vẫn có xác suất được theo sau bởi một lần
chạy được, và một thay đổi đúng vẫn có thể bị theo sau bởi một lần trượt.

**4. Một nguyên nhân chỉ được chốt khi đảo lại thì lỗi quay về.** Chiều "sửa rồi chạy" một
mình không chứng minh gì. Đây là điều đã làm tôi viết một nguyên nhân bịa vào báo cáo, và nó
đứng đó cho tới khi một phép đo khác tình cờ bác nó.

**5. Đo dụng cụ trước khi đo đối tượng.** Chân GPIO nào định dùng làm ngõ vào thì kiểm bằng
điện trở kéo lên/xuống trước. Đường đọc nào định tin thì kiểm bằng một giá trị tự ghi vào
trước. Bỏ bước này thì phép đo vẫn cho ra số liệu, chỉ là số liệu của chỗ hỏng.

**6. Số liệu ổn định không có nghĩa là số liệu đúng.** Chân bị ghim mức cho ra cùng một giá
trị 10 lần liền, thuyết phục hơn hẳn một phép đo thật có nhiễu. Câu hỏi phải đặt là *"mình
có biết trước giá trị này phải là bao nhiêu không"*, chứ không phải *"nó có lặp lại không"*.

**7. Đọc giá trị mặc định thì không bằng lập trình nó.** Mọi thanh ghi cấu hình mà driver
phụ thuộc nhưng không ghi vào đều là một giả định không được kiểm chứng. Nó đúng cho tới khi
đổi lô linh kiện, đổi firmware của module, hoặc đọc sai datasheet ngay từ đầu.

**8. Mở rộng phạm vi quan sát trước khi đào sâu.** Suốt nhiều lần chạy tôi tin lỗi 1 là của
một thiết bị, chỉ vì nó là thiết bị đầu tiên bị chạm tới. Quét cả ba địa chỉ — một thay đổi
nhỏ — cho thấy cả bus im lặng và lật ngược toàn bộ chẩn đoán.

**9. Điều kiện thử phải khác điều kiện phát triển.** Lỗi 1 cần **cấp điện lần đầu** thay vì
reset; lỗi 2 cần **thật sự đọc dữ liệu** sau ngắt thay vì chỉ đếm ngắt; lỗi 4 cần **nhìn vào
kính** thay vì đọc log. Test nào cũng chỉ kiểm được thứ nó chịu làm.

**10. Đánh dấu "xong" mà chưa chạy trên board thì chưa xong.** `drv_ioexp` và `drv_touch`
đều đã được đánh dấu hoàn thành trong backlog trước khi chạy thật lần nào.

**11. Xử lý lỗi trung thực ở tầng dưới có thể kích hoạt khiếm khuyết ở tầng trên.** Lỗi 3 là
ví dụ: thêm một phép kiểm đúng vào driver làm cả hệ vào vòng reset, và triệu chứng hiện ra ở
một bộ phận không liên quan. Nên khi thêm một đường trả lỗi mới, phải đi theo nó lên tới
`app_main()` và trả lời: **thiếu ngoại vi này thì hệ nên chết hay nên đi tiếp?**

**13. Dùng chung một chân với thư viện thì phải đọc mã nguồn của thư viện, không đọc header.**
Hợp đồng công khai chỉ hứa về lúc thư viện *đang dùng* tài nguyên; trạng thái nó để lại *giữa
hai lần dùng* thường không ghi ở đâu. Lỗi 5 nằm đúng khoảng trống đó. Và cách tìm ra không phải
đọc code lần thứ mười, mà là **bisect theo thời gian**: chèn một phép đọc sau từng bước khởi
tạo, tìm bước đầu tiên làm nó đổi kết quả.

**14. Một bộ test đúng thì boot đúng một lần.** Dòng tổng kết của test runner chỉ đếm lần chạy
cuối; panic không phải `FAIL` và không lọt vào bộ lọc `PASS`/`FAIL`. Nên chỉ tiêu đầu tiên khi
đọc log test trên board là **số lần boot trong một lần cắm điện**, trước cả số case pass. Và
"đánh dấu xong" cho một bộ test phải kèm bằng chứng nó **đã biên dịch và chạy** sau lần đổi
API gần nhất — bộ test của `sys_storage` đã nằm ở trạng thái không biên dịch được qua nhiều
commit mà vẫn mang dấu xong.

**12. Con số trong datasheet gắn với một mô hình mạch, không phải với chân bất kỳ.** Nguyên
tắc này vẫn đúng và vẫn nên ghi — dù ở lỗi cụ thể ban đầu tôi đã dùng nó để bọc cho một
nguyên nhân bịa. Mọi hằng số thời gian lấy từ datasheet đều nên ghi kèm *nó giả định cách
lái chân nào*: mốc "RST ≥ 100 µs" viết cho một ngõ ra đẩy-kéo, không cho một chân đi qua bộ
mở rộng chỉ đẩy được 100 µA.
