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
