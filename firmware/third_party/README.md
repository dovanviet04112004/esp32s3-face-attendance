# firmware/third_party/

Code của bên thứ ba **không có trên ESP Component Registry** — SDK của hãng, fork. Khai
vào build bằng `EXTRA_COMPONENT_DIRS` trong `firmware/CMakeLists.txt`.

Thứ có trên registry thì khai ở `main/idf_component.yml`, ESP-IDF tự kéo về
`managed_components/` — không vendor vào đây.

| Thư mục | Nguồn |
|---|---|
| `vl53l1x_uld/` | ST STSW-IMG009, driver ToF VL53L1X |

## Quy tắc

- **Không sửa thẳng file gốc.** Phải vá thì để `.patch` trong `<name>/patches/`.
- **Không thêm comment vào code third-party.** Ghi chú để ở `<name>/UPSTREAM.md`.
- `UPSTREAM.md` bắt buộc có: url, phiên bản, ngày lấy, sha256, đã sửa gì.
- `CMakeLists.txt` bọc thành component IDF là file mình viết, nằm cạnh source nguyên bản.

## Khuôn một thư mục

```
vl53l1x_uld/
├── CMakeLists.txt      # ta viết
├── UPSTREAM.md         # url, version, ngày, sha256, patch nào, bỏ file nào
├── patches/*.patch
└── core/ platform/     # nguyên bản, không đụng vào
```

Thư mục con giữ **đúng tên của bản gốc**, không đổi thành `src/`+`include/`: đổi tên là một
dạng sửa, và nó làm sha256 không còn đối chiếu được theo đường dẫn.

Bỏ **một file** khỏi bản vendor là hợp lệ khi file đó là bản mẫu mà dự án phải tự hiện
thực — nhưng phải ghi rõ file nào và vì sao vào `UPSTREAM.md`. Xem `vl53l1x_uld` với
`platform/vl53l1_platform.c`.
