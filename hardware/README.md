# `hardware/` — mạch thật mà firmware chạy trên đó

Sơ đồ nguyên lý, PCB và tài liệu linh kiện của kiosk.

**KiCad bản:** _(điền khi mở lần đầu — `Help → About`)_. Định dạng `.kicad_sch` đổi theo major
version và không tương thích ngược, nên bản đã ghi ở đây là bản duy nhất mở được file trong `kicad/`.

## Đọc gì trước

Trước khi mở KiCad, đọc **KẾ HOẠCH §2** — toàn bộ bảng đấu nối từng chân, chân cấm dùng, ngân
sách nguồn đều ở đó. Thư mục này không giải thích lại, nó chỉ vẽ ra.

## Cái gì vào git, cái gì không

| Thư mục | Git | Vì sao |
|---|---|---|
| `kicad/` | ✅ | `.kicad_sch` / `.kicad_pcb` là s-expression dạng text, diff được |
| `lib/` | ✅ | Symbol và footprint tự vẽ. Kéo về thì kèm `UPSTREAM.md` |
| `export/` | ✅ | PDF/PNG cho báo cáo, nhẹ, là thứ người chấm đọc |
| `datasheets/` | ❌ | PDF của hãng — bản quyền không thuộc dự án. Chỉ `INDEX.md` vào git |
| `vendor/` | ❌ | Sơ đồ module hãng phát hành. Chỉ `UPSTREAM.md` vào git |

`*.kicad_prl`, `*-backups/` và `fp-info-cache` là rác phiên làm việc, mỗi máy một khác — đã
gitignore.

## §2 đúng, sơ đồ sai thì sửa sơ đồ

Chân GPIO khai ở **đúng hai chỗ**: `firmware/components/bsp_board/include/app_config.h` và KẾ
HOẠCH §2 (CLAUDE.md §1.3). Sơ đồ ở đây là **ảnh chụp** của §2, không phải nguồn thứ ba. Vẽ xong
thì đặt tên file trong `export/` kèm git sha của lần đọc §2:

```
export/kiosk_schematic_<sha7>.pdf
```

Lệch nhau thì §2 đúng và sơ đồ vẽ lại. Không bao giờ sửa §2 cho khớp bản vẽ.
