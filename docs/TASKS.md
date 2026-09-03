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
| E2-T2 | `core/config.py` — pydantic schema, merge YAML, override CLI | Nạp `configs/detection/kd.yaml` không lỗi | E2-T1 |
| E2-T3 | `core/registry.py` — gọi model/loss/dataset bằng tên | `@register("dummy")` rồi gọi được từ YAML | E2-T2 |
| E2-T4 | `core/trainer.py` — AMP, EMA, grad-clip, checkpoint, resume | Train 2 epoch model giả, ngắt giữa chừng, resume đúng bước | E2-T3 |
| E2-T5 | `core/distiller.py` + `core/hooks.py` — TeacherWrapper, DistillLoss, hook feature map | Distill model giả → student giả, loss giảm | E2-T4 |
| E2-T6 | `core/run_dir.py` — sinh thư mục run kèm `config.resolved.yaml`, `env.txt`, `split.lock` | Mỗi lần chạy ra một thư mục đủ 3 file | E2-T4 |
| E2-T7 | `core/seed.py` + `core/logger.py` | Hai lần chạy cùng seed cho cùng loss | E2-T4 |
| E2-T8 | **Độ phân giải đầu vào là tham số config, không hardcode** | Đổi `input_hw` trong YAML là đổi được cả train lẫn export | E2-T2 |
| E2-T9 | Test: `core/` không import gì từ `tasks/` | Script kiểm CI, fail khi vi phạm | E2-T5 |

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
| **E3-T11** | **Gỡ chỗ CPU và GPU phải chờ nhau trong vòng train.** Đo trên teacher: một luồng Python ghim 100% một nhân, GPU chỉ 66–71%. Hai cơ chế ngược nhau, ba chỗ: **(a)** `distiller.py:139,214,232` — `float(value.detach())` cho từng thành phần loss, **~5 lần đồng bộ mỗi bước**, nặng nhất; **(b)** `trainer.py` — `if not torch.isfinite(loss)` ép đọc bool từ GPU mỗi bước; **(c)** chi phí phóng lệnh từng lớp, gỡ bằng `torch.compile`. Sửa (b) mà bỏ (a) thì **không được gì** | (a)+(b): giữ loss dạng tensor, cộng dồn trên GPU, chỉ đổi sang `float` ở nhịp `log_every_steps`; cờ non-finite gom trên GPU rồi kiểm cùng nhịp đó. (c): khoá `train.compile` trong config, **không hardcode**. Đo it/s trước/sau. Bẫy phải tránh: `torch.compile` bọc model nên `state_dict()` mọc tiền tố `_orig_mod.` — checkpoint phải lấy từ module gốc, nếu không sẽ hỏng im lặng lúc export | E2-T5 |
| **E3-T12** | `channels_last` cho model tích chập chạy AMP — một dòng, thường 10–30% trên tensor core 🔬 chưa đo trên máy này | Đo it/s trước/sau; cùng ràng buộc §3.7 như `train.compile` nếu nó đổi kết quả | E3-T11 |
| **E3-T14** | **Chọn batch bằng bộ nhớ ở trạng thái ổn định, không bằng vài vòng đầu.** Teacher đo được 2,36 GB ở vòng đầu nên chốt batch 4; thực tế ổn định là **3,41 GiB trên card 4,0 GiB** — chỉ còn 0,6 GiB dư địa, và bộ nhớ reserved còn bò lên 5,95 GiB sau ~30 epoch rồi tràn sang RAM host, chậm **50×**. Đo lại sau **≥3 epoch**, chừa **≥25% dư địa**. Kiểm luôn cảnh báo `max_det` Ultralytics tự nâng (300 → 1968 với WIDER): nó quyết định bộ nhớ mỗi lần validation | Config của mỗi nhánh ghi rõ VRAM ổn định đo ở epoch mấy, không phải ở vòng đầu | — |
| **E3-T13** | **Đặt `PYTORCH_CUDA_ALLOC_CONF=garbage_collection_threshold:0.8,max_split_size_mb:256` cho mọi run trên card 4 GB.** Đo được trên teacher: sau ~24 epoch, bộ nhớ reserved bò tới 4,16 GiB trên card 4,0 GiB — WSL **không ném lỗi**, nó âm thầm đẩy sang RAM host và chậm **20×** (0,33 → 6,6 s/vòng). Ultralytics đã tự gọi `_clear_memory(0.5)` cuối mỗi epoch nên đó không phải chỗ thiếu; bộ nhớ phình **trong lòng epoch** vì ảnh WIDER có từ 1 tới 1.968 mặt. Hai tham số này tác động liên tục trong epoch | Chạy hết 100 epoch không tụt xuống dưới 3,0 it/s. ⚠️ **KHÔNG dùng `expandable_segments:True`** — đã thử, giảm reserved 1,5 GB thật nhưng **sập sau 10 phút** với `!handles_.at(i) INTERNAL ASSERT FAILED` ở `CUDACachingAllocator.cpp:467`: nó cần API bộ nhớ ảo của driver mà WSL đi qua GPU-PV không hỗ trợ đủ | — |
| **E3-T10** | **Tầng `fast_drive`** (KẾ HOẠCH §4.4.1): ảnh ext4 loop trên `E:`, khai `/etc/fstab`; chuyển sang **chỉ tập nào vừa page cache** — ảnh WIDER + bố cục Ultralytics, nối bằng **hardlink** thay symlink. Shard anti-spoof và recognition ở lại `cold_drive` | `/data` còn mount sau `wsl --shutdown`; đo được ảnh/giây **cả cache lạnh lẫn nóng** trên cùng một tập, và MB/s tuần tự trên cả hai ổ | E3-T1 |

