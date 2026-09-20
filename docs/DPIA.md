# Đánh giá tác động xử lý dữ liệu cá nhân

Hồ sơ theo **Điều 24 Nghị định 13/2023/NĐ-CP**, lập cho hệ chấm công nhận diện khuôn mặt
`esp32s3-face-attendance`. Bản này mô tả **hệ như nó đang được dựng**; mọi con số chưa đo trên
thiết bị thật được đánh dấu 🔬.

---

## 1. Bên xử lý và mục đích

| Mục | Nội dung |
|---|---|
| Bên kiểm soát dữ liệu | Tổ chức triển khai hệ thống (điền khi bàn giao) |
| Bên xử lý | Cùng một tổ chức; hệ tự vận hành, không thuê bên thứ ba xử lý |
| Mục đích | Xác định danh tính người lao động tại cửa ra vào để ghi nhận giờ làm và tính lương |
| Căn cứ pháp lý | **Sự đồng ý riêng** của chủ thể dữ liệu (Điều 11), tách khỏi hợp đồng lao động |
| Phạm vi | Người lao động đã ký đồng ý; khách và người ngoài **không** được ghi danh |

**Vì sao không dựa vào "thực hiện hợp đồng lao động".** Chấm công có nhiều cách không cần sinh
trắc — thẻ từ, mã PIN, vân tay. Khuôn mặt không phải phương tiện duy nhất khả dĩ, nên căn cứ
hợp lý duy nhất là sự đồng ý, và sự đồng ý phải **rút lại được mà không mất việc**.

---

## 2. Dữ liệu xử lý

| Loại | Nhạy cảm | Lưu ở đâu | Dạng lưu |
|---|---|---|---|
| **Embedding khuôn mặt** (vector 512 chiều INT8) | **Có** (Điều 2.4.đ) | Kiosk: LittleFS · Máy chủ: `FaceTemplate.embedding` | Kiosk: nhị phân thô · Máy chủ: **mã hoá đối xứng**, khoá ở biến môi trường |
| Ảnh khuôn mặt lúc chấm công | **Có** | MinIO, đường dẫn ở `AttendanceRecord.photoUrl` | Tệp ảnh |
| Họ tên, mã nhân viên, phòng ban | Không | Postgres | Rõ |
| Số CCCD, mã số thuế, mã BHXH, số tài khoản | Không (nhưng là dữ liệu cá nhân cơ bản) | Postgres | Rõ |
| Giờ vào, giờ ra, ngày công | Không | Postgres | Rõ |
| Điểm khớp, điểm chống giả | Không | Postgres | Rõ |

**Ảnh gốc không bao giờ rời kiosk trừ ảnh chấm công.** Quá trình ghi danh chạy trên board: ảnh
chụp → embedding → ảnh bị bỏ. Máy chủ **không nhận ảnh ghi danh**, chỉ nhận vector.

---

## 3. Luồng dữ liệu

```
Camera → (trên kiosk) phát hiện mặt → chống giả → trích embedding → so khớp cục bộ
                                                          │
                                        chỉ khi ghi danh:  └→ MQTT/TLS → máy chủ → mã hoá → Postgres
                                                          │
                                       khi chấm công:      └→ MQTT/TLS → máy chủ → AttendanceRecord
```

- **So khớp xảy ra trên thiết bị.** Không có luồng nào gửi khuôn mặt lên máy chủ để so.
  Mạng đứt thì kiosk vẫn chấm công được; điều này cũng có nghĩa là dữ liệu không phải ra khỏi
  toà nhà để hệ hoạt động.
- Kênh truyền là **MQTT trên TLS**, kiosk ghim CA riêng. Không có đường HTTP trần.
- Máy chủ không bao giờ trả embedding cho trình duyệt. Chỉ kiosk đã duyệt mới nhận, và mỗi lần
  nhận là **một dòng trong nhật ký** (`biometric.read`).

---

## 4. Rủi ro và biện pháp

