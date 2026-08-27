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
├── UPSTREAM.md         # url, version, ngày, sha256, patch nào
├── patches/*.patch
└── {src, include}/     # nguyên bản, không đụng vào
```