---

## E4 — Nhánh detection

Làm trước trong ba nhánh. Nó là cổng của pipeline, và **landmark của nó quyết định cách align ảnh đưa vào recognition** — có detector thật rồi mới train recognition thì tránh được sai lệch train/serve ở khâu align.

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| E4-T1 | `teacher/yolo26_pose_wrapper.py` + `finetune_widerface.py` | Teacher ra box + 5 landmark, WIDER hard ≥ 0,80 **đo ở 640²** (§3 lớp 2) | E2-T5, E3-T2 |
| E4-T2 | `teacher/export_soft_target.py` — cache box + landmark + score. **Không cache feature map**: mosaic làm nó vô nghĩa (§3 Lớp 2), FGD phải chạy teacher online | Shard `.npz` đọc được | E4-T1 |
| E4-T3 | `student/{yunet, head, anchors, blocks}.py` | Param ≈ 75,8K, ra 3 nhánh đầu ra | E2-T3 |
| E4-T4 | `losses/{kd_logit, kd_localization, kd_feature_fgd, task_loss}.py` | Unit test từng loss | E4-T3 |
| E4-T5 | `train_kd.py` nhiều giai đoạn: feature → +logit/loc → +task | AP ≥ 0,90 trên mặt ≥ 32 px ở FP32 (§3 lớp 2) | E4-T2, E4-T4, E3-T5 |
| E4-T6 | `eval.py` — WIDER AP + **NMSE landmark trên ảnh OV5640** | NMSE < 5% | E4-T5, E3-T7 |
| E4-T7 | **Bảng đối chứng A (§3.7)** — **2 arm**: A0 không teacher, A3 toàn bộ KD (logit + feature + localization + FGD) | `docs/measurements/<nhánh>/ablation_teacher.md` đủ 2 dòng + ADR | E4-T5 |
| E4-T8 | **Thang lượng tử hoá (§3.8)** — Q0 → Q1 → Q2, dừng khi đạt | `docs/measurements/<nhánh>/{quant_ladder,calib_sweep}.md` | E4-T7 |
| E4-T9 | **Quét từng lớp (§3.9)** — mốc Q3, chỉ khi Q1 và Q2 đều chưa đạt | `layer_sensitivity.csv` + chọn được `k` ở điểm gãy | E4-T8 |
| E4-T10 | `postproc/{decode, nms}.py` + `emit_golden.py` | `contracts/golden/detection/` có vector vàng | E4-T8 |
| E4-T11 | Export tflite + `tflite_op_check.py` + `meta.json` + lock | AP trên mặt ≥ 32 px sụt < 1% so với FP32, hai file khớp sha256 | E4-T8 |
| E4-T12 | Nếu NMSE > 5%: đổi sang RetinaFace-MobileNet0.25 | Đạt ngưỡng, ghi ADR mới | E4-T6 |
| **E4-T13** | **Cầu nối teacher → student cho arm A3.** Hai thứ còn thiếu, arm A3 của nhánh này chưa chạy được nếu không có: (a) `detection_kd_logit` đòi `teacher_out` là `HeadOutput` trên prior của student, nhưng `Yolo26PoseTeacher` trả `TeacherDetections` — cần một module gán soft target vào prior; (b) FGD cần feature map của teacher **ở cùng độ phân giải với student**, mà teacher chạy 640² còn student chạy 160×120 | Arm A3 chạy hết 1 epoch với đủ 3 term, `docs/measurements/<nhánh>/ablation_teacher.md` có dòng A3 | E4-T2, E4-T4 |