| # | Rủi ro | Mức | Biện pháp đang có |
|---|---|---|---|
| 1 | Lộ embedding từ máy chủ | Cao | Mã hoá lúc lưu, khoá nằm ngoài cơ sở dữ liệu; không commit khoá (§6 CLAUDE.md) |
| 2 | Lộ embedding từ kiosk bị lấy cắp | Cao | 🔬 Flash Encryption + Secure Boot **chưa bật** — xem §7 |
| 3 | Nghe lén đường truyền | Trung bình | MQTTS ghim CA riêng; proxy không bóc TLS (§4.8) |
| 4 | Ghi danh người không đồng ý | Cao | Máy chủ **từ chối** ghi danh khi chưa có đồng ý còn hiệu lực, trả `BIOMETRIC_CONSENT_MISSING` |
| 5 | Xem dữ liệu sinh trắc không dấu vết | Trung bình | Nhật ký phủ cả **đọc**: mỗi lần phát template cho kiosk ghi một dòng |
| 6 | Không xoá được khi rút đồng ý | Cao | Một lệnh rút đồng ý xoá template ở máy chủ **và** phát lệnh xoá tới mọi kiosk từng nhận |
| 7 | Nhận nhầm người | Trung bình | Ngưỡng khớp và ngưỡng chống giả cấu hình được; mọi lượt lưu điểm số để tra lại |
| 8 | Ảnh giả qua mặt hệ | Trung bình | 🔬 Model chống giả đo được 62/62 mặt thật INT8; ảnh in cỡ vừa vẫn lọt trong tập thử |
| 9 | Dữ liệu giữ quá lâu | Trung bình | §9.22.7 đặt hạn giữ; sinh trắc xoá khi nghỉ việc, hồ sơ nhân sự ở lại |
| 10 | Người lao động không biết mình bị xử lý gì | Trung bình | Cổng nhân viên cho xem lịch sử đồng ý của chính mình |

---

## 5. Quyền của chủ thể dữ liệu, và đường thực hiện

| Quyền | Điều | Thực hiện bằng cách nào |
|---|---|---|
| Được biết | 13 | Văn bản thông báo có **số phiên bản**, lưu cùng bản ghi đồng ý |
| Đồng ý và **rút đồng ý** | 11, 12 | `POST /biometric-consents` và `POST /biometric-consents/:id/withdraw` |
| Truy cập | 14 | `GET /biometric-consents/:employeeId` và cổng nhân viên |
| Xoá | 16 | Rút đồng ý xoá luôn; nghỉ việc cũng xoá |
| Hạn chế, phản đối | 17, 18 | Rút đồng ý là đường thực hiện; chuyển sang chấm công thẻ |
| Khiếu nại | 19 | Kênh khiếu nại trong cổng nhân viên |

**Rút đồng ý phải có hiệu lực ngay, không chờ ai duyệt.** Bản ghi chuyển `WITHDRAWN`, template
xoá, kiosk nhận lệnh xoá trong cùng một lần gọi.

---

## 6. Thời hạn lưu

| Dữ liệu | Giữ bao lâu | Vì sao |
|---|---|---|
| Embedding khuôn mặt | Đến khi rút đồng ý hoặc nghỉ việc | Không còn mục đích thì không còn căn cứ giữ |
| Ảnh chấm công | 🔬 Theo cấu hình, mặc định đề xuất 90 ngày | Đủ để đối chất một tranh chấp chấm công |
| Bản ghi chấm công | Theo hạn lưu chứng từ lao động | Là căn cứ trả lương |
| Phiếu lương và dòng phiếu | Theo hạn lưu chứng từ kế toán | Nghĩa vụ thuế và bảo hiểm |
| Nhật ký truy cập sinh trắc | 🔬 Đề xuất 2 năm | Đủ để chứng minh khi bị hỏi |

---

## 7. Việc còn phải làm trước khi chạy thật

Ghi thẳng ra, vì một hồ sơ đánh giá tác động không nói thật thì vô dụng:

1. **Flash Encryption và Secure Boot chưa bật trên kiosk** (E13-T3). Chưa bật thì người cầm
   được board đọc được embedding trong flash. Đây là rủi ro số 2 ở bảng trên và nó **chưa
   được giảm nhẹ**. Bật là thao tác một chiều nên cần quyết định riêng.
2. **Văn bản thông báo chưa soạn.** Hệ đã lưu số phiên bản văn bản, nhưng nội dung văn bản là
   việc của bên kiểm soát dữ liệu.
3. **Chưa khai bộ phận phụ trách bảo vệ dữ liệu với Bộ Công an.**
4. **Hạn lưu ảnh chấm công chưa có job dọn tự động.**
5. **Chưa đo lại ngưỡng chống giả với ảnh in khổ lớn** (E9 còn nợ số đo).

---

## 8. Kết luận

Hệ xử lý dữ liệu nhạy cảm và có đủ bốn cơ chế Điều 24 đòi: đồng ý riêng có phiên bản, nhật ký
phủ cả đọc, đường xoá thật xuống tận thiết bị, và hồ sơ này. **Rủi ro còn lại lớn nhất là mục
7.1** — mã hoá flash trên kiosk. Chừng nào chưa bật, không nên triển khai ở nơi kiosk đặt ngoài
vùng kiểm soát vật lý.
