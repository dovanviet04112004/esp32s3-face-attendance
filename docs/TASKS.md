# TASKS.md

Backlog toàn dự án `esp32s3-face-attendance`. Kiến trúc ở `docs/KE_HOACH_face_attendance_esp32s3.md` (**KẾ HOẠCH**), quy tắc ở `CLAUDE.md`.

Mã task: `E<epic>-T<số>`.
🔬 = task sinh ra số đo, kết quả ghi vào `docs/measurements/`.

Phần cứng đã xác minh thông số, không còn là việc chặn.

---

## Đường đi

```
E1 nền repo ──► E2 ml/core ──► E3 dữ liệu
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
               E4 detection   E5 recognition  E6 anti-spoof
                    └──────────────┬──────────────┘
                                   ▼
                          E7 firmware nền  ──► E8 NẠP + ĐO TRÊN BOARD 🔬
                                                       │
                                          đạt? ──Không──► E9 vòng tối ưu ──┐
                                                       │                    │
                                                       ▼◄───────────────────┘
                                              E10 UI + chấm công
                                                       │
                                   E11 backend ──► E12 frontend
                                                       │
                                              E13 bảo mật + OTA ──► E14 báo cáo
```

**Nguyên tắc**: chạy được trước, tối ưu sau. E8 là điểm đầu tiên biết sự thật — arena thật, latency thật, accuracy trên ảnh OV5640 thật. Trước đó mọi con số chỉ là ước lượng.

**E7 làm song song với E4–E6.** Driver, LCD, ToF, audio không phụ thuộc model — dựng sẵn để khi model xong là nạp được ngay.
**E11 độc lập hoàn toàn với firmware**, chen vào lúc nào cũng được.

---

## E1 — Nền repo

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| E1-T1 | Dựng cây thư mục theo §4, thêm `.gitignore` `.gitattributes` `.editorconfig` `LICENSE` `README.md` `Makefile` | `tree -L 2` khớp §4.1 | — |
| E1-T2 | Viết 6 file JSON Schema trong `contracts/schema/` + `mqtt_topics.yaml` | Schema validate được bằng `ajv` | E1-T1 |
| E1-T3 | `tools/gen_from_schema.sh` sinh TS cho backend/frontend và `gen_payload.h` cho firmware | Chạy 2 lần cho ra file giống hệt | E1-T2 |
| E1-T4 | Đưa `tools/check_comments.py` và `tools/check_layers.py` vào repo | Chạy sạch trên repo rỗng | E1-T1 |
| E1-T5 | `.pre-commit-config.yaml`: check_comments · ruff · clang-format · prettier | `pre-commit run --all-files` sạch | E1-T4 |
| E1-T6 | 5 workflow trong `.github/workflows/` | Push lên là CI chạy, `contracts.yml` fail khi code sinh ra lệch | E1-T3, E1-T5 |
| E1-T7 | `docs/adr/0001` ghi quyết định chọn YuNet thay ULFG | File tồn tại | E1-T1 |
| E1-T8 | **Sketch thu ảnh OV5640** — firmware tối giản, chỉ camera + lưu ảnh ra serial/SD | Chụp được ảnh JPEG từ board | E1-T1 |

> E1-T8 là code vứt đi, không nằm trong `firmware/`. Mục đích duy nhất: mở khoá việc thu dữ liệu ở E3 mà không phải đợi toàn bộ firmware.

---

## E2 — `ml/core` hạ tầng train

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| E2-T1 | `pyproject.toml` + `uv.lock` + `Dockerfile` môi trường train | `uv sync` dựng lại được từ máy trắng | E1-T1 |
| E2-T2 | `core/config.py` — pydantic schema, merge YAML, override CLI, `load_run_config` đọc lại config đóng băng | Nạp `configs/detection/yunet.yaml` không lỗi; mở được run có mục schema đã bỏ | E2-T1 |
| E2-T3 | `core/registry.py` — gọi model/loss/dataset bằng tên | `@register("dummy")` rồi gọi được từ YAML | E2-T2 |
| E2-T4 | `core/trainer.py` — AMP, EMA, grad-clip, checkpoint, resume | Train 2 epoch model giả, ngắt giữa chừng, resume đúng bước | E2-T3 |
| E2-T6 | `core/run_dir.py` — sinh thư mục run kèm `config.resolved.yaml`, `env.txt`, `split.lock` | Mỗi lần chạy ra một thư mục đủ 3 file | E2-T4 |
| E2-T7 | `core/seed.py` + `core/logger.py` | Hai lần chạy cùng seed cho cùng loss | E2-T4 |
| E2-T8 | **Độ phân giải đầu vào là tham số config, không hardcode** | Đổi `input_hw` trong YAML là đổi được cả train lẫn export | E2-T2 |
| E2-T9 | Test: `core/` không import gì từ `tasks/` | Script kiểm CI, fail khi vi phạm | E2-T4 |

> E2-T8 là bảo hiểm rẻ nhất cho quyết định "tối ưu sau": nếu E8 đo ra arena không vừa, đổi độ phân giải và train lại chỉ là sửa YAML rồi chạy lại script, không phải viết lại code.

---

