# Dữ liệu — tải về, chuyển đổi, chia tập

Trạng thái dữ liệu của cả ba nhánh model, tính đến khi epic E3 đóng.

Mọi con số trong tài liệu này **đo trên đĩa**, không lấy từ trang chủ dataset và không
suy ra từ tài liệu của bên thứ ba. Nơi nào số đo lệch với con số thường được trích dẫn,
tài liệu ghi số đo và nói rõ vì sao lệch.

Kiến trúc và lý do chọn từng bộ dữ liệu nằm ở KẾ HOẠCH §1.2; đây là bản ghi lại **kết quả
thực thi**.

---

## 1. Tóm tắt

| Nhánh | raw | interim | split | Chạy train được chưa |
|---|---|---|---|---|
| Detection | WIDER FACE + nhãn RetinaFace | COCO json, 2 file | `detection/v1` | ✅ |
| Anti-spoof | CelebA-Spoof parquet + 4 bộ khác miền | 525.864 record, 2 tỉ lệ/record | `antispoof/v1_upstream` | ✅ |
| Recognition | MS1MV3 RecordIO + 6 benchmark `.bin` | 518 shard webdataset | `recognition/v1_identity_disjoint` | ✅ |
| Thiết bị (chung 3 nhánh) | — | — | `device/v1` trống | ❌ chưa có ảnh OV5640 |

Tổng dung lượng `raw/` **223 GB**, nằm trên ổ `E:`, vào repo bằng symlink (§2). Chỉ
`manifest.yaml`, `manifest.csv` và `splits/` là file thật trong git.

---

## 2. Nguồn thật — 10 dataset

Cột **Nguồn** là chỗ dữ liệu thật sự được lấy về. Bốn bộ anti-spoof kinh điển (OULU-NPU,
CASIA-MFSD, Replay-Attack, MSU-MFSD) **không dùng** vì phải gửi bản cam kết ký tay và chờ
nhiều tuần; bốn bộ khác miền ở dưới thay được *chức năng* của chúng nhưng không thay được
khả năng so số trực tiếp với bảng trong bài báo gốc (KẾ HOẠCH §1.2).

| Dataset | Nguồn | Trên đĩa | Vai trò |
|---|---|---|---|
| WIDER FACE | HF `wider_face` | 3.6 GB | ảnh train/val detect |
| Nhãn 5 landmark | Google Drive insightface, `retinaface_gt_v1.1.zip` | 18 MB | box + landmark cho detect |
| CelebA-Spoof | HF `Ar4ikov/celebA_spoof` — **parquet**, không phải layout gốc | 68 GB | train anti-spoof |
| NUAA Imposter | HF `akahana/anti-spoofing-nuaaaa` | 376 MB | eval khác miền — ảnh in |
| UniqueData live | HF `UniqueData/anti-spoofing_Real` | 542 MB | eval khác miền — live đối chứng |
| UniqueData replay | HF `UniqueData/anti-spoofing_replay` | 702 MB | eval khác miền — màn hình phát lại |
| AxonData masks | HF `AxonData/face-anti-spoofing-dataset` | 5.0 GB | eval khác miền — 9 kiểu tấn công |
| MS1MV3 | HF `gaunernst/ms1mv3-recordio` | 28 GB | train recognition — **mặc định** |
| Glint360K | HF `gaunernst/glint360k-wds-gz` | 122 GB / 1385 shard | dự phòng khi cần thêm ID |
| Benchmark nhận diện | HF `gaunernst/face-recognition-eval` | 424 MB | LFW · CFP-FP · AgeDB-30 · CFP-FF · CALFW · CPLFW |

Tổng **223 GB** trên `E:`. Glint360K đủ 1385 shard nhưng chưa dùng: MS1MV3 chạy được cả
pipeline với 27,4 GB nên để dành Glint360K tới lúc số ID thành giới hạn đo được.

AxonData mang 9 kiểu tấn công — latex, silicone, textile, mặt nạ giấy 3D, giấy 3D bọc,
cutout, replay màn hình, replay điện thoại — kèm `Selfies/` làm live đối chứng. **Mặt nạ 3D
là kiểu tấn công cả bốn bộ phải ký giấy đều không có**, nên bộ này bù đúng chỗ trống lớn
nhất. Chủ yếu là video: 149 file, chỉ 29 ảnh.

Nhãn landmark chỉ có trên Google Drive, không có mirror HTTP. `drive_id` khai trong
`manifest.yaml` chứ không gõ vào script (KẾ HOẠCH §4.9).

### Dữ liệu nặng nằm ngoài repo

