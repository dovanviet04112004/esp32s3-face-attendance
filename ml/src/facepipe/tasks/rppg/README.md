# rPPG — trục thời gian của chống giả

Đo trên PC xem mạch máu dưới da có tách được mặt thật khỏi giấy, mặt nạ và màn hình
không, trước khi đụng tới board. Không có model: GREEN, CHROM, POS chạy trên trung bình màu
của trán và hai má. Lý do, giao thức và cổng nằm ở KẾ HOẠCH §3 (*Trục thời gian*).

Chạy từ gốc repo, theo đúng thứ tự, hoặc cả ba bằng `make rppg`:

```bash
make rppg-split     # người thật UniqueData chia đôi theo worker → data/splits/rppg/v1/
make rppg-traces    # video → data/interim/rppg/traces/
make rppg-eval      # → artifacts/rppg/eval/<giờ>_<sha>/
```

`rppg-traces` trích một lần cho bốn đường (nguyên bản, board 80/100/120 px) và bỏ qua clip đã
có; `ARGS=--overwrite` để trích lại. `rppg-eval` in bảng và kết luận cổng, số giữ lại chép sang
`docs/measurements/rppg/measurements.md`.
