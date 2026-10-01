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