`raw/`, `interim/`, `processed/`, `cache/` không nằm trên đĩa WSL — đĩa ext4 không nở thêm
được vì `C:` chỉ còn ~8 GB. Chúng nằm trên `E:` và vào repo bằng **symlink từng mục**, qua
một trong hai ổ khai ở `ml/configs/common/paths.yaml` (§4.9). Chọn ổ theo đúng một tiêu chí:
tập **vừa page cache** thì để `fast_drive` (ext4, được cache, nhanh hơn 152× khi cache nóng),
tập **không vừa** thì để `cold_drive` (drvfs, không bao giờ được cache nhưng băng thông tuần
tự gấp 6 lần) — KẾ HOẠCH §4.4.1.

`00_fetch_raw.sh` dựng lại toàn bộ symlink mỗi lần chạy, kể cả với `--verify`. Link phải
phủ **mọi mục có trên ổ**, không phải chỉ những mục `expects` gọi tên: `expects` là mẫu kiểm
tra, không phải bản kiểm kê. Thiếu link thì dữ liệu vẫn nằm nguyên trên ổ nhưng loader glob
theo đường dẫn repo sẽ không thấy — và nó không báo lỗi, nó chỉ train trên phần nhỏ hơn.

---

## 3. raw → interim

Ba bộ chuyển, mỗi bộ một lệnh, chạy lại được từ `raw/` mà không cần tải lại. Glint360K
không đi qua bước này: mirror của nó đã là webdataset.

### 3.1 Detection — `widerface_to_coco.py`

Ghép `label.txt` của RetinaFace với ảnh WIDER FACE thành COCO json có `keypoints`.

| Split | Ảnh | Mặt | Mặt đủ 5 landmark | File |
|---|---|---|---|---|
| train | 12.880 | 159.393 | **75.913** | `train.json` — 39 MB |
| val | 3.226 | 39.697 | **0** | `val.json` — 9.2 MB |

Không ảnh nào thiếu, không mặt nào bị loại vì quá nhỏ.

Năm điểm theo thứ tự `left_eye · right_eye · nose · left_mouth · right_mouth`. Mặt không có
landmark vẫn giữ đủ 15 số nhưng `visibility = 0` và `num_keypoints = 0`, nên loss landmark
bỏ qua được bằng chính trường đó, không cần danh sách riêng.

> **`val` không có landmark.** Đây là tính chất của bộ nhãn `retinaface_gt_v1.1`, đã đếm
> trên file: 39.697 mặt, 0 mặt có landmark. Mọi con số NMSE đo trên `val` gốc là đo với nhãn
> không tồn tại. Đây là lý do `landmark_val` phải cắt ra từ `train` (§4.1).

### 3.2 Anti-spoof — `celeba_spoof_parquet.py`

167 shard parquet, ba cột: `Filepath{bytes, path}`, `Bbox`, `Class`.

`Bbox` là **`[x1, y1, x2, y2]` pixel tuyệt đối**, không phải `[x, y, w, h]` và không chuẩn
hoá về `[0,1]`. Đọc sai quy ước này thì crop vẫn ra ảnh, vẫn train được, chỉ là cắt lệch —
hỏng im lặng. Quy ước được kiểm bằng cách đối chiếu box với kích thước ảnh trên nhiều dòng
mẫu, và bằng test `test_box_is_read_as_corners_not_width_height`.

Mỗi mặt cắt hai lần, cùng tâm, resize về **128×128**:

| Member | Tỉ lệ | Giữ lại cái gì |
|---|---|---|
| `tight.jpg` | 1,0× | mặt sát viền — kết cấu da, moiré của màn hình |
| `wide.jpg` | 2,7× | cả bối cảnh — mép giấy in, khung màn hình, bàn tay cầm ảnh |

MiniFASNet cần cả hai: cắt sát thì vứt mất chính tín hiệu phân biệt mặt thật với ảnh chụp mặt.

| Split | live | spoof | Tổng |
|---|---|---|---|
| train | 144.625 | 275.310 | 419.935 |
| valid | 16.164 | 30.574 | 46.738 |
| test | 16.473 | 42.718 | 59.191 |
| **Cộng** | 177.262 | 348.602 | **525.864** |

525.864 mặt, mỗi mặt **một record** mang cả hai tỉ lệ — không phải 1.051.728 file lẻ, vì ở
tốc độ mở file của ổ dữ liệu thì riêng việc mở đã tốn ~93 phút mỗi epoch (KẾ HOẠCH §4.4.1).
Tỉ lệ spoof/live ≈ 1,97 — bộ này lệch về phía tấn công, cần cân lại bằng sampler lúc train
chứ không sửa ở tầng dữ liệu.

Split lấy từ **tiền tố tên shard** (`train-`, `valid-`, `test-`), là cách duy nhất còn giữ
được chia của upstream: mirror đã bỏ nhãn identity.

