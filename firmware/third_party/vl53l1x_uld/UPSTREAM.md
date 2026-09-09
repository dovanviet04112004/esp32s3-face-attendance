# vl53l1x_uld — ST VL53L1X Ultra Lite Driver

| | |
|---|---|
| Sản phẩm | **STSW-IMG009**, VL53L1X Ultra Lite Driver (ULD) API |
| Chủ sở hữu | STMicroelectronics |
| Trang gốc | https://www.st.com/en/embedded-software/stsw-img009.html |
| Lấy từ | https://github.com/linkjumper/VL53L1X_ULD_API — nhánh `master` |
| Ngày lấy | 2026-09-09 |
| License | **BSD 3-Clause**. Header mỗi file ghi *dual licensed, either 'STMicroelectronics Proprietary license' or 'BSD 3-clause "New" or "Revised" License', at your option* — dự án chọn nhánh BSD-3-Clause |

Trang ST yêu cầu nhấn đồng ý mới tải được, nên bản vendor lấy từ mirror ở trên. Đối chiếu
được với bản ST bằng sha256 dưới đây.

## File và sha256

```
1cc18c7fa475fa7a26d08d9c1f3d060df2279168b17c1a7e1ecbf63e0e10503a  core/VL53L1X_api.c
ad31ffab675eb75838452b9a1488a4e0bac336e47ff8fd659b3cc7111f4d6df5  core/VL53L1X_api.h
03b86da6fc651212d3bd1ba1c048a9e863e188f41ca0039ce746fdf95770ecab  core/VL53L1X_calibration.c
22f7a2e3b036de31395f19a680b246997ab3ac1af65d324bc13737e860790417  core/VL53L1X_calibration.h
8d7a96f9f8c0f2b0adae92ccf0ad894628139da1d49a57c832a65579c752e3b5  platform/vl53l1_platform.h
b92378b09370b412b52ce3f72c351a4b95fb976b81ad285a9f5e7ec48dbdc64d  platform/vl53l1_types.h
```

Kiểm lại:

```bash
cd firmware/third_party/vl53l1x_uld && sha256sum -c <<'EOF'
# dán khối trên vào đây
EOF
```

## Đã sửa gì

**Không sửa một dòng nào.** `patches/` rỗng.

## Đã bỏ gì, và vì sao

Bản gốc còn một file thứ bảy: **`platform/vl53l1_platform.c`** — bản mẫu của ST hiện thực
9 hàm I2C và delay mà API khai `extern`. File đó **không được vendor**, vì:

- Bus I2C của board mang bốn thiết bị (§2.3B) và mọi truy cập phải đi qua `bsp_i2c_lock()`
  (§5.3). Bản mẫu của ST không biết gì về mutex đó.
- Vendor cả file thì trùng ký hiệu với bản hiện thực thật lúc link.
- Sửa nó tại chỗ thì vi phạm `CLAUDE.md` §2.10.

Hiện thực thật nằm ở **`firmware/components/drv_tof/src/vl53l1_platform.c`** — code của dự
án, đúng chỗ `components/` dành cho code mình viết (§4.5.1).

## Bọc thành component

`CMakeLists.txt` cạnh file này là của dự án, không phải của ST. Nó chỉ biên dịch hai `.c`
của `core/` và mở `core/` cùng `platform/` làm include dir; component **không** khai
`REQUIRES` nào vì nó chỉ gọi 9 hàm `extern` do `drv_tof` định nghĩa.

`VL53L1X_SetI2CAddress()` không bao giờ được gọi: board chỉ có một VL53L1X và nó chạy ở
địa chỉ mặc định `0x29` (§2.3D). Nhờ vậy tham số `dev` của tầng platform là handle mờ —
`drv_tof` truyền gì cũng được và bỏ qua nó.
