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
python3 hardware/gen/gen_fp.py     # ba footprint tự vẽ      -> lib/footprints/
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

## Lỗ khoan

| Ø | Số lỗ | Ở đâu | Cái gì cắm vào |
|---|---|---|---|
| **0,40 mm** | 27 | rải khắp board | **Via** tín hiệu — không cắm gì, chỉ nối đồng hai mặt |
| **0,60 mm** | 19 | rải khắp board | **Via nguồn** — khoan to hơn vì mỗi cái gánh cả dòng về của một tải |
| **0,80 mm** | 8 | `R1` `C2` `C3` `C4` | Chân trở 1/4 W và chân tụ nhỏ, đều ~0,6 mm |
| **1,00 mm** | 139 | `U1` `J3` `J4` `J5` `J6` `J7` `J9` `J13` `J14` `J16` `J18`, `C1`, và hai lưới hàn `J15` `J17` | Chân header 2,54 mm (vuông 0,64 → chéo 0,91), chân tụ 1000 µF, lưới 4 × 5 giữ breakout USB và hai cặp lỗ nguồn của chúng |
| **1,30 mm** | 4 | `J10` `J11` | Chân domino MX126-5.0 |
| **3,20 mm** | 8 | `H1`…`H4` bắt tấm màn (lỗ trên màn Ø3,5); `H5`…`H8` bắt board vào vỏ, bốn góc | Vít M3 — **không phủ đồng** (NPTH) |

**Board 2 lớp**, dày 1,6 mm. Đường nguồn 1,0 mm đi mặt sau, tín hiệu 0,25 mm đi mặt trước; đường nào
bí thì lật mặt, và chỗ lật là một via. **Mọi via đều bịt mask hai mặt** — không có đồng trần nào ngoài
chân cắm. Theo IPC-2221 ở 1 oz, dây 1,0 mm chịu **2,39 A** so với đỉnh
1,34 A của rail 1, còn via Ø0,6 chịu **1,48 A** so với 0,91 A của via nặng nhất.

Vành đồng mỏng nhất **0,20 mm** (via tín hiệu); mỏng nhất trong các lỗ cắm là **0,35 mm** (các lỗ 1,00). `tools/check_pcb.py` chặn lỗ dưới 0,30 mm và
vành dưới 0,20 mm — dưới mức đó thì xưởng rẻ bắt đầu hỏi lại hoặc báo giá khác.

Bốn lỗ vít là **NPTH nên không có vành**, đó là đúng chứ không phải thiếu: có đồng quanh lỗ bắt
vít thì đầu vít chạm vào là chập. Cùng lý do, **không đồng nào trong bán kính 3,5 mm quanh cả tám
lỗ vít**, hai mặt, dây lẫn via — cỡ long đen M3. DRC chỉ đo tới mép lỗ, còn thứ đè lên mặt board
là đầu vít với trụ đồng, rộng gấp đôi lỗ (KẾ HOẠCH §2.5).

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