### 3.3 Recognition — `recordio_to_wds.py`

MXNet RecordIO (`train.rec` 27,3 GiB + `train.idx`) → shard webdataset.

Định dạng container: magic `0xCED7230A`, `IRHeader` đóng gói `IfQQ`, độ dài bản ghi lấy
bằng mặt nạ `0x1FFFFFFF` trên trường `flag|length`.

| Đại lượng | Đo được |
|---|---|
| Bản ghi | **5.179.510** |
| Identity | **93.431** |
| Shard | 518 (`000000.tar` … `000517.tar`), 10.000 bản ghi/shard, shard cuối 9.510 |
| Dung lượng | 36 GB — lớn hơn `.rec` vì tar đệm mỗi member lên bội 512 byte |

> **Bẫy: bản ghi index nằm lẫn trong dòng dữ liệu.** Sau 5.179.510 ảnh, `train.rec` còn
> 93.432 bản ghi nữa: cùng khuôn header, **thân rỗng**, trường label mang khoảng bản ghi chứ
> không mang identity. Đọc tuần tự mà không bỏ qua thì sinh ra 93.432 file `.jpg` dài 0 byte
> và đếm ra 185.391 identity. Không có ngoại lệ nào được ném ra — pipeline vẫn chạy tới cuối.
> Bộ đọc bỏ qua bản ghi có thân rỗng; `test_index_records_without_an_image_are_skipped` chốt
> hành vi này.

93.431 identity khớp đúng con số MS1MV3 công bố, và là cách xác nhận bộ đọc không bỏ sót.

### 3.4 Bốn bộ khác miền

Tải xong, **để nguyên dạng nén**. Chúng chỉ dùng ở E6 (eval anti-spoof khác miền), giải nén
lúc đó; giải nén sớm là chiếm chỗ mà không dùng.

| Bộ | Dạng |
|---|---|
| NUAA | `nuaaaa.tar.gz` |
| UniqueData live | `data/data.tar.gz` |
| UniqueData replay | `data/videos.tar.gz` |
| AxonData | 9 thư mục video theo kiểu tấn công, kèm `Selfies/` live đối chứng |

---

## 4. interim → splits

Split là **danh sách tên**, không phải bản sao ảnh. Toàn bộ `ml/data/splits/` commit vào git:
mất chúng là mất khả năng tái lập mọi kết quả (KẾ HOẠCH §4.3).

Mỗi thư mục kèm `SPLIT.md` ghi quy tắc, seed, lệnh sinh, sha256 và số lượng. Chạy lại
`02_make_splits.sh` trên cùng dữ liệu ra **sha256 giống hệt**.

### 4.1 `detection/v1`

| File | Số ảnh | sha256 |
|---|---|---|
| `train.txt` | 11.618 | `4c1df707…` |
| `landmark_val.txt` | 1.262 | `906bd7ac…` |

11.618 + 1.262 = 12.880, đúng bằng số ảnh train của WIDER.

Quy tắc: trong 12.880 ảnh train, những ảnh **có ít nhất một mặt mang landmark** được rút ra
10% (seed 42) làm `landmark_val`; ảnh không có landmark ở lại `train` toàn bộ. Tập đo NMSE
vì thế không giao với tập train.

`val` gốc của WIDER dùng thẳng để đo box AP nên **không có file split cho nó** — sinh ra một
file liệt kê lại toàn bộ val là tạo thêm một chỗ có thể lệch.

### 4.2 `antispoof/v1_upstream`

| File | Số crop | sha256 |
|---|---|---|
| `train_ids.txt` | 419.935 | `804d13ab…` |
| `val_ids.txt` | 46.738 | `f750b3dc…` |
| `test_ids.txt` | 59.191 | `1846d9ff…` |

Giữ nguyên chia train/valid/test của upstream. Mirror không mang nhãn identity nên **không tự
kiểm identity-disjoint được**; chia lại theo seed là phá luôn sự tách của giao thức gốc mà
không có gì thay thế. Đây là ngoại lệ có chủ ý của KẾ HOẠCH §1.3, và báo cáo phải ghi đúng
như vậy chứ không được nói bộ này identity-disjoint.

### 4.2b `antispoof/v2_upstream_lcc_synth` — hai bộ trộn thêm từ 11/09

Phần CelebA-Spoof vẫn là `v1_upstream` ở trên, không đổi. Bản này chỉ liệt kê hai bộ được
gộp vào pool, chọn theo đúng luật của `xdomain_crop.py` nên ids và shard không lệch nhau.

