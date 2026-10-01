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

## 4. Vận hành trên production (E27-T11) — 02/10/2026

Đo lúc 04:03 giờ Việt Nam (21:03 UTC ngày 01/10), sau bản `2d64ba91`, bằng `psql` trong `kiosk-postgres`
và `docker logs kiosk-api`. Dữ liệu là bản chạy thử: 9 đăng nhập đang dùng, 11 nhân viên, 13 dòng
`Notification`, 5 `NoticeItem`. Các số dưới đây là **mốc ban đầu**, chưa phải thống kê.

| Hàng đợi | Việc | Đã đóng | Tới lần đọc đầu, trung vị · lâu nhất | Tới lúc đóng, trung vị · lâu nhất |
|---|---|---|---|---|
| `ADVANCES_TO_DECIDE` | 3 | 3 | 0,3 · 0,4 phút | 0,3 · 0,5 phút |
| `CERTIFICATES` | 1 | 1 | 0,3 phút | 0,3 phút |
| `KIOSK` | 1 | 0 | chưa ai đọc | còn mở: kiosk vẫn tắt |

Tới lần đọc đầu là `min(Notification.readAt) − NoticeItem.openedAt` trên các dòng của việc; tới lúc đóng
là `closedAt − openedAt`. Bốn việc đã đóng đều do người thử bấm ngay sau khi gửi, nên con số phút ở đây nói
về đường đi của dữ liệu, chưa nói gì về người duyệt thật.

| Đo | Số | Nguồn |
|---|---|---|
| Lượt đối soát đóng hay mở thêm | 0 đóng, 0 mở, 0 vào nhóm, 0 rời nhóm ở lượt 21:00 UTC | log `ReconcileSweep` |
| Lượt quét kiosk | 0 báo im, 0 đóng ở mọi lượt 5 phút từ 20:45 UTC | log `KioskSweep` |
| Máy nhận đẩy | 1, của một tài khoản `HR`; lần `2xx` gần nhất 24/09 11:02 UTC | `PushSubscription.lastSentAt` |
| Đẩy bị gỡ vì `404`/`410` · đẩy lỗi khác | 0 · 0 kể từ khi container khởi động 20:40 UTC | log `NotificationsService` |

Log của các container trước đi theo container khi deploy, nên số gỡ và lỗi chỉ tính từ lần khởi động
gần nhất. Cảnh báo kiosk duy nhất tới `ADMIN`, mà máy nhận đẩy duy nhất là của `HR`, nên không có lần
đẩy nào sau 24/09 là đúng.

| Bảng | Bảng | Chỉ mục | Tổng |
|---|---|---|---|
| `Notification` | 8 kB | 112 kB | 128 kB |
| `NoticeItem` | 8 kB | 64 kB | 80 kB |
| `PushSubscription` | 8 kB | 48 kB | 64 kB |
| `NotificationPreference` | 8 kB | 16 kB | 32 kB |

Lệnh đo, chạy bằng `psql` trong `kiosk-postgres`; số gỡ và lỗi đẩy đếm bằng
`docker logs kiosk-api 2>&1 | grep -ciE "dropped a dead subscription"` và `… "push to .* failed"`:

```sql
SELECT i."queue", count(*) AS items, count(*) FILTER (WHERE i."state" <> 'OPEN') AS closed,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r."firstRead" - i."openedAt") / 60)::numeric, 1) AS first_read_p50_min,
       round(max(extract(epoch FROM r."firstRead" - i."openedAt") / 60)::numeric, 1) AS first_read_max_min,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM i."closedAt" - i."openedAt") / 60)::numeric, 1) AS close_p50_min,
       round(max(extract(epoch FROM i."closedAt" - i."openedAt") / 60)::numeric, 1) AS close_max_min
  FROM "NoticeItem" i
  LEFT JOIN LATERAL (SELECT min(n."readAt") AS "firstRead" FROM "Notification" n WHERE n."itemId" = i."id") r ON true
 GROUP BY i."queue" ORDER BY i."queue";
SELECT "kind", count(*) AS rows, count(*) FILTER (WHERE "readAt" IS NULL) AS unread FROM "Notification" GROUP BY "kind" ORDER BY "kind";
SELECT count(*) AS devices, count(*) FILTER (WHERE "lastSentAt" IS NOT NULL) AS pushed_once, max("lastSentAt") AS last_push FROM "PushSubscription";
SELECT c.relname, c.reltuples::bigint AS est_rows, pg_size_pretty(pg_relation_size(c.oid)) AS heap, pg_size_pretty(pg_indexes_size(c.oid)) AS indexes, pg_size_pretty(pg_total_relation_size(c.oid)) AS total
  FROM pg_class c WHERE c.relname IN ('Notification', 'NoticeItem', 'PushSubscription', 'NotificationPreference') ORDER BY c.relname;
```

## 5. Chuông ở quy mô lớn (E27-T11) — 02/10/2026