## E3 — Dữ liệu

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| E3-T1 | `scripts/00_fetch_raw.sh` + `manifest.yaml` cho từng dataset | 8 manifest có url, sha256, ngày tải, license | E2-T1 |
| E3-T2 | `data/prepare/widerface_to_coco.py` — box + 5 landmark → COCO json | `interim/detection/widerface_coco/` có 32.203 ảnh | E3-T1 |
| E3-T3 | `data/prepare/celeba_spoof_parquet.py` + `depth_gt.py` | Shard crop 128×128 hai tỉ lệ + depth map GT cho ảnh live | E3-T1 |
| E3-T4 | `data/prepare/glint360k_to_wds.py` | Webdataset shard đọc được | E3-T1 |
| E3-T5 | `data/make_split.py` + sinh split cho 3 nhánh, kèm `SPLIT.md` | Split commit vào git, có seed và sha256 | E3-T2..T4 |
| E3-T6 | `tests/test_splits.py` — kiểm identity-disjoint và calib ∩ test = ∅ | Test đỏ khi cố tình trộn | E3-T5 |
| E3-T7 | Thu ≥2.000 ảnh OV5640 tự thu, đủ điều kiện sáng và khoảng cách | `manifest.csv` đầy đủ cột | E1-T8 |
| E3-T8 | Thu tập spoof tự thu: in ảnh, màn hình điện thoại, màn hình laptop, mặt nạ giấy | ≥500 ảnh mỗi loại | E3-T7 |
| E3-T9 | `data/transforms/sensor_sim.py` — mô phỏng nhiễu OV5640 | Ảnh sau augment giống ảnh thật khi so histogram | E3-T7 |
| **E3-T11** | **Gỡ chỗ CPU và GPU phải chờ nhau trong vòng train.** Đo trên nhánh detect: một luồng Python ghim 100% một nhân, GPU chỉ 66–71%. Hai cơ chế ngược nhau, ba chỗ: **(a)** `float(value.detach())` cho từng thành phần loss trong vòng train, **~5 lần đồng bộ mỗi bước**, nặng nhất; **(b)** `trainer.py` — `if not torch.isfinite(loss)` ép đọc bool từ GPU mỗi bước; **(c)** chi phí phóng lệnh từng lớp, gỡ bằng `torch.compile`. Sửa (b) mà bỏ (a) thì **không được gì** | (a)+(b): giữ loss dạng tensor, cộng dồn trên GPU, chỉ đổi sang `float` ở nhịp `log_every_steps`; cờ non-finite gom trên GPU rồi kiểm cùng nhịp đó. (c): khoá `train.compile` trong config, **không hardcode**. Đo it/s trước/sau. Bẫy phải tránh: `torch.compile` bọc model nên `state_dict()` mọc tiền tố `_orig_mod.` — checkpoint phải lấy từ module gốc, nếu không sẽ hỏng im lặng lúc export | E2-T4 |
| **E3-T12** | `channels_last` cho model tích chập chạy AMP — một dòng, thường 10–30% trên tensor core 🔬 chưa đo trên máy này | Đo it/s trước/sau; cùng ràng buộc §3.7 như `train.compile` nếu nó đổi kết quả | E3-T11 |
| **E3-T14** | **Chọn batch bằng bộ nhớ ở trạng thái ổn định, không bằng vài vòng đầu.** Đo được 2,36 GB ở vòng đầu nên chốt batch 4; thực tế ổn định là **3,41 GiB trên card 4,0 GiB** — chỉ còn 0,6 GiB dư địa, và bộ nhớ reserved còn bò lên 5,95 GiB sau ~30 epoch rồi tràn sang RAM host, chậm **50×**. Đo lại sau **≥3 epoch**, chừa **≥25% dư địa**. Kiểm luôn cảnh báo `max_det` Ultralytics tự nâng (300 → 1968 với WIDER): nó quyết định bộ nhớ mỗi lần validation | Config của mỗi nhánh ghi rõ VRAM ổn định đo ở epoch mấy, không phải ở vòng đầu | — |
| **E3-T13** | **Đặt `PYTORCH_CUDA_ALLOC_CONF=garbage_collection_threshold:0.8,max_split_size_mb:256` cho mọi run trên card 4 GB.** Đo được: sau ~24 epoch, bộ nhớ reserved bò tới 4,16 GiB trên card 4,0 GiB — WSL **không ném lỗi**, nó âm thầm đẩy sang RAM host và chậm **20×** (0,33 → 6,6 s/vòng). Ultralytics đã tự gọi `_clear_memory(0.5)` cuối mỗi epoch nên đó không phải chỗ thiếu; bộ nhớ phình **trong lòng epoch** vì ảnh WIDER có từ 1 tới 1.968 mặt. Hai tham số này tác động liên tục trong epoch | Chạy hết 100 epoch không tụt xuống dưới 3,0 it/s. ⚠️ **KHÔNG dùng `expandable_segments:True`** — đã thử, giảm reserved 1,5 GB thật nhưng **sập sau 10 phút** với `!handles_.at(i) INTERNAL ASSERT FAILED` ở `CUDACachingAllocator.cpp:467`: nó cần API bộ nhớ ảo của driver mà WSL đi qua GPU-PV không hỗ trợ đủ | — |
| **E3-T10** | **Tầng `fast_drive`** (KẾ HOẠCH §4.4.1): ảnh ext4 loop trên `E:`, khai `/etc/fstab`; chuyển sang **chỉ tập nào vừa page cache** — ảnh WIDER + bố cục Ultralytics, nối bằng **hardlink** thay symlink. Shard anti-spoof và recognition ở lại `cold_drive` | `/data` còn mount sau `wsl --shutdown`; đo được ảnh/giây **cả cache lạnh lẫn nóng** trên cùng một tập, và MB/s tuần tự trên cả hai ổ | E3-T1 |