| File | Số ảnh | Vai | sha256 |
|---|---|---|---|
| `lcc_train_ids.txt` | 8.299 | **train**, lặp 5 lần trong `train_split` | `4a74012f…` |
| `lcc_val_ids.txt` | 2.948 | để dành | `84c6edb5…` |
| `lcc_test_ids.txt` | 7.580 | test khác miền | `a0b91571…` |
| `synth_train_ids.txt` | 41.800 | **train** (10.000 mỗi kênh ngoài phần test; in chỉ còn 1.800) | `ec655fc6…` |
| `synth_test_ids.txt` | 10.000 | test khác miền, 2.000 trải đều mỗi kênh | `0a2ea310…` |

LCC-FASD giữ ba split của tác giả. SynthASpoof không có split gốc: test lấy 2.000 ảnh cách
đều trong từng kênh, train lấy phần còn lại, hai bên tách theo tên ảnh và `make_split` kiểm
tra giao rỗng. Sinh bằng `python -m facepipe.data.make_split --task antispoof --seed 42`
với `--source data/raw/antispoof/xdomain`.

### 4.3 `recognition/v1_identity_disjoint`

| File | Số identity | sha256 |
|---|---|---|
| `train_ids.txt` | 84.088 | `1bed7073…` |
| `val_ids.txt` | 9.343 | `190c3872…` |

84.088 + 9.343 = 93.431. Chia **theo `person_id`**, seed 42, tỉ lệ 90/10 — không chia theo
ảnh. Một người xuất hiện ở cả hai bên biến bài đo nhận diện thành bài đo trí nhớ và đẩy số
lên cao một cách vô nghĩa.

Danh sách ID đọc từ chính các shard (`interim/recognition/identities.txt`), không lấy từ
`property`, để số ID phản ánh dữ liệu thật sự có chứ không phải dữ liệu đáng lẽ có.

### 4.4 `device/v1`

Trống. Cần ≥2.000 ảnh chụp bằng chính OV5640 trên board (E3-T7). Khi có, `make_split` cắt
`calib_det` / `calib_spoof` / `calib_recog` mỗi tập 100 ảnh **chỉ lấy từ khung live**, phần
còn lại thành `test_device`.

Đây là mắt xích đang chặn nhiều thứ nhất — xem §6.

---

## 5. Cái gì được kiểm tự động

`ml/tests/` — 112 test, chạy bằng `uv run pytest`.

| File test | Chốt điều gì |
|---|---|
| `test_prepare.py` | Ba bộ chuyển trên input tổng hợp: quy ước box, bản ghi index rỗng, magic sai, keypoint |
| `test_splits.py` | Tập nào không được giao nhau thì thật sự không giao; cố tình trộn thì `check_disjoint` ném lỗi |

Hai loại lỗi được nhắm thẳng, vì cả hai đều **hỏng im lặng**:

1. **Calib giao với test.** Calibrate INT8 trên chính ảnh đem đo thì con số nào cũng đẹp.
2. **Train giao với val.** Ở recognition là rò identity, ở detection là rò ảnh landmark.

---

## 6. Còn thiếu

| Thiếu | Chặn cái gì |
|---|---|
| **Ảnh OV5640 tự thu** (E3-T7, E3-T8) | E4-T6 NMSE · toàn bộ calib PTQ của cả ba nhánh · `test_device` |
| Giải nén 4 bộ khác miền | E6 eval anti-spoof khác miền |
| `processed/` | Chưa sinh; tạo lúc train từ `interim/` |

Đã tải đủ nhưng chưa dùng, không tính là thiếu: Glint360K 1385 shard (MS1MV3 là mặc định)
và 8 kiểu tấn công còn lại của AxonData (chỉ cần ở E6).

Ảnh tự thu là mắt xích quan trọng nhất còn thiếu, và nó cần board thật. Không có nó thì
INT8 phải calibrate bằng ảnh dataset — khác phân bố cảm biến, và mọi con số accuracy INT8
đều mất ý nghĩa với thiết bị sẽ chạy thật.

---

## 7. Lệnh tái lập

```bash
cd ml
./scripts/00_fetch_raw.sh          # raw/      — cần HF_TOKEN trong ml/.env
./scripts/01_prepare_interim.sh    # interim/  — chạy vài giờ, dừng giữa chừng chạy lại được
./scripts/02_make_splits.sh        # splits/   — vài phút
```

Cả ba script bỏ qua phần đã xong, nên chạy lại không mất công. `01` thêm `--force` thì xoá
sạch đầu ra rồi làm lại; xoá là bắt buộc vì lần chạy sau có thể sinh ít shard hơn lần trước,
và shard thừa còn sót lại sẽ bị loader đọc như dữ liệu thật.

Kiểm mà không tải — cũng là cách dựng lại symlink sau khi clone:

```bash
./scripts/00_fetch_raw.sh --verify
```
