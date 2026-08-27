# firmware/models/

`.tflite` là **artifact của `ml/`**, không phải source. Không commit vào repo. Chỉ ba loại
file trong thư mục này được commit: `README.md` này, `models.lock.json`, và `meta.json`
của từng nhánh.

## Kéo model về

```bash
ml/scripts/50_pack_and_flash.sh
```

Script này verify sha256 theo `contracts/models.lock.json`, đọc `meta.json` từng nhánh,
gộp ba `.tflite` thành `models.bin` rồi ghi bằng
`parttool.py write_partition --partition-name models_0`.

## Bố cục

```
models/
├── models.lock.json                # copy từ contracts/ lúc build
├── detection/{yunet_int8.tflite, meta.json}
├── antispoof/{minifasnet_int8.tflite, meta.json}
└── recognition/{mobilefacenet_int8.tflite, meta.json}
```

`meta.json` giữ `in_h`, `in_w`, `arena_hint`, `sha256`, `run_id`.

## Vì sao không nhúng thành mảng C

Nhúng model vào binary thì đổi model phải build lại toàn bộ firmware và mất khả năng OTA
riêng model — mà model là thứ đổi nhiều nhất trong dự án này. Firmware đọc trọng số trực
tiếp từ flash qua mmap, xem KẾ HOẠCH §6.2.2.

Đổi model thì phải chạy `update_lock.py` để cập nhật `contracts/models.lock.json` và
`meta.json` trong cùng một commit.
