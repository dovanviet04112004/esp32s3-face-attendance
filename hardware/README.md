# `hardware/` — mạch thật mà firmware chạy trên đó

Sơ đồ nguyên lý, PCB và tài liệu linh kiện của kiosk.

**KiCad bản: 10.0.6** (`kicad-cli version`). Định dạng `.kicad_sch` đổi theo major
version và không tương thích ngược, nên bản đã ghi ở đây là bản duy nhất mở được file trong `kicad/`.
File trong `kicad/` ghi ở phiên bản định dạng `20260306` (sơ đồ) và `20260206` (PCB).

## Đọc gì trước

Trước khi mở KiCad, đọc **KẾ HOẠCH §2** — toàn bộ bảng đấu nối từng chân, chân cấm dùng, ngân
sách nguồn đều ở đó. Thư mục này không giải thích lại, nó chỉ vẽ ra.

## Cái gì vào git, cái gì không

| Thư mục | Git | Vì sao |
|---|---|---|
| `gen/` | ✅ | **Nguồn thật**: ba script sinh ra `kicad/` và `lib/` từ bảng chân §2 |
| `kicad/` | ✅ | `.kicad_sch` / `.kicad_pcb` là s-expression dạng text, diff được |
| `lib/` | ✅ | Symbol và footprint sinh từ `gen/`. Kéo về thì kèm `UPSTREAM.md` |
| `export/` | ✅ | PDF/PNG cho báo cáo, nhẹ, là thứ người chấm đọc |
| `datasheets/` | ❌ | PDF của hãng — bản quyền không thuộc dự án. Chỉ `INDEX.md` vào git |
| `vendor/` | ❌ | Sơ đồ module hãng phát hành. Chỉ `UPSTREAM.md` vào git |

`*.kicad_prl`, `*-backups/` và `fp-info-cache` là rác phiên làm việc, mỗi máy một khác — đã
gitignore.

## Sinh lại toàn bộ

Chạy **từ gốc repo**, đúng thứ tự — `gen_pcb` đọc sơ đồ vừa sinh để lấy net:

```bash
python3 hardware/gen/gen_fp.py     # footprint devkit tự vẽ  -> lib/footprints/
python3 hardware/gen/gen_sch.py    # sơ đồ + symbol          -> kicad/, lib/symbols/
python3 hardware/gen/gen_pcb.py    # PCB                     -> kicad/
kicad-cli pcb upgrade hardware/kicad/kiosk.kicad_pcb
python3 tools/check_schematic.py && python3 tools/check_pcb.py
```

`pcb upgrade` là bắt buộc: `gen_pcb.py` ghi ở định dạng `20241229` rồi để KiCad nâng lên
`20260206`, vì viết thẳng định dạng mới nhất bằng tay là chép một thứ sẽ đổi ở bản sau.

**Sinh lại phải ra file y hệt.** Chạy hai lần liên tiếp mà `git status` sạch thì đúng; lệch
là có uuid nào đó đang lấy ngẫu nhiên, và mỗi lần chạy sẽ đẻ ra hai nghìn dòng diff che mất
thay đổi thật. Đừng sửa tay file trong `kicad/` — lần sinh sau mất sạch.

## Đóng KiCad trước khi sinh lại sơ đồ

KiCad giữ cả file trong bộ nhớ. Đang mở mà có ai ghi đè file dưới đĩa thì lần Save
tiếp theo của KiCad **xoá sạch** thay đổi đó — không báo gì cả. Đã mất một lần sửa
chỗ đặt linh kiện đúng theo cách này.

Hai file `~kiosk.kicad_*.lck` là dấu hiệu KiCad đang mở project; còn chúng thì không
ghi vào `kicad/`. Và mỗi lần sơ đồ đổi, chạy:

```bash
python3 tools/check_schematic.py
```

Nó đọc thẳng `kiosk.kicad_sch`, đối chiếu từng chân devkit với `app_config.h` và bắt
cả chữ chen nhau. Kiểm trên file thật nên bắt được cả thứ do KiCad ghi ra.

## §2 đúng, sơ đồ sai thì sửa sơ đồ

Chân GPIO khai ở **đúng hai chỗ**: `firmware/components/bsp_board/include/app_config.h` và KẾ
HOẠCH §2 (CLAUDE.md §1.3). Sơ đồ ở đây là **ảnh chụp** của §2, không phải nguồn thứ ba. Vẽ xong
thì đặt tên file trong `export/` kèm git sha của lần đọc §2:

```
export/kiosk_schematic_<sha7>.pdf
```

Lệch nhau thì §2 đúng và sơ đồ vẽ lại. Không bao giờ sửa §2 cho khớp bản vẽ.