---

## E5 — Nhánh recognition

Teacher R50 có weight sẵn, **không phải train teacher**. Ảnh `test_device` dùng crop align bằng **detector thật từ E4**, không phải landmark thủ công.

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| ~~E5-T0~~ | ~~`recordio_to_wds.py`: bỏ member `.cls`~~ — **bỏ**. Shard đã nằm trên `fast_drive`, đọc nghẽn ở giải nén JPEG chứ không ở tar; sinh lại 36 GB để tiết kiệm 5,3 GB đọc tuần tự không đổi lại được gì | — | — |
| E5-T1 | `teacher/r50_wf600k.py` + `export_embedding.py` | Cache embedding 512-D ra `.npy` memmap | E2-T5, E3-T4 |
| E5-T2 | `student/mobilefacenet.py` + `blocks.py` (ReLU6, kênh bội 8) | Forward ra 512-D, param **1,20M** đo được (0,99M của bài báo là bản embedding 128-D) | E2-T3 |
| E5-T3 | `losses/{arcface, kd_embedding, kd_relation_rkd}.py` | Unit test từng loss | E5-T2 |
| E5-T4 | `train_kd.py` + `data.py` — chạy KD thật | LFW ≥ 99,0 ở FP32 | E5-T1, E5-T3, E3-T5, **E3-T10** |
| E5-T5 | `postproc/{align, l2norm, cosine}.py` | Align được bằng landmark thật từ detector E4 | E5-T4, E4-T11 |
| E5-T6 | `eval.py` — LFW/CFP-FP/AgeDB + TAR@FAR trên `test_device` đã align bằng E4 | Bảng số vào `artifacts/recognition/reports/` | E5-T5 |
| E5-T7 | **Bảng đối chứng A (§3.7)** — **2 arm**: A0 không teacher, A3 toàn bộ KD (embedding + RKD) | `docs/measurements/<nhánh>/ablation_teacher.md` đủ 2 dòng + ADR | E5-T6 |
| E5-T8 | **Thang lượng tử hoá (§3.8)** — Q0 → Q1 → Q2 | `docs/measurements/<nhánh>/{quant_ladder,calib_sweep}.md` | E5-T7 |
| E5-T9 | **Quét từng lớp (§3.9)** — mốc Q3, chỉ khi cần | `layer_sensitivity.csv` + chọn `k` | E5-T8 |
| E5-T10 | `emit_golden.py` | `contracts/golden/recognition/` có vector vàng | E5-T8 |
| E5-T11 | Export tflite + op check + `meta.json` + lock | LFW ≥ 99,0 ở INT8, hai file khớp sha256 | E5-T8 |

---