---

## E4 — Nhánh detection

Làm trước trong ba nhánh. Nó là cổng của pipeline, và **landmark của nó quyết định cách align ảnh đưa vào recognition** — có detector thật rồi mới train recognition thì tránh được sai lệch train/serve ở khâu align.

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| E4-T3 | `student/{yunet, head, anchors, blocks}.py` | Param ≈ 75,8K, ra 3 nhánh đầu ra | E2-T3 |
| E4-T4 | `losses/task_loss.py` — focal + IoU + landmark L1 | Unit test từng thành phần | E4-T3 |
| E4-T5 | `train.py` — task loss trên nhãn thật | AP ≥ 0,90 trên mặt ≥ 32 px ở FP32 (§3 lớp 2) | E4-T3, E4-T4, E3-T5 |
| E4-T6 | `eval.py` — WIDER AP + **NMSE landmark trên ảnh OV5640** | NMSE < 5% | E4-T5, E3-T7 |
| E4-T8 | **Thang lượng tử hoá (§3.7)** — Q0 rồi Q1 | `docs/measurements/<nhánh>/{quant_ladder,calib_sweep}.md` | E4-T6 |
| E4-T10 | `postproc/{decode, nms}.py` + `emit_golden.py` | `contracts/golden/detection/` có vector vàng | E4-T8 |
| E4-T11 | Export tflite + `tflite_op_check.py` + `meta.json` + lock | AP trên mặt ≥ 32 px sụt < 1% so với FP32, hai file khớp sha256 | E4-T8 |
| E4-T12 | Nếu NMSE > 5%: đổi sang RetinaFace-MobileNet0.25 | Đạt ngưỡng, ghi ADR mới | E4-T6 |

---

## E5 — Nhánh recognition

Ảnh `test_device` dùng crop align bằng **detector thật từ E4**, không phải landmark thủ công — align lúc train khác align lúc chạy là loại lỗi rất khó truy.

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| ~~E5-T0~~ | ~~`recordio_to_wds.py`: bỏ member `.cls`~~ — **bỏ**. Shard đã nằm trên `fast_drive`, đọc nghẽn ở giải nén JPEG chứ không ở tar; sinh lại 36 GB để tiết kiệm 5,3 GB đọc tuần tự không đổi lại được gì | — | — |
| E5-T2 | `student/mobilefacenet.py` + `blocks.py` (ReLU, kênh bội 8) | Forward ra 512-D, param **1,20M** đo được (0,99M của bài báo là bản embedding 128-D) | E2-T3 |
| E5-T3 | `losses/{arcface, kd_embedding, kd_relation_rkd}.py` | Unit test từng loss | E5-T2 |
| E5-T4 | `train.py` + `data.py` — ArcFace trên nhãn thật | LFW ≥ 99,0 ở FP32 | E5-T2, E5-T3, E3-T5, **E3-T10** |
| E5-T5 | `postproc/{align, l2norm, cosine}.py` | Align được bằng landmark thật từ detector E4 | E5-T4, E4-T11 |
| E5-T6 | `eval.py` — LFW/CFP-FP/AgeDB + TAR@FAR trên `test_device` đã align bằng E4 | Bảng số vào `artifacts/recognition/reports/` | E5-T5 |
| E5-T8 | **Thang lượng tử hoá (§3.7)** — Q0 rồi Q1 | `docs/measurements/<nhánh>/{quant_ladder,calib_sweep}.md` | E5-T6 |
| E5-T10 | `emit_golden.py` | `contracts/golden/recognition/` có vector vàng | E5-T8 |
| E5-T11 | Export tflite + op check + `meta.json` + lock | LFW ≥ 99,0 ở INT8, hai file khớp sha256 | E5-T8 |

---

## E6 — Nhánh anti-spoof

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| **E6-T0** | **`celeba_spoof_parquet.py` ghi thẳng ra shard** — **hai tỉ lệ 1x và 2.7x cùng một record** (KẾ HOẠCH §4.4.1), không đi qua bước 1,05 triệu file lẻ; giải nén chạy song song nhiều nhân | Shard đọc lại đủ `tight.jpg` + `wide.jpg` + `json`, **đo được record/giây so với file lẻ** | E3-T3, E3-T10 |
| E6-T4 | `model/minifasnet_v2_se.py` — **hai backbone**, SE dùng HardSigmoid, `AvgPool2d` cỡ cố định, đầu vào 81 | Param ≈ 0,53M ở `width=32`; forward nhận cặp (tight, wide) | E2-T3 |
| E6-T5 | `losses/task_loss.py` — BCE hai lớp trên cặp crop | Unit test từng thành phần | E6-T4 |
| E6-T6 | `train.py` | ACER < 5% ở FP32 | E6-T4, E6-T5, **E6-T0** |
| E6-T7 | `eval.py` — ACER, HTER cross-dataset, ROC tập tự thu | HTER < 15% | E6-T6, E3-T8 |
| E6-T9 | **Thang lượng tử hoá (§3.7)** — Q0 rồi Q1 | INT8 giữ ACER < 5%, `quant_ladder.md` + `calib_sweep.md` | E6-T7 |
| E6-T10 | Export + `postproc/preproc.py` + golden + `meta.json` + lock | Hai file khớp sha256 | E6-T9 |

