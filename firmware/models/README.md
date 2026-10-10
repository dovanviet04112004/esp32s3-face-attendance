# firmware/models/

File model là **artifact của `ml/`**, không phải source. Không commit vào repo. Chỉ ba loại
file trong thư mục này được commit: `README.md` này, `models.lock.json`, và `meta.json`
của từng nhánh.

## Nạp model lên board

```bash
make pack PORT=/dev/ttyACM0
```

`make pack` chạy `ml/scripts/50_pack_and_flash.sh`. Script verify sha256 theo
`contracts/models.lock.json`, đọc `meta.json` từng nhánh, gộp ba file thành
`firmware/build/models.bin` rồi ghi vào cả hai slot `models_0` và `models_1` bằng
`parttool.py write_partition`. Bỏ `PORT=` thì chỉ đóng gói, không ghi.

## Bố cục

```
models/
├── models.lock.json        # bản chép của contracts/models.lock.json, make export ghi cả hai
├── detection/{yunet_s8.espdl, yunet_int8.tflite, meta.json}
├── antispoof/{minifasnet_s8.espdl, minifasnet_int8.tflite, meta.json}
└── recognition/{mobilefacenet_s8.espdl, mobilefacenet_int8.tflite, meta.json}
```

Lock quyết định file nào được đóng gói. Bộ đang deploy là `.espdl` cho ESP-DL; `.tflite` dành
cho firmware dựng với `AI_RUNTIME_TFLM` để đối chứng.

`meta.json` giữ `in_h`, `in_w`, `arena_hint`, `sha256`, `run_id`. `arena_hint` bằng 0 với
`.espdl`, vì ESP-DL tự cấp bộ nhớ cho từng model.

## Vì sao không nhúng thành mảng C

Nhúng model vào binary thì đổi model phải build lại toàn bộ firmware và mất khả năng OTA
riêng model — mà model là thứ đổi nhiều nhất trong dự án này. Firmware mở model thẳng từ
partition qua mmap, xem KẾ HOẠCH §6.2.2.

Đổi model thì chạy `make export`: nó chép file vào đây, cập nhật `contracts/models.lock.json`,
bản chép của lock và `meta.json` trong cùng một bước, để commit chung.