## E6 — Nhánh anti-spoof

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| **E6-T0** | **`celeba_spoof_parquet.py` ghi thẳng ra shard** — **hai tỉ lệ 1x và 2.7x cùng một record** (KẾ HOẠCH §4.4.1), không đi qua bước 1,05 triệu file lẻ; giải nén chạy song song nhiều nhân | Shard đọc lại đủ `tight.jpg` + `wide.jpg` + `json`, **đo được record/giây so với file lẻ** | E3-T3, E3-T10 |
| E6-T1 | `teacher/cdcnpp.py` + `depth_gt.py` | Kiến trúc chạy, depth map GT sinh được | E2-T5, E3-T3 |
| E6-T2 | `teacher/train_teacher.py` trên CelebA-Spoof | ACER < 2% trên tập val | E6-T1, **E6-T0** |
| E6-T3 | `teacher/export_soft_target.py` — logit + depth map 32×32 | Shard đọc được | E6-T2 |
| E6-T4 | `student/minifasnet_v2_se.py` — **hai backbone**, SE dùng HardSigmoid | Param ≈ 0,53M; forward nhận cặp (tight, wide) | E2-T3 |
| E6-T5 | `losses/{kd_logit, kd_depth_map, contrastive_depth_loss, task_loss}.py` | Unit test từng loss | E6-T4 |
| E6-T6 | `train_kd.py` | ACER < 5% ở FP32 | E6-T3..T5, **E6-T0** |
| E6-T7 | `eval.py` — ACER, HTER cross-dataset, ROC tập tự thu | HTER < 15% | E6-T6, E3-T8 |
| E6-T8 | **Bảng đối chứng A (§3.7)** — **2 arm**: A0 không teacher, A3 toàn bộ KD (logit + depth map + contrastive depth) | `docs/measurements/<nhánh>/ablation_teacher.md` đủ 2 dòng + ADR | E6-T6 |
| E6-T9 | **Thang lượng tử hoá (§3.8)** Q0→Q1→Q2 + **quét từng lớp (§3.9)** nếu cần | INT8 giữ ACER < 5%, `quant_ladder.md` + `calib_sweep.md` | E6-T8 |
| E6-T10 | Export + `postproc/preproc.py` + golden + `meta.json` + lock | Hai file khớp sha256 | E6-T9 |

---

## E7 — Firmware nền

Chạy song song với E4–E6. Không phụ thuộc model.

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| E7-T1 | Đấu cả hai cơ cấu chấp hành theo §2.3F: module 4 relay opto (tiếp điểm để hở) và servo SG90 | Rút jumper JD-VCC, P2 ở HIGH thấy relay tắt hẳn, P2 ở LOW nghe cạch và đo thông mạch COM–NO, servo quét đủ tầm | — |
| E7-T2 | `main/app_config.h` + `bsp_board` + `partitions.{dev,prod}.csv` | Board boot, PSRAM 8MB nhận đủ | — |
| E7-T2b | **3 profile build** `sdkconfig.{dev,bench,prod}` theo §4.5.9, kèm flash QIO 80 MHz | 3 lệnh build ở §4.5.9 đều chạy, `bench` dùng `-O2` | E7-T2 |
| E7-T3 | `common/` — RAII guard: `FrameGuard` `LockGuard` `MmapRegion` `Queue<T,N>` | Unit test từng guard | E7-T2 |
| E7-T4 | `drv_ioexp` (PCF8574) + `drv_camera` (OV5640) | Chụp được ảnh QVGA vào PSRAM | E7-T2 |
| E7-T5 | `drv_lcd` (ST7796 + bounce buffer) + LVGL port | Hiện được ảnh tĩnh 480×320 | E7-T2 |
| E7-T6 | `drv_touch` (GT911, trình tự chọn địa chỉ) | Đọc được điểm chạm | E7-T4 |
| E7-T7 | `drv_tof` (VL53L1X ULD) | Đọc khoảng cách, ngắt GPIO3 hoạt động | E7-T4 |
| E7-T8 | `drv_audio` (I2S + MAX98357A) | Phát WAV từ SPIFFS, không xì | E7-T2 |
| E7-T9 | `drv_relay` **và** `drv_servo` + `svc_door` (IDoor + `RelayDoor` + `ServoDoor` + `FakeDoor`) | Đổi `Kconfig` là đổi được cơ cấu, `FakeDoor` chạy test trên host | E7-T1, E7-T3 |
| E7-T10 | `sys_storage` — NVS, LittleFS, mmap model, `storage_format.h` + `static_assert` | Ghi/đọc `faces.bin` sống sót khi rút điện giữa chừng | E7-T2 |
| E7-T11 | Preview camera → LCD chạy liên tục | ≥ 12 fps, LVGL không giật | E7-T4, E7-T5 |
| E7-T12 | `tools/check_layers.py` chạy sạch trên firmware thật | CI xanh | E7-T10 |