---

## E7 — Firmware nền

Chạy song song với E4–E6. Không phụ thuộc model.

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| E7-T1 | Đấu cả hai cơ cấu chấp hành theo §2.3F: module 4 relay opto (tiếp điểm để hở) và servo SG90 | Rút jumper JD-VCC, P2 ở HIGH thấy relay tắt hẳn, P2 ở LOW nghe cạch và đo thông mạch COM–NO, servo quét đủ tầm | — |
| E7-T2 | `bsp_board` (kèm `include/app_config.h`) + `partitions.{dev,prod}.csv` | Board boot, PSRAM 8MB nhận đủ | — |
| E7-T2b | **3 profile build** `sdkconfig.{dev,bench,prod}` theo §4.5.9, kèm flash QIO 80 MHz | 3 lệnh build ở §4.5.9 đều chạy, `bench` dùng `-O2` | E7-T2 |
| E7-T3 | `common/` — RAII guard: `FrameGuard` `LockGuard` `Queue<T,N>` | Unit test từng guard | E7-T2 |
| E7-T4 | `drv_ioexp` (PCF8574) + `drv_camera` (OV5640) | Chụp được ảnh QVGA vào PSRAM | E7-T2 |
| E7-T5 | `drv_lcd` (ST7796 + bounce buffer) + LVGL port | Hiện được ảnh tĩnh 320×480 | E7-T2 |
| E7-T6 | `drv_touch` (GT911, trình tự chọn địa chỉ) — **init đã chạy 09/09**: `gt911 at 0x5D, 320x480` sau khi nâng `APP_TOUCH_RST_HOLD_MS` 10 → 100 ms. **`drv_touch_read` còn trượt**, xem E7-T14 | Đọc được điểm chạm | E7-T4 |
| **E7-T14** | **Con ở `0x5D` ACK địa chỉ nhưng không phục vụ thanh ghi — nghi flex cảm ứng chưa cắm.** Product ID đọc ra rác và **không ổn định giữa hai lần chạy** (`0x08427E` rồi `0x08427F`), lại **khác giữa hai đường đọc** ở cùng thanh ghi (component GT911 ra `0x08427E`, `drv_touch` ra `0x18607E`); GT911 thật phải trả `"911"`. `drv_touch_init` giờ chặn ở đó với thông báo rõ thay vì đi tiếp trên dữ liệu rác. Đã loại: chờ 300 ms sau init, `INT_HOLD` 50 vs 100 ms, khoá bus | Kiểm cáp flex cảm ứng trên module LCD; nếu là bộ điều khiển khác thì đổi component theo §4.5.1 | E7-T6 |
| E7-T7 | `drv_tof` (VL53L1X ULD) — **hai tiêu chí đã đạt 09/09**: sensor lên ở `0x29` với model id `0xEACC`, short mode 33 ms mỗi 100 ms, ngắt GPIO3 giương 16/20 lần. Còn nợ một lần đo có vật thật trước sensor (đang trả `65535` = không mục tiêu) | Đọc khoảng cách, ngắt GPIO3 hoạt động | E7-T4 |
| **E7-T13** | **`drv_ioexp` NACK ở lần ghi đầu, chưa rõ nguyên nhân.** Fail 3 lần liền rồi pass 4/4 sau khi có một lần ghi 0xFF thành công. Đã loại: tốc độ bus (400 và 100 kHz như nhau), phần cứng (probe/write/read đều OK từ app khác), sdkconfig (giống hệt), giao dịch đầu sau khi tạo bus (cold write OK), và dây (chủ repo xác nhận không đụng). Quy luật còn lại chưa chứng minh: mọi lần fail là lần ghi đầu **kể từ khi cắm điện**, mà PCF8574 không có chân reset nên latch sống qua reset chip | Rút điện cắm lại rồi chạy `expander` đầu tiên: tái hiện được thì đo mức SDA/SCL trước init và chốt fix có bằng chứng; không tái hiện thì ghi lại là quan sát mở, **không thêm workaround** | — |
| E7-T8 | `drv_audio` (I2S + MAX98357A) | Phát WAV từ SPIFFS, không xì | E7-T2 |
| E7-T9 | `drv_relay` **và** `drv_servo` + `svc_door` (IDoor + `RelayDoor` + `ServoDoor` + `FakeDoor`) | Đổi `Kconfig` là đổi được cơ cấu, `FakeDoor` chạy test trên host | E7-T1, E7-T3 |
| E7-T10 | `sys_storage` — NVS, LittleFS, mmap model, `storage_format.h` + `static_assert` | Ghi/đọc `faces.bin` sống sót khi rút điện giữa chừng | E7-T2 |
| E7-T11 | Preview camera → LCD chạy liên tục | ≥ 12 fps, LVGL không giật | E7-T4, E7-T5 |
| E7-T11b | Lượng tử hoá thời gian phơi theo bội số 10 ms, gain bù phần lẻ | Dưới đèn huỳnh quang 50 Hz không còn sọc trôi; thanh ghi lọc vằn đã cài nhưng chỉ ràng buộc AEC của sensor, mà AEC đang tắt | E7-T11 |
| E7-T12 | `tools/check_layers.py` chạy sạch trên firmware thật | CI xanh | E7-T10 |