`CREATE DATABASE e27t11 TEMPLATE walk` từ DB demo đã áp tới `20261002150000_notice_punch_recorded`, rồi
nạp thêm bằng `generate_series`: 1.000 tài khoản, mỗi tài khoản 500 dòng tin, 20% chưa đọc; và tài khoản
`HR` của bộ demo giữ 50.105 dòng — 10.000 việc `REQUESTS` (2.000 còn mở, nửa số dòng của việc mở chưa
đọc), 50 việc kiosk `CRITICAL` còn mở, 40.000 dòng tin (30% chưa đọc, 10% đã cất). Tổng 558.223 dòng,
`VACUUM ANALYZE` xong mới đo. PostgreSQL 16.15 trong Docker trên máy dev (WSL2). Mỗi câu chạy ba lần
bằng `EXPLAIN (ANALYZE, BUFFERS)`, ghi lần thứ ba, tức khi cache đã ấm; câu cập nhật chạy trong một
giao dịch rồi `ROLLBACK`.

| Câu, cho tài khoản `HR` giữ 50.105 dòng | Kế hoạch | Thời gian |
|---|---|---|
| Đếm chưa đọc kiểu cũ: chỉ `readAt IS NULL` | index-only trên `(userId, readAt)`, 13.060 dòng | 3,0 ms |
| Số trên chuông: chưa đọc, chưa cất, chưa rời nhóm | index-only trên chỉ mục từng phần, 11.675 dòng | 2,4 ms |
| *Cần xử lý*: việc mở người ấy giữ | hash join qua `Notification(itemId)`, 10.106 dòng | 17,8 ms |
| Chấm đỏ: việc mở `CRITICAL` người ấy giữ | 50 việc rồi tra từng dòng | 1,3 ms |
| Trang đầu, tab *Tất cả* | quét ngược `(userId, createdAt)`, dừng ở 21 dòng | 0,7 ms |
| Trang đầu, tab *Cần xử lý* | như trên, dừng ở 42 dòng | 0,7 ms |
| Tổng dưới trần 10.000, tab *Tất cả* | bitmap trên `(userId, readAt)` | 5,5 ms |
| *Đánh dấu đã đọc hết* 11.675 dòng | bitmap rồi cập nhật hai chỉ mục | 701 ms |

| Bảng | Dòng | Bảng | Chỉ mục | Tổng | Mỗi dòng |
|---|---|---|---|---|---|
| `Notification` | 558.223 | 73 MB | 132 MB | 205 MB | 385 B |
| `NoticeItem` | 18.095 | 3,2 MB | 3,9 MB | 7,2 MB | 415 B |

Chỉ mục lớn nhất là ràng buộc duy nhất `(userId, dedupKey)` 51 MB, rồi `(userId, createdAt)` 37 MB và
khoá chính 25 MB; chỉ mục từng phần của số trên chuông chỉ 1,5 MB vì nó giữ dòng chưa đọc.

- **Số trên chuông không chậm đi theo bảng.** Nó đọc đúng phần chưa đọc của một người, và 2,4 ms ở 11.675
  dòng chưa đọc là trường hợp xấu: một bàn nhân sự để dồn hàng chục nghìn tin.
- **Đếm *Cần xử lý* là câu đắt nhất của chuông**, 17,8 ms, vì nó đi qua mọi dòng việc của người ấy rồi nối
  với việc. Với một người giữ 10.000 việc vẫn dưới 20 ms, nên chưa cần chỉ mục riêng; đây là chỗ đo lại
  đầu tiên nếu một bàn giữ tới hàng trăm nghìn việc.
- 🔬 **Ước lượng, chưa đo:** ba mươi nghìn người, mỗi người khoảng hai dòng một tháng, giữ 180 ngày theo
  `NOTICE_KEEP_DAYS` là khoảng 360.000 dòng thường trực, tức khoảng 140 MB theo 385 B mỗi dòng ở trên.

Lệnh nạp, chạy bằng `psql -U walk -d e27t11`:

```sql
INSERT INTO "User" ("id", "email", "passwordHash", "role", "updatedAt")
SELECT 'load-' || g, 'load-' || g || '@load.local', 'x', 'EMPLOYEE', now() FROM generate_series(1, 1000) g;
INSERT INTO "NoticeItem" ("id", "key", "queue", "subjectType", "subjectId", "state", "closedAt", "openedAt")
SELECT 'li-' || g, 'requests:' || md5(g::text)::uuid, 'REQUESTS', 'REQUEST', md5(g::text)::uuid::text,
       (CASE WHEN g <= 2000 THEN 'OPEN' ELSE 'DONE' END)::"NoticeItemState",
       CASE WHEN g <= 2000 THEN NULL ELSE now() - (g || ' minutes')::interval END,
       now() - (g || ' minutes')::interval - interval '1 hour'
  FROM generate_series(1, 10000) g;
INSERT INTO "NoticeItem" ("id", "key", "queue", "subjectType", "subjectId", "level", "state", "openedAt")
SELECT 'lk-' || g, 'kiosk:load-kiosk-' || g || ':offline', 'KIOSK', 'DEVICE', 'load-kiosk-' || g, 'CRITICAL', 'OPEN',
       now() - (g || ' minutes')::interval
  FROM generate_series(1, 50) g;
INSERT INTO "Notification" ("id", "userId", "kind", "itemId", "subjectType", "subjectId", "dedupKey", "readAt", "archivedAt", "createdAt")
SELECT 'ln-i-' || i."id", h."id", (CASE WHEN i."queue" = 'KIOSK' THEN 'KIOSK_ALERT' ELSE 'REQUEST_WAITING' END)::"NoticeKind",
       i."id", i."subjectType", i."subjectId", i."key",
       CASE WHEN i."state" = 'OPEN' AND random() < 0.5 THEN NULL ELSE i."openedAt" + interval '5 minutes' END,
       CASE WHEN random() < 0.1 THEN now() END, i."openedAt"
  FROM "NoticeItem" i CROSS JOIN (SELECT "id" FROM "User" WHERE "email" = 'hr@kiosk.local') h
 WHERE i."id" LIKE 'li-%' OR i."id" LIKE 'lk-%';
INSERT INTO "Notification" ("id", "userId", "kind", "dedupKey", "readAt", "archivedAt", "createdAt")
SELECT 'ln-h-' || g, h."id", 'REQUEST_DECIDED', 'request-decided:row:ln-h-' || g,
       CASE WHEN random() < 0.3 THEN NULL ELSE now() - (g || ' minutes')::interval END,
       CASE WHEN random() < 0.1 THEN now() END, now() - (g || ' minutes')::interval
  FROM generate_series(1, 40000) g CROSS JOIN (SELECT "id" FROM "User" WHERE "email" = 'hr@kiosk.local') h;
INSERT INTO "Notification" ("id", "userId", "kind", "dedupKey", "readAt", "createdAt")
SELECT 'ln-' || u || '-' || g, 'load-' || u, 'REQUEST_DECIDED', 'request-decided:row:ln-' || u || '-' || g,
       CASE WHEN random() < 0.2 THEN NULL ELSE now() END, now() - ((u * 500 + g) || ' seconds')::interval
  FROM generate_series(1, 1000) u CROSS JOIN generate_series(1, 500) g;
VACUUM ANALYZE "Notification";
VACUUM ANALYZE "NoticeItem";
SELECT count(*) AS rows, count(DISTINCT "userId") AS logins FROM "Notification";
```

Lệnh đo, với `:hr` là id của `hr@kiosk.local` (`SELECT "id" AS hr FROM "User" WHERE "email" = 'hr@kiosk.local' \gset`):

```sql
EXPLAIN (ANALYZE, BUFFERS, SUMMARY ON) SELECT count(*) FROM "Notification" WHERE "userId" = :'hr' AND "readAt" IS NULL;
EXPLAIN (ANALYZE, BUFFERS, SUMMARY ON) SELECT count(*) FROM "Notification" WHERE "userId" = :'hr' AND "readAt" IS NULL AND "archivedAt" IS NULL AND "leftAt" IS NULL;
EXPLAIN (ANALYZE, BUFFERS, SUMMARY ON) SELECT count(*) FROM "Notification" n LEFT JOIN "NoticeItem" i ON i."id" = n."itemId"
 WHERE n."userId" = :'hr' AND n."leftAt" IS NULL AND i."state" = 'OPEN';
EXPLAIN (ANALYZE, BUFFERS, SUMMARY ON) SELECT count(*) FROM "Notification" n LEFT JOIN "NoticeItem" i ON i."id" = n."itemId"
 WHERE n."userId" = :'hr' AND n."leftAt" IS NULL AND i."state" = 'OPEN' AND i."level" = 'CRITICAL';
EXPLAIN (ANALYZE, BUFFERS, SUMMARY ON) SELECT n.*, i."key", i."state", i."outcome", i."closedAt" FROM "Notification" n LEFT JOIN "NoticeItem" i ON i."id" = n."itemId"
 WHERE n."userId" = :'hr' AND n."archivedAt" IS NULL ORDER BY n."createdAt" DESC, n."id" DESC LIMIT 20;
EXPLAIN (ANALYZE, BUFFERS, SUMMARY ON) SELECT n.*, i."key", i."state" FROM "Notification" n LEFT JOIN "NoticeItem" i ON i."id" = n."itemId"
 WHERE n."userId" = :'hr' AND n."leftAt" IS NULL AND i."state" = 'OPEN' ORDER BY n."createdAt" DESC, n."id" DESC LIMIT 20;
EXPLAIN (ANALYZE, BUFFERS, SUMMARY ON) SELECT count(*) FROM (SELECT 1 FROM "Notification" WHERE "userId" = :'hr' AND "archivedAt" IS NULL LIMIT 10001) x;
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, SUMMARY ON) UPDATE "Notification" SET "readAt" = now() WHERE "userId" = :'hr' AND "archivedAt" IS NULL AND "readAt" IS NULL;
ROLLBACK;
```
