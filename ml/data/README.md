# ml/data/

Thư mục **dữ liệu**, không phải code. Toàn bộ bị gitignore trừ ba loại file: `README.md`
này, `splits/`, và mọi `manifest.yaml` / `manifest.csv`.

## Dữ liệu nằm ở đâu

Ổ `C:` chỉ còn ~8 GB nên đĩa ext4 của WSL không nở thêm được; toàn bộ dữ liệu nặng nằm
trên **`E:`**, thấy từ WSL là `/mnt/e/face-attendance-data`.

| Trong repo | Thực tế |
|---|---|
| `data/interim`, `data/processed`, `data/cache` | symlink thẳng sang `E:` |
| `data/raw/<nhánh>/<dataset>/<mục>` | symlink từng mục sang `E:` |
| `data/raw/**/manifest.yaml` | file thật, commit vào git |
| `data/splits/` | file thật, commit vào git |

Manifest và split ở lại trong repo vì chúng là thứ bắt buộc commit (§4.3). Chỉ phần nặng
đi ra ngoài.

Dựng lại symlink sau khi clone bằng `./scripts/00_fetch_raw.sh --verify` — nó tạo một link
cho **mọi mục có trên ổ**, không chỉ những mục `expects` gọi tên. Thiếu link thì dữ liệu vẫn
nằm trên ổ nhưng loader glob theo đường dẫn repo sẽ không thấy, và nó không báo lỗi.

Đường dẫn dùng trong code khai ở `ml/configs/common/paths.yaml`, không hardcode. Ổ chứa dữ
liệu khai ở khoá `data_drive` của chính file đó.

## Ba tầng, không bao giờ trộn

| Tầng | Nội dung | Quy tắc |
|---|---|---|
| `raw/` | Đúng như lúc tải về | **Read-only tuyệt đối.** Script ghi vào đây là bug |
| `interim/` | Đã giải nén / đổi định dạng | Sinh lại được từ `raw/` bằng một lệnh |
| `processed/` | Sẵn sàng nạp DataLoader | Sinh lại được từ `interim/` bằng một lệnh |

Thư mục nào không sinh lại được bằng script thì nó đang nằm sai tầng.

`cache/` là LMDB/npy cache của DataLoader — xoá lúc nào cũng được.

## Lệnh sinh ra từng tầng

```bash
ml/scripts/00_fetch_raw.sh        # -> raw/
ml/scripts/01_prepare_interim.sh  # raw/ -> interim/ -> processed/
ml/scripts/02_make_splits.sh      # -> splits/
```

## manifest — mỗi dataset một file

Đây là thứ để lần sau lục lại được nguồn gốc dữ liệu:

```yaml
name: widerface
source_url: http://shuoyang1213.me/WIDERFACE/
downloaded: 2026-09-02
license: research-only
sha256:
  WIDER_train.zip: 3fedf70df8c1a2...
counts: { images: 32203, faces: 393703 }
notes: dùng annotation 5 landmark của RetinaFace, KHÔNG dùng label box gốc
consumed_by: [detection/teacher, detection/student]
```

Ảnh OV5640 tự thu dùng `manifest.csv` thay vì YAML, cột: `file, person_id, session,
lighting, distance_cm, is_spoof, spoof_type, capture_date`.

## splits/ — commit toàn bộ

Mỗi split kèm một `SPLIT.md` ghi quy tắc, seed, lệnh sinh, sha256 từng file và số lượng ID.

Recognition phải **identity-disjoint**: một người không được xuất hiện ở cả train và val.
Anti-spoof giữ nguyên chia train/valid/test của upstream — mirror CelebA-Spoof không mang
nhãn identity nên không tự kiểm được, và chia lại là phá luôn sự tách của giao thức gốc.

Số đo của từng tập và cách sinh ra chúng ghi ở `docs/DU_LIEU.md`.

`calib_*.txt` và `test_device.txt` phải không giao nhau — `ml/tests/test_splits.py` kiểm
tự động. Calibrate INT8 trên chính ảnh dùng để test thì con số nào cũng đẹp, và đó là loại
lỗi im lặng không tự lộ ra.
