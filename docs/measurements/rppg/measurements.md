# rPPG trên PC — trục thời gian của chống giả

Số đo của KẾ HOẠCH §3 (*Trục thời gian*) và các task E6-T11..T14. Mọi phép đo ở đây chạy trên
video có sẵn (UniqueData, Axon) và đường board **mô phỏng**; chưa có số nào từ OV5640.

## 1. Đối chiếu POS với rPPG-Toolbox — E6-T13, 09/10/2026

**Cách đo.** POS của rPPG-Toolbox (`ubicomplab/rPPG-Toolbox`, commit `b7500b848f84ad7f86e277b4612563b69f4f88f9`)
chạy **ngoài repo** vì license (§1.4 KẾ HOẠCH): `np.mat` gán bằng `np.asmatrix` vì NumPy 2 đã bỏ nó,
và `utils.py` chỉ nạp nguyên văn hàm `detrend` (phần còn lại kéo theo skimage, sklearn). Hai bản
nhận **cùng chuỗi màu, cùng cửa sổ 6 s** trượt 1 s, trên 20 clip người thật của UniqueData đủ dài
sau khi bỏ 20% hai đầu (48 cửa sổ, đường nguyên bản). Nhịp của cả hai đọc bằng **cùng bộ tìm
đỉnh**, trong dải lọc của toolbox (0,75–3 Hz), nên chỉ cách cài đặt POS là khác nhau. Luật chốt
trước ở TASKS: ≥ 90% cửa sổ lệch ≤ 3 bpm.

**Lần 1 — trượt.** Bản commit `959211d6` (POS rồi cắt thẳng bằng FFT 0,7–4 Hz): **72,9%**, trung vị
lệch 1,31 bpm. Các ca tệ nhất cùng một dáng: bản của mình 47–58 bpm, toolbox 87–98 bpm — đỉnh của
mình nằm sát mép dưới của dải.

**Chẩn đoán** — cùng 48 cửa sổ, mỗi dòng đổi đúng một thứ sau phép chiếu POS:

| Biến thể | Khớp ≤ 3 bpm | Trung vị lệch |
|---|---|---|
| E0 — như lần 1: cắt FFT 0,7–4 Hz | 0,729 | 1,31 |
| E1 — bỏ xu hướng tuyến tính rồi cắt FFT | 0,729 | 1,42 |
| E2 — Butterworth bậc 2, 0,7–4 Hz, hai chiều | 0,792 | 0,54 |
| E3 — smoothness priors (λ = 100) rồi cắt FFT | 0,729 | 1,12 |
| E4 — kiểu dòng chảy: POS cả clip, Butterworth một chiều, cắt cửa sổ sau 1,5 s khởi động | 0,667 (18 cửa sổ) | 1,82 |
| **E5 — đúng bộ lọc của toolbox: smoothness priors + Butterworth bậc 1, 0,75–3 Hz, hai chiều** | **1,000** | **0,07** |
| **E6 — Butterworth bậc 1, 0,75–3 Hz, hai chiều, không bỏ xu hướng** | **0,958** | **0,16** |
| E7 — chỉ hẹp dải cắt FFT về 0,75–3 Hz | 0,729 | 1,31 |

Đọc bảng:
- **Lõi POS đúng**: qua cùng bộ lọc thì hai bản trùng gần tuyệt đối (E5).
- Chỗ khác là **hình dạng bộ lọc sau POS**, không phải xu hướng chậm (E1, E3 không đổi gì) và
  không phải hai mép dải (E7 không đổi gì). Sườn thoải của Butterworth bậc 1 dìm cử động và nhịp
  thở quanh 0,8 Hz; bộ cắt thẳng giữ chúng nguyên vẹn, nên một đỉnh giả ~50 bpm thắng mạch thật.

**Chọn E6** cho cả ba phương pháp: Butterworth bậc 1 dải 0,75–3 Hz là một biquad, esp-dsp có sẵn, và
lọc hai chiều trên bộ đệm T giây của board làm được. Bỏ smoothness priors vì nó cần nghịch đảo một
ma trận n × n mỗi cửa sổ, nặng cho board mà chỉ thêm 4 điểm phần trăm. Quyết định này chốt
**trước** khi chạy E6-T14, nên không chạm vào giao thức liveness.

**Lần 2 — đạt.** Code sau khi sửa: **95,8%** cửa sổ lệch ≤ 3 bpm, trung vị 0,16 bpm, p90 0,94 bpm;
nửa trên và nửa dưới theo SNR đều 95,8%. Ca tệ nhất còn lại: 50,6 so với 79,0 bpm ở một cửa sổ
SNR 2,7 dB.
