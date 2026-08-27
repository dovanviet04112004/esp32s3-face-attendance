# contracts/

Nguồn sự thật duy nhất cho ba khối `ml/`, `firmware/`, `backend+frontend`. Không khối nào
được định nghĩa lại thứ đã có ở đây.

## Bố cục

| Đường dẫn | Nội dung |
|---|---|
| `schema/` | 6 file JSON Schema — payload MQTT |
| `mqtt_topics.yaml` | topic + QoS + retained + chiều + schema tương ứng |
| `golden/` | Vector vàng: Python sinh, C kiểm |
| `models.lock.json` | Model đang deploy: file, sha256, run_id, arena_bytes |

## Sinh code

`tools/gen_from_schema.sh` đọc `schema/` và sinh ra:

| Đích | File |
|---|---|
| Backend | `backend/src/common/generated/*.ts` |
| Frontend | `frontend/types/generated/*.ts` |
| Firmware | `firmware/components/common/include/gen_payload.h` |

**File sinh ra không được sửa tay.** CI chạy lại generator rồi `git diff --exit-code`, lệch
là fail. Đổi payload thì sửa schema rồi chạy `make gen`, không sửa ở ba khối.

## Vector vàng

`golden/` giải bài toán hậu xử lý Python phải khớp 1:1 với C. `ml` xuất tensor đầu vào và
kết quả mong đợi ra `.npz`; `firmware/test_apps/parity` đọc chính file đó và so sánh trên
board. Lệch ở decode anchor, NMS hay affine warp lộ ra ngay thay vì phải mò lúc tích hợp.

| Thư mục | Bản Python | Bản C |
|---|---|---|
| `golden/detection/decode/` | `ml/src/facepipe/tasks/detection/postproc/decode.py` | `ai_engine/src/detection/decode.cpp` |
| `golden/detection/nms/` | `.../postproc/nms.py` | `ai_engine/src/detection/nms.cpp` |
| `golden/antispoof/preproc/` | `.../tasks/antispoof/postproc/preproc.py` | `ai_engine/src/antispoof/preproc.cpp` |
| `golden/recognition/align/` | `.../tasks/recognition/postproc/align.py` | `ai_engine/src/recognition/align.cpp` |
| `golden/recognition/l2norm/` | `.../postproc/l2norm.py` | `ai_engine/src/recognition/l2norm.cpp` |
| `golden/recognition/cosine/` | `.../postproc/cosine.py` | `svc_facedb/src/embedding_index.cpp` |

## Bắt buộc commit

`golden/` và `models.lock.json` **phải commit** dù là dữ liệu nhị phân. Mất chúng là mất
khả năng tái lập. Xem KẾ HOẠCH §4.3.
