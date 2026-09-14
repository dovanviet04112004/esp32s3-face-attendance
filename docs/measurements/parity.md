# Parity C ↔ Python — sổ đo

Kết quả của `firmware/test_apps/parity` chạy trên board, đối chiếu sáu hàm hậu xử lý
với vector vàng ở `contracts/golden/`. Cách sinh vector và khuôn `.gold` ở KẾ HOẠCH §4.3.

---

## 1. Lượt đầu chạy được đủ sáu nhánh — 12/09

Board ESP32-S3, app `parity` với ảnh LittleFS 776/4096 KB nướng từ `contracts/golden/`
lúc build (`littlefs_create_partition_image`, không cần đường truyền riêng).

| Hàm | Bản C | Ca | Kết quả |
|---|---|---|---|
| decode | `detection/decode.cpp` | 3 | **khớp tuyệt đối**, kể cả ca 31 mặt sát trần 32 ứng viên |
| suppress | `detection/nms.cpp` | 4 | **khớp tuyệt đối** |
| crop_face | `antispoof/preproc.cpp` | 5 | **khớp tuyệt đối**, 0/19.683 byte lệch mỗi ca |
| align_face | `recognition/align.cpp` | 4 | lệch **tối đa 2 LSB**, 1,4–6,0% số byte |
| normalized_int8 | `recognition/l2norm.cpp` | 4 | **khớp tuyệt đối**, 0/512 |
| cosine | `svc_facedb/embedding_index.cpp` | 4 | khớp tới 6 chữ số: 1,000000 · −0,026086 · 0,342144 · −1,000000 |

```bash
cd firmware/test_apps/parity && idf.py build && idf.py -p /dev/ttyACM0 flash monitor
```

Đổi vector vàng thì phải nạp lại **cả partition `storage`** (`idf.py flash`), nạp mỗi app
(`app-flash`) là board vẫn đọc ảnh cũ.

---

## 2. Hai sai lệch tìm được, cả hai đều ở bản Python

Lượt chạy đầu cho 1.404/19.683 byte lệch ở `crop_face`, nơi tệ nhất **124 LSB** — quá lớn để
là sai số làm tròn. Hai nguyên nhân nối nhau, **board đúng cả hai lần**:

**(a) `hi` tính bằng cộng dồn, không bằng nhân.** C viết `lo = origin + i*step; hi = lo + step`.
Bản Python viết `hi = origin + (i+1)*step`. Ở ô cuối cùng, `81 × (40/81)` trong float64 ra
**40,000000000000014** chứ không phải 40, nên `ceil` nhảy thêm một pixel: host lấy cửa sổ hai
pixel, board lấy một. Triệu chứng là **cột cuối mỗi hàng** (ca 1) và **hàng cuối** (ca 3) lệch.

**(b) Trình biên dịch gộp phép nhân-cộng.** Sau khi sửa (a) còn đúng một ca lệch, ở hàng 26 của
ca 0. `origin + i*step` với `origin=30, step=48/81, i=26`: tách rời hai phép thì float32 cho
`lo = 45,40741` và `hi = 46,000004` → cửa sổ hai hàng; gộp thành một `madd.s` (Xtensa có lệnh
đó, GCC mặc định `-ffp-contract=fast`) thì `lo = 45,407406` và `hi = 46,0` chẵn → cửa sổ một
hàng. Board in ra `−29, 99, −62`, đúng nhánh gộp; bản không gộp cho `8, −10, −33`.

Cách chốt nguyên nhân: dựng lại cửa sổ ở host theo cả hai lối rồi so với byte board in ra, chứ
không sửa mò. `preproc.py` giờ tính `low` qua float64 rồi hạ về float32 — một lần làm tròn, đúng
ngữ nghĩa `madd.s`.

Bài học đáng giữ: **bản gương phải soi cả cách trình biên dịch gộp lệnh**, không chỉ công thức.

---

## 3. `align_face` không thể khớp tuyệt đối, và vì sao chấp nhận

`align.py` chạy float64 — nó là tham chiếu và cũng là đường cắt ảnh lúc train; board chỉ có
float32. Sai khác còn lại **tối đa 2 LSB trên thang 0–255**, tức 0,8%, ở 1,4–6,0% số byte. Đây
là sàn của độ chính xác chứ không phải lỗi: không có bước nào của phép biến đổi tương tự hay
nội suy song tuyến tính có thể khớp bit khi hai bên dùng hai độ rộng số khác nhau.

Ngưỡng nghiệm thu của ca này vì vậy là **worst ≤ 2 LSB** (`ALIGN_LSB` trong `parity.cpp`), năm
ca còn lại giữ **khớp tuyệt đối**. Hạ `align.py` xuống float32 để khớp bit đã cân nhắc và bỏ:
nó làm xấu ảnh train để lấy một con số đẹp trong bảng này.

---

## 2. Độ nét bề mặt — 15/09

Cổng của KẾ HOẠCH §3 đọc dải tần số cao, mà **bộ lấy mẫu quyết định dải ấy**, nên ngưỡng
khớp trên host chỉ chuyển sang board được nếu hai bên tính ra cùng một số.

Ca `surface sharpness on a known frame` trong `ai_engine/test_apps/antispoof` dựng một khung
480 × 320 với `word = (x·2654435761 + y·40503) >> 13` — mỗi điểm ảnh khác hẳn hàng xóm, tức
trường hợp khắc nghiệt nhất cho một phép thu nhỏ. Host tính lại đúng khung ấy.

| Bề rộng mặt | Board | Host | Lệch |
|---|---|---|---|
| 100 px | 1,364202 | 1,364201 | 1e−6 |
| 150 px | 2,170380 | 2,170382 | 2e−6 |
| 200 px | 1,981394 | 1,981393 | 1e−6 |

**Khớp tới 6 chữ số.** Phép lượng tử hoá từng ô về int8 nằm trong đường đo và không làm
dịch con số.

Phép thử này **không** phủ phép mở RGB565, vì khung tổng hợp sinh thẳng ra từ word 565 nên
cả hai bên cùng dùng `(r<<3)|(r>>2)`. Khung lưu ra đĩa thì `grab.py` mở bằng `r·255/31`,
lệch một đơn vị ở vài mức. Đóng nốt bằng cách nén ngược về 5/6/5 rồi mở lại kiểu board trước
khi chấm 93 khung: đường xu hướng đi từ `0,00095·w + 0,0802` sang `0,00097·w + 0,0776`, khe
giữa hai nhóm rộng ra từ 0,392 σ lên **0,443 σ**.

Ba bộ lấy mẫu cho ba kết quả khác nhau trên cùng khung ấy, nên con số chỉ có nghĩa khi kèm
đường crop:

| Bộ lấy mẫu | 100 px | 150 px | 200 px |
|---|---|---|---|
| `area_rows` — board | 1,364 | 2,170 | 1,981 |
| `Image.BOX` của PIL | 1,810 | 2,486 | 2,473 |
| `Image.BILINEAR` của PIL | 1,585 | 2,279 | 2,108 |
