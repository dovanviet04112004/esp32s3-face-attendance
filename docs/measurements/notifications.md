# Thông báo — số đo đổi lược đồ và vận hành

Số liệu cho KẾ HOẠCH §9.21.4 và TASKS E27. Mỗi bảng ghi ngày, lệnh đo và bộ dữ liệu đo trên.

## 1. Nở lược đồ và đổ dữ liệu (E27-T2)

Bốn migration chạy theo thứ tự: `20261001170000_notice_item_types` (kiểu enum mới),
`20261001170100_notice_items` (bảng `NoticeItem`, cột mới của `Notification`, hai `CHECK`),
`20261001170200_notice_backfill` (chủ thể, `facts`, khoá, việc, gộp dòng trùng khoá),
`20261001170300_notice_dedup_key` (ràng buộc duy nhất và chỉ mục từng phần của số trên chuông).

### 1.1 Trên bản phục hồi production — 01/10/2026

Bản chính `kiosk-20260930T191000Z.dump.age`, giải mã và `pg_restore` vào một `postgres:16-alpine`
vứt đi trên máy giữ khoá. Production lúc sao lưu mới tới `20260926080000_firmware_on_trial`, nên mọi
migration ngày 01/10 chạy theo thứ tự. Mỗi file chạy bằng `psql --set ON_ERROR_STOP=1`, bấm giờ ở
phía gọi, nên số gồm cả một vòng `docker exec`.

| Migration | Thời gian |
|---|---|
| `20261001090000_search_folded` | 230 ms |
| `20261001090100_employee_code_trgm` | 146 ms |
| `20261001090200_advance_paid_notice` | 120 ms |
| `20261001160000_request_reason_trgm` | 146 ms |
| `20261001170000_notice_item_types` | 142 ms |
| `20261001170100_notice_items` | 170 ms |
| `20261001170200_notice_backfill` | 173 ms |
| `20261001170300_notice_dedup_key` | 126 ms |

| Đếm | Trước | Sau |
|---|---|---|
| dòng `Notification` | 12 (`REQUEST_DECIDED` 4, `REQUEST_WAITING` 8) | 12 |
| dòng chưa có `dedupKey` | — (cột chưa có) | 0 |
| dòng có chủ thể | — | 12 |
| dòng nối vào một việc | — | 8 |
| `NoticeItem` | — (bảng chưa có) | 4: `ADVANCES_TO_DECIDE`/`DONE` 3, `CERTIFICATES`/`DONE` 1 |

Chạy lại `20261001170200_notice_backfill` lần hai: 144 ms, mọi con số giữ nguyên.

### 1.2 Trên bản sao DB walk — 01/10/2026

`CREATE DATABASE e27copy TEMPLATE walk` từ bộ dữ liệu demo (5.006 nhân viên, 59.718 đơn, 48 đơn
chờ), đã áp tới `20261001090200_advance_paid_notice`, rồi chạy các file như trên.

| Migration | Thời gian |
|---|---|
| `20261001160000_request_reason_trgm` | 516 ms |
| `20261001170000_notice_item_types` | 176 ms |
| `20261001170100_notice_items` | 234 ms |
| `20261001170200_notice_backfill` | 510 ms |
| `20261001170300_notice_dedup_key` | 163 ms |

| Đếm | Trước | Sau |
|---|---|---|
| dòng `Notification` | 27 | 27 |
| dòng chưa có `dedupKey` | — | 0 |
| `NoticeItem` | — | 57, trong đó 54 `OPEN` |
| dòng nối vào một việc | — | 3 |

Bước đổ dữ liệu quét `Request` một lần cho mỗi hàng đợi; ở 59.718 đơn nó mất nửa giây.

## 2. Đổ dữ liệu lần hai (E27-T4)

Hai bản phát hành giữa lượt đổ đầu và E27-T4 vẫn ghi dòng hình dạng cũ: không chủ thể, không khoá, không
nối vào việc. `20261001200000_notice_backfill_since` chuyển chúng như lượt đầu, nhưng chỉ mục duy nhất
`(userId, dedupKey)` đã đứng, nên dòng lặp phải gộp **trước** khi gán khoá: dòng cũ mà khoá đã có dòng
giữ thì cộng vào `remindCount` của dòng ấy rồi xoá; các dòng cũ cùng khoá thì giữ dòng mới nhất.