---

## E8 — Nạp và đo trên board 🔬

Đây là lần đầu tiên biết sự thật. Mọi số trước đó chỉ là ước lượng trên giấy.

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| E8-T1 | `ai_engine/src/core/` — `TfliteModelBase`, `ArenaAllocator`, `model_store` mmap | Nạp được 1 model từ partition | E7-T10 |
| E8-T2 | `scripts/flash_models.sh` — gộp 3 tflite → `models.bin` → ghi `models_0` | Verify sha256 khớp `models.lock.json` | E8-T1, E4-T11, E5-T11, E6-T10 |
| E8-T3 | `src/recognition/` — model + ops + align + l2norm | MobileFaceNet INT8 chạy trên board | E8-T2 |
| E8-T4 | `src/detection/` — model + ops + decode + nms | YuNet INT8 chạy trên board | E8-T2 |
| E8-T5 | `src/antispoof/` — model + ops + preproc | MiniFASNet INT8 chạy trên board | E8-T2 |
| E8-T6 | `test_apps/parity` — so với `contracts/golden/` cả 3 nhánh | Sai số < 1e-3 trên mọi vector vàng | E8-T3..T5 |
| E8-T7 | 🔬 **Đo `tail` và `head` riêng từng model** (§3.10), không chỉ tổng `arena_used_bytes()` | 6 con số vào `docs/measurements/arena.md` | E8-T3..T5 |
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
| Latency quá cao | E9-T3 — đọc `latency.md`, tìm op không có kernel ESP-NN, thay op ở tầng kiến trúc rồi train lại | Sửa `student/blocks.py` |
| Latency vẫn cao | E9-T4 — siết ngưỡng thoát sớm, giảm tần suất chạy recognition | Sửa `svc_vision` |
| Accuracy INT8 tụt | E9-T5 — sensitivity analysis → mixed-precision giữ float layer đầu và cuối | `compress/sensitivity/` |
| Accuracy vẫn tụt | E9-T6 — QAT + LSQ + quantization-aware KD | Train lại nhánh đó |
| Landmark lệch | E9-T7 — đổi student detection sang RetinaFace-MobileNet0.25 | Train lại nhánh detection |
| Sai số parity C ↔ Python | E9-T8 — sửa bản C cho khớp bản Python, không sửa ngược | `ai_engine/src/<nhánh>/` |

| ID | Task | Xong khi | Chặn bởi |
|---|---|---|---|
| E9-T9 | Cập nhật KẾ HOẠCH §3 và §6 theo số đo thật | Kế hoạch khớp thực tế, không còn 🔬 nào chưa có số | E8-T12 |

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
| E14-T1 | Chương cơ sở lý thuyết: KD, quantization, TinyML | Xong bản nháp | E6-T8 |
| E14-T2 | Chương thiết kế: trích từ KẾ HOẠCH §2–§6 | Xong bản nháp | E13-T6 |
| E14-T3 | Chương kết quả: bảng số từ `docs/measurements/` | Mọi số có nguồn đo | E13-T6 |
| E14-T4 | Sơ đồ, ảnh sản phẩm, video demo | Đủ hình | E13-T6 |
| E14-T5 | Rà license research-only, ghi rõ trong báo cáo | Có mục riêng | E14-T2 |
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

Muốn rút ngắn thì cắt E6 xuống mức tối thiểu: train MiniFASNet thẳng bằng task loss, bỏ KD depth map. Vẫn có sản phẩm chạy, đổi lại mất phần đóng góp học thuật đáng giá nhất của đồ án.
