# rPPG — trục thời gian của chống giả

Đo trên PC xem mạch máu dưới da có tách được mặt thật khỏi giấy, mặt nạ và màn hình
không, trước khi đụng tới board. Không có model: GREEN, CHROM, POS chạy trên trung bình màu
của trán và hai má. Lý do, giao thức và cổng nằm ở KẾ HOẠCH §3 (*Trục thời gian*).

Chạy từ `ml/`, theo đúng thứ tự:

```bash
python -m facepipe.data.make_split --task rppg --source data/interim/antispoof/unique_pair
python -m facepipe.tasks.rppg.traces --threads 2          # video → data/interim/rppg/traces/
python -m facepipe.tasks.rppg.eval                        # → artifacts/rppg/eval/<giờ>_<sha>/
```

`traces` trích một lần cho bốn đường (nguyên bản, board 80/100/120 px) và bỏ qua clip đã có;
`--overwrite` để trích lại. `eval` in bảng và kết luận cổng, số giữ lại chép sang
`docs/measurements/rppg/measurements.md`.