---

## E8 — Nạp và đo trên board 🔬

Đây là lần đầu tiên biết sự thật. Mọi số trước đó chỉ là ước lượng trên giấy.

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| E8-T1 | `ai_engine/src/core/` — `TfliteModelBase`, `ArenaAllocator`, `model_store` mmap | Nạp được 1 model từ partition | E7-T10 |
| E8-T2 | `export/{pack_models_partition,update_lock}.py` + `scripts/50_pack_and_flash.sh` — gộp tflite → `models.bin` → ghi `models_0` | Verify sha256 khớp `models.lock.json`, board đọc được header | E8-T1, E4-T11, E5-T11, E6-T10 |
| E8-T3 | `src/recognition/` — model + ops + align + l2norm | MobileFaceNet INT8 chạy trên board | E8-T2 |
| E8-T4 | `src/detection/` — model + ops + decode + nms | YuNet INT8 chạy trên board | E8-T2 |
| E8-T5 | `src/antispoof/` — model + ops + preproc | MiniFASNet INT8 chạy trên board | E8-T2 |
| E8-T6 | `test_apps/parity` — so với `contracts/golden/` cả 3 nhánh | Sai số < 1e-3 trên mọi vector vàng | E8-T3..T5 |
| E8-T7 | 🔬 **Đo `tail` và `head` riêng từng model** (§3.8), không chỉ tổng `arena_used_bytes()` | 6 con số vào `docs/measurements/arena.md` | E8-T3..T5 |
| E8-T7b | Dựng 2 arena: `arena_fast` (detect+spoof chung 1 `MicroAllocator`, SRAM) và `arena_big` (recog, PSRAM) | Cả 3 model chạy được, `arena_fast` vừa SRAM nội | E8-T7 |
| E8-T8 | 🔬 **Đo latency từng model và từng op** — `MicroProfiler`, **build bằng profile `bench`** (`-O2`, không assert) | Bảng vào `docs/measurements/latency.md`, chỉ rõ op nào không có kernel ESP-NN | E8-T7, E7-T2b |
| E8-T9 | 🔬 **Đo RAM đỉnh toàn hệ** — `heap_caps_get_minimum_free_size` cả internal và PSRAM | Số vào `docs/measurements/`, đối chiếu §6.4 | E8-T7 |
| E8-T10 | `svc_vision` — pipeline 5 nhánh thoát sớm | Chạy đủ chuỗi trên ảnh thật từ camera | E8-T6 |
| E8-T11 | `svc_facedb` — bảng embedding int8 trong PSRAM + cosine search | Tra 500 người < 20 ms | E8-T3, E7-T10 |
| E8-T12 | 🔬 **Đo accuracy đầu-cuối trên ảnh OV5640 thật** | FAR/FRR trên tập `test_device` | E8-T10, E8-T11 |

> **Kết thúc E8 là chốt chặn ra quyết định**: nếu arena vừa, latency chấp nhận được và accuracy đạt → bỏ qua E9, đi thẳng E10. Nếu không → vào E9.

---

## E9 — Vòng tối ưu, chỉ chạy khi E8 không đạt

Vào epic này **chỉ khi** E8 chỉ ra vấn đề cụ thể. Không tối ưu vu vơ.

| Triệu chứng đo được ở E8 | Task | Chi phí |
|---|---|---|
| `arena_fast` vượt SRAM nội | E9-T1 — tách anti-spoof ra `arena_big`, chỉ để detect ở SRAM | Sửa 1 dòng cấp phát |
| Vẫn không vừa | E9-T2 — hạ `input_hw` trong YAML, train lại nhánh đó | Chỉ đổi config nhờ E2-T8 |
| Latency quá cao | E9-T3 — đọc `latency.md`, tìm op không có kernel ESP-NN, thay op ở tầng kiến trúc rồi train lại | Sửa `model/blocks.py` |
| Latency vẫn cao | E9-T4 — siết ngưỡng thoát sớm, giảm tần suất chạy recognition | Sửa `svc_vision` |
| Accuracy INT8 tụt | E9-T5 — sensitivity analysis → mixed-precision giữ float layer đầu và cuối | `compress/sensitivity/` |
| Accuracy vẫn tụt | E9-T6 — thu nhỏ hoặc đổi kiến trúc; §3.7 không có mốc lượng tử hoá nào đắt hơn Q1 | Train lại nhánh đó |
| Landmark lệch | E9-T7 — đổi student detection sang RetinaFace-MobileNet0.25 | Train lại nhánh detection |
| Sai số parity C ↔ Python | E9-T8 — sửa bản C cho khớp bản Python, không sửa ngược | `ai_engine/src/<nhánh>/` |

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| E9-T9 | Cập nhật KẾ HOẠCH §3 và §6 theo số đo thật | Kế hoạch khớp thực tế, không còn 🔬 nào chưa có số | E8-T12 |
| ~~E9-T10~~ | ~~**Train lại recognition trên kiến trúc mới**~~ — **XONG**: run `20260908-1750` (ReLU 113, `width=32`, 10 epoch) đã export Q1 720,3 KB và vào lock. Không đạt mốc bản `PReLU` 112 trên `cfp_fp_tar@far0.001` (0,6403 so với 0,7874); bản `width=64` `20260907-2314` đạt 0,7566 và giữ làm đối chứng | ✅ | E9-T3 |
| **E9-T11** | **Train lại anti-spoof trên kiến trúc mới** — `ReLU`, `AvgPool2d` cỡ cố định, đầu vào 81. Run `20260909-1116` mới tới epoch 2/60. Nhánh này **đã rút khỏi lock**, ảnh `models_0` chỉ còn 2 nhánh cho tới khi có bản train xong | ACER < 5% ở INT8, chấm lại trên tập tự thu E3-T8, export, vào lock | E9-T3, E3-T8 |
| ~~E9-T12~~ | ~~Thêm tham số `width` cho `MiniFASNetBackbone`~~ — **nửa đầu XONG**: `minifasnet_v2_se.py:46` đã có `width`. Còn thiếu phép đo | Đo arena + latency ở `bench_ai` với ít nhất 2 hệ số | — |