### 2.1 Trên bản phục hồi production — 01/10/2026

Cùng bản `kiosk-20260930T191000Z.dump.age` và cách chạy như §1.1; áp các migration tới
`20261001170300_notice_dedup_key` để đứng đúng chỗ production sau E27-T3, rồi chèn 9 dòng hình dạng
cũ có chủ đích đụng khoá:

- một đơn mới `PENDING` mà bản cũ đã báo cho 2 tài khoản bàn nhân sự, mỗi tài khoản 1 dòng báo và 2 dòng
  nhắc ở mốc 3 và 7 — 6 dòng cùng khoá theo từng người;
- 3 bản chép của dòng đã có khoá — khoá của chúng đã có dòng giữ.

| Migration | Thời gian |
|---|---|
| `20261001190000_certificate_cancelled` | 202 ms |
| `20261001200000_notice_backfill_since` | 256 ms |

| Đếm | Sau E27-T3 | Thêm dòng cũ | Sau migration |
|---|---|---|---|
| dòng `Notification` | 12 | 21 | 14 |
| dòng chưa có `dedupKey` | 0 | 9 | 0 |
| dòng nối vào một việc | 8 | 8 | 10 |
| `NoticeItem` | 4 | 4 | 5 — thêm `REQUESTS`/`OPEN` 1 |
| khoá trùng theo người | 0 | — | 0 |

Đơn thử còn 2 dòng, mỗi tài khoản một, chưa đọc, `remindCount` cộng lại là 4. Chạy lại migration lần
hai: mọi con số giữ nguyên.

## 3. Chốt kỳ không chờ đẩy (E27-T7)

Chốt một kỳ ghi một dòng `PAYSLIP_ISSUED` cho mỗi người có phiếu rồi đẩy tới máy của họ. Đo bằng một
bộ e2e tạm, không commit, chạy như CI (`run_e2e.sh`, Postgres 16 và Redis 7 trong Docker trên máy
dev): mỗi người một đăng nhập và một máy nhận đẩy, `webpush.sendNotification` thay bằng một hàm chờ
**20 ms** rồi trả `201`, đứng thay cho nhà cung cấp đẩy. `lockMs` là thời gian của chính
`PayrollService.lock`, tức thời gian người bấm chốt phải chờ; `allPushedMs` tính từ lúc bấm tới khi
lần đẩy cuối cùng xong. Ngày đo 01/10/2026.

| Mã | Phiếu | `lockMs` | Dòng ghi | Đẩy trong request | Đẩy xong sau |
|---|---|---|---|---|---|
| E27-T6 (`96cc414a`) | 3.000 | 2.585 ms | 3.000 | 3.000 | 2,6 s |
| E27-T6 (`96cc414a`) | 5.000 | 775 ms | **0** | 0 | — |
| E27-T7 | 3.000 | 1.594 ms | 3.000 | 0 | 10,6 s |
| E27-T7 | 5.000 | 3.446 ms | 5.000 | 0 | 9,1 s |

- **Trước, 5.000 phiếu không báo được ai.** Mã từ E27-T4 ghi mọi dòng bằng một câu `INSERT`, hai mươi
  tham số mỗi dòng: 5.000 dòng là 100.000 tham số, quá trần 65.535 của một câu lệnh, Postgres trả
  `bind message has 34464 parameter formats but 0 parameters` và lỗi bị nuốt như mọi lỗi thông báo.
  E27-T7 ghi theo lô 1.000 dòng.
- **Trước, đẩy chạy trong request**, mọi máy cùng lúc, không giới hạn: 3.000 lần gọi song song xong
  trong 2,6 s với nhà cung cấp giả trả lời sau 20 ms, nhưng với nhà cung cấp thật là 3.000 kết nối HTTPS
  mở cùng lúc từ một request đang giữ người bấm chốt.
- **Sau, request chỉ ghi dòng và xếp job** `notice-fanout`, mỗi job 1.000 dòng, mỗi lượt 50 lần gửi
  song song. Đẩy xong trong khoảng 10 s ở nền.