### Ngân sách pixel camera → 3 model — nợ nhất quán

Soát chuỗi `camera → detect → crop spoof/recog` bằng 4 agent đọc song song, mỗi khẳng
định số học qua một agent phản biện: **34 đứng vững, 17 bị bác, 3 chưa phán quyết**.
Những dòng dưới là phần đứng vững. Sửa `KẾ HOẠCH` thì theo `CLAUDE.md` §1.2 — nêu, chờ
duyệt, rồi mới sửa.

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| **E9-T13** | **Cỡ khung camera nuôi nhánh AI — plan nói hai số, firmware ship một số.** Firmware cấu hình đúng một chế độ: `FRAMESIZE_HVGA` = 480×320, `ASPECT_RATIO_3X2` (`drv_camera.c:133`, `sensor.c:35`, `app_config.h:26-27`), không đổi được lúc chạy. Plan §3 (`:535`, `:596`) và §6.3 (`:2643-2644`) tính trên 640×480 | Một cỡ khung duy nhất trong plan, và §6.3 mô tả đúng buffer đang cấp | — |
| **E9-T14** | **"detect chạy đúng một phần tư" sai ở khung thật.** 480/160 = 3 và 320/120 = 2,67, mà 3:2 ≠ 4:3 — phải chọn letterbox (mặt nhỏ hơn tính toán) hay cắt bề rộng (mất góc nhìn). Chưa có dòng code nào làm bước này, nên quyết định còn mở | Plan ghi đúng hệ số và cách dựng; `svc_vision` cài đúng cách đã chọn | E9-T13 |
| **E9-T15** | **Quy đổi "32 px ở detect = 128 px trong khung camera" tính trên khung firmware không tạo ra.** Sàn 32 px và số 0,9313 vẫn hợp lệ (`eval.py:21`, `measurements/detection/measurements.md:37`); chỉ phần quy đổi sai. Ở 480×320 letterbox là 0,3333 → **96 px**, dưới 112 mà recog cần. Ba chỗ ghi câu sai: `plan:536`, `measurements/detection/measurements.md:39-40`, `eval.py:19-21` | Ba chỗ khớp khung thật, cổng vận hành nêu bằng px của khung đang thu | E9-T13 |
| **E9-T16** | **Con 122 px "mặt ở cự ly kiosk" vô nguồn.** `plan:188`, `README:16`, `README:51` dùng nó để biện minh chọn HVGA, nhưng không có trong `docs/measurements/`, không mang 🔬. Đây là căn cứ duy nhất cho cỡ khung | Đo trên board ở 0,5 / 0,9 / 1,5 m, số vào `docs/measurements/`, plan trích lại | E7-T4 |
| ~~E9-T17~~ | **XONG** — `sys_storage_model_find()` trả `arena_hint`, `ai_engine` cấp `max` theo nhóm rồi làm tròn lên KB, Kconfig thành trần. Lock và hai `meta.json` mang `189628` / `476188`. Lãi **1.108 KB PSRAM**, latency không đổi (`arena.md` §7) | ✅ | E8-T7 |
| ~~E9-T17 (bản cũ)~~ | ~~**`arena_hint` còn 0 dù đã có số đo.**~~ detect đo thật **189.628 B** (`arena.md:26`, `Kconfig:8-9`), mà cả 6 ô hợp đồng vẫn 0: `contracts/models.lock.json:6,:12`, bản mirror `firmware/models/models.lock.json:6,:12`, hai `meta.json:4`. Theo `plan:996` thì 0 nghĩa "chưa đo", tức hợp đồng khai sai. Cơ chế: `update_lock.py:47` mặc định `--arena-bytes 0` và lần chạy cuối không truyền | Sáu ô mang số đo; `ai_engine` đọc `arena_hint` thay vì chỉ Kconfig (§3.8) | E8-T7 |
| **E9-T18** | **Chưa có một số accuracy nào ở 81×81.** 18 run anti-spoof, chỉ `20260909-1116` là `[81,81]` và mới epoch 2/60. Mọi số ở `quant_ladder.md:12-14` và `antispoof/measurements.md:118,:143,:991,:1018` đều từ checkpoint `[80,80]` | Có bảng accuracy ở 81×81; mọi bảng cũ ghi rõ đo ở 80×80 | E9-T11 |
| **E9-T19** | **Số đo gắn sai kích thước đầu vào.** `plan:2649` ghi "Arena recognition 904 KB đo thật @113×113", nhưng `arena.md:12` không nêu cỡ nào và git cho thấy phép đo lấy lúc `meta.json` còn 112 | `plan:2649` bỏ chú thích sai; `arena.md` nêu rõ cỡ của từng số | — |
| **E9-T20** | **`ml/configs/recognition/mobilefacenet.yaml:18` còn `width: 64`** trong khi model đã vào lock là `width=32` — chạy lại config mặc định là train ra kiến trúc khác bản đang deploy | Config mặc định khớp bản trong lock | — |
| **E9-T21** | **`preproc.cpp` khai ở `plan:2008`, `:2017`, `:643` nhưng không có trong cây** `ai_engine/src/antispoof/` | File tồn tại, hoặc plan thôi khai nó | E8-T5 |
| **E9-T22** | **Hai chỗ nói ngược nhau về phần cứng.** `plan:194` khai gain **cố định**, driver lại lái gain bằng vòng kín; `plan:247` bắt SPI CLK **80 MHz** cho LCD | Mỗi tham số một nguồn, khớp code | — |
| **E9-T23** | **`plan:636` "bốn khung còn dưới ngưỡng đều là mặt chiếm trên 87% cạnh ngắn khung hình"** sai với mọi tập con 4 khung của chính bộ số nó viện dẫn | Câu khớp số ở `antispoof/measurements.md` §12.5 | — |
| **E9-T24** | **Đo lại cạnh mặt bằng thước.** Hệ số `side ≈ 47,7/d` (`detection/measurements.md` §8) dựng từ hai khung mà khoảng cách ước bằng mắt, sai số ±15% → dải recog nằm đâu đó trong 0,36–0,48 m | ≥4 cự ly đo bằng thước, hệ số có sai số < 5%, KẾ HOẠCH §2.1 và §3 lớp 2 trích số chốt | E7-T4 |
| **E9-T25** | **`drv_camera_expose()` không được gọi trong app thu ảnh** — nó là lệnh riêng ngoài `grab()`, nên ảnh thu ra dùng phơi sáng khởi động. Đo được: conf 0,317 → 0,424 ở cùng cự ly khi cho vòng kín hội tụ | Mọi đường thu ảnh gọi `expose()` cho tới khi `level` ổn định; E3-T7 và E3-T8 thu bằng đường đó | E7-T4 |
| **E9-T26** | **Cổng vận hành đổi 32 → 38 px** ở đầu vào detect (113 px trong khung camera). Số AP 0,9313 hiện đo ở sàn 32 px, không mô tả điểm vận hành thật | `SERVICE_FACE_PX` và ba chỗ trích nó khớp 38; chấm lại AP ở sàn mới, không train lại | E9-T15 |

> E9-T10 và E9-T11 là **nợ của E9-T3**: đổi op ở tầng kiến trúc thì phải train lại, mà mọi số latency hiện có đều đo trên **trọng số chưa train**. Latency không phụ thuộc trọng số nên các số đó đúng; accuracy thì phụ thuộc, nên chưa nhánh nào được chốt.

---

## E10 — UI, chấm công, đồng bộ

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| E10-T1 | `ui_kiosk` — `Screen` base + `ScreenManager` + 5 màn hình | Chuyển màn mượt, không rò bộ nhớ | E7-T5, E7-T6 |
| E10-T2 | `svc_attendance` — FSM bảng `constexpr` + chống chấm trùng | Unit test đủ 6 trạng thái | E8-T10, E7-T9 |
| E10-T3 | Ghi log chấm công LittleFS append-only + `cursor.bin` | Rút điện 20 lần không mất bản ghi | E7-T10, E10-T2 |
| E10-T4 | `app_tasks.c` — 11 task đúng core và priority theo §5.2 | `uxTaskGetStackHighWaterMark` ổn định | E10-T1, E10-T2 |
| E10-T5 | `net_wifi` provisioning + auto-reconnect | Mất Wi-Fi tự nối lại | E7-T2 |
| E10-T6 | `net_mqtt` + `svc_sync` — hàng đợi offline, gửi lại sau ack | Ngắt mạng 1 giờ rồi nối lại, không mất bản ghi | E10-T3, E10-T5, E11-T4 |
| E10-T7 | Luồng enroll trên kiosk | Thêm được người mới từ màn hình | E10-T1, E8-T11 |
| E10-T8 | 🔬 `test_apps/soak` chạy liên tục 24 giờ | Heap không giảm dần | E10-T4 |
| E10-T9 | 🔬 Đo dòng thật lúc Wi-Fi TX + camera + LCD + loa cùng chạy | Số vào `docs/measurements/power.md`, đối chiếu §2.5 | E10-T4 |

---

## E11 — Backend

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| E11-T1 | Khởi tạo NestJS + Prisma schema 8 bảng + migration + seed | `npx prisma migrate dev` chạy sạch | E1-T3 |
| E11-T2 | `auth` — JWT access/refresh + RolesGuard + device token | Test e2e đăng nhập và refresh | E11-T1 |
| E11-T3 | CRUD `employees` `devices` `shifts` | Swagger đầy đủ | E11-T2 |
| E11-T4 | `mqtt` module — subscribe topic up, publish topic down | Nhận được bản ghi từ mosquitto | E11-T1 |
| E11-T5 | `attendance` — chống trùng bằng `unique(deviceId, localId)` | Gửi trùng 10 lần vẫn 1 bản ghi | E11-T4 |
| E11-T6 | `enrollment` + `models` (phát OTA) | Đẩy được embedding và model xuống kiosk | E11-T3 |
| E11-T7 | `realtime` WebSocket + `reports` + BullMQ | Dashboard nhận sự kiện tức thời | E11-T5 |
| E11-T8 | `docker-compose` đầy đủ trên VPS + traefik TLS | `https://api.<domain>` chạy | E11-T7 |

---

## E12 — Frontend

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| E12-T1 | Khởi tạo Next.js + Tailwind + shadcn/ui + `lib/api.ts` có interceptor refresh | Đăng nhập được | E11-T2 |
| E12-T2 | Layout dashboard + guard route | Chưa đăng nhập bị chặn | E12-T1 |
| E12-T3 | Trang `employees` + `enrollment` | Thêm/sửa/xoá được | E11-T3 |
| E12-T4 | Trang `attendance` + bộ lọc + export | Xem được lịch sử | E11-T5 |
| E12-T5 | Trang `devices` — trạng thái online, OTA | Thấy heartbeat | E11-T6 |
| E12-T6 | Trang `overview` — biểu đồ + luồng realtime | Sự kiện hiện tức thời | E11-T7 |
| E12-T7 | Deploy Vercel + CORS/cookie cho domain chéo | Chạy trên domain thật | E11-T8 |

---

## E13 — Bảo mật, OTA, hoàn thiện

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| E13-T1 | `net_ota` — OTA firmware, verify sha256, rollback tự động | Nạp bản lỗi thì tự quay về bản cũ | E10-T6 |
| E13-T2 | OTA model A/B qua `models_0`/`models_1` + `active_slot` | Đổi model không cần build lại firmware | E13-T1, E8-T1 |
| E13-T3 | Bật NVS encryption + Flash Encryption + Secure Boot v2 | Dump flash không đọc được token | E13-T1 |
| E13-T4 | MQTTS: cert CA nhúng, ACL theo deviceId | Device A không sub được topic device B | E11-T8 |
| E13-T5 | Xoay vòng device token khi còn 7 ngày | Token tự đổi | E13-T4 |
| E13-T6 | 🔬 Đo lại toàn bộ lần cuối: arena, latency, RAM đỉnh, dòng, accuracy | `docs/measurements/` đầy đủ cho báo cáo | E13-T2 |

---

## E14 — Báo cáo ĐATN

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| E14-T1 | Chương cơ sở lý thuyết: kiến trúc thân thiện INT8, quantization, TinyML | Xong bản nháp | E6-T7 |
| E14-T2 | Chương thiết kế: trích từ KẾ HOẠCH §2–§6 | Xong bản nháp | E13-T6 |
| E14-T3 | Chương kết quả: bảng số từ `docs/measurements/` | Mọi số có nguồn đo | E13-T6 |
| E14-T4 | Sơ đồ, ảnh sản phẩm, video demo | Đủ hình | E13-T6 |
| E14-T5 | Rà license research-only, ghi rõ trong báo cáo | Có mục riêng | E14-T2 |
| **E14-T7** | **Mục "lỗi chỉ phần cứng thật mới lộ"** — `docs/thesis/loi-tim-thay-tren-board.md` đã có bản đầu cho ba lỗi 09/09: cuộc đua khởi tạo bus I2C, giả định phân cực chân ngắt, và mốc thời gian datasheet sai mô hình mạch. Ghi tiếp mỗi lỗi cùng loại tìm được về sau | Mỗi lỗi có hiện tượng, giả thuyết đã loại, mốc đo, cách sửa, bằng chứng trên board | — |
| E14-T6 | Slide bảo vệ + tập trình bày | Xong | E14-T3, E14-T4 |

---

## Bảng song song

| Epic | Chạy được cùng lúc với |
|---|---|
| E1 Nền repo | — |
| E2 `ml/core` | — |
| E3 Dữ liệu | E7 |
| E4 Detection | E7 |
| E5 Recognition | E7, E11 |
| E6 Anti-spoof | E7, E11, E12 |
| E7 Firmware nền | E3–E6 |
| E8 Nạp và đo trên board | E11 |
| E9 Vòng tối ưu | E11, E12 |
| E10 UI + chấm công | E11, E12 |
| E11 Backend | E5–E10 |
| E12 Frontend | E8–E11 |
| E13 Bảo mật + OTA | — |
| E14 Báo cáo | — |

Muốn rút ngắn thì cắt E6 xuống mức tối thiểu: giữ nguyên train bằng task loss nhưng bỏ tập tự thu E3-T8, chấm bằng CelebA-Spoof. Vẫn có sản phẩm chạy, đổi lại số liveness không nói được gì về miền thiết bị.
