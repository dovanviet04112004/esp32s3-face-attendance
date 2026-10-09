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

## 2. Liveness bằng SNR mạch — E6-T14, 09/10/2026

**Trượt cổng.** Trên đường board 100 px không có T ≤ 6 s nào vừa giữ giấy lọt ≤ 10% vừa giữ người
thật `test` bị chặn ≤ 10%. Ở những dòng chặn người thật ≤ 10%, giấy lọt thấp nhất vẫn là **84,6%**
(GREEN, 3 s). Trượt ngay từ đường nguyên bản, nên theo giao thức (KẾ HOẠCH §3) bộ video này **chưa
đủ để kết luận** về rPPG trên OV5640: E8 không mở, thu trên board hay không do chủ repo quyết.

**Dữ liệu.** 179 clip đi qua bốn đường (nguyên bản, board 80 / 100 / 120 px), ra 28.407 cửa sổ.

| Lớp | Clip | Nguồn | Dài sau khi bỏ 20% hai đầu |
|---|---|---|---|
| Người thật | 29: `dev` 14, `test` 15, chia theo `worker_id` | UniqueData | 3,6–16,4 s |
| Giấy | 61: khoét lỗ 15 · mặt nạ giấy 3D 36 · giấy bọc 10 | Axon | 7,0–9,4 · 2,1–4,8 · 2,0–2,6 s |
| Mặt nạ đeo | 44: latex 10 · silicone 11 · vải 23 | Axon | 5,1–11,2 s |
| Phát lại | 45: UniqueData 30 · Axon 15 | cả hai | 4,0–15,7 s |

Giấy 3D và giấy bọc ngắn hơn 6 s, nên **ở T = 6 s lớp giấy chỉ còn ảnh khoét lỗ**. Ở T = 4 s có thêm
6 clip giấy 3D; chỉ ở T = 2 s mới đủ cả 61 clip. Số cửa sổ trên đường board 100 px, như nhau ở ba
phương pháp; cột cuối là của POS:

| T (s) | Người thật `dev` / `test` | Giấy | Mặt nạ | Phát lại | Không chấm được |
|---|---|---|---|---|---|
| 2 | 84 / 76 | 182 | 229 | 285 | 462 |
| 3 | 68 / 60 | 117 | 183 | 238 | 103 |
| 4 | 54 / 45 | 81 | 139 | 193 | 0 |
| 6 | 29 / 18 | 45 | 51 | 105 | 0 |
| 8 | 13 / 5 | 15 | 18 | 37 | 0 |

**Đường board 100 px** — lần chạy `20261009-1627_05e3e46`, ngưỡng chặn 5% cửa sổ người thật `dev`:

| Phương pháp | T (s) | Ngưỡng (dB) | Không chấm được | `test` bị chặn | Giấy lọt | Mặt nạ lọt | Phát lại lọt | AUC giấy |
|---|---|---|---|---|---|---|---|---|
| GREEN | 2 | −∞ | 423 | 0,434 | 0,489 | 0,555 | 0,463 | 0,508 |
| GREEN | 3 | −∞ | 103 | 0,100 | 0,846 | 0,858 | 0,828 | 0,452 |
| GREEN | 4 | −1,65 | 0 | 0,044 | 0,988 | 0,993 | 0,990 | 0,473 |
| GREEN | 6 | −3,37 | 0 | 0,111 | 1,000 | 1,000 | 1,000 | 0,590 |
| GREEN | 8 | −0,54 | 0 | 0,200 | 0,733 | 0,667 | 0,838 | 0,722 |
| CHROM | 2 | −∞ | 406 | 0,526 | 0,462 | 0,576 | 0,537 | 0,500 |
| CHROM | 3 | −∞ | 96 | 0,217 | 0,855 | 0,869 | 0,866 | 0,459 |
| CHROM | 4 | 2,86 | 0 | 0,133 | 0,753 | 0,770 | 0,834 | 0,564 |
| CHROM | 6 | −2,38 | 0 | 0,000 | 0,956 | 0,980 | 0,990 | 0,597 |
| CHROM | 8 | −1,67 | 0 | 0,000 | 0,933 | 0,944 | 0,865 | 0,589 |
| POS | 2 | −∞ | 462 | 0,539 | 0,445 | 0,498 | 0,460 | 0,486 |
| POS | 3 | −∞ | 103 | 0,167 | 0,829 | 0,863 | 0,832 | 0,568 |
| POS | 4 | 1,36 | 0 | 0,044 | 0,914 | 0,928 | 0,933 | 0,472 |
| POS | 6 | −1,27 | 0 | 0,111 | 0,911 | 0,961 | 0,962 | 0,541 |
| POS | 8 | −1,49 | 0 | 0,200 | 0,800 | 0,722 | 0,811 | 0,541 |

Ngưỡng −∞: hơn 5% cửa sổ `dev` không chấm được, nên không ngưỡng nào giữ được mức chặn 5%, và
mọi cửa sổ chấm được đều qua.

**Đường nguyên bản**, không mô phỏng board, cho cùng một bức tranh:

| Phương pháp | T (s) | Ngưỡng (dB) | Không chấm được | `test` bị chặn | Giấy lọt | Mặt nạ lọt | Phát lại lọt | AUC giấy |
|---|---|---|---|---|---|---|---|---|
| GREEN | 2 | −∞ | 407 | 0,440 | 0,528 | 0,555 | 0,472 | 0,492 |
| GREEN | 3 | −∞ | 118 | 0,133 | 0,803 | 0,858 | 0,793 | 0,483 |
| GREEN | 4 | −0,31 | 0 | 0,067 | 0,975 | 0,986 | 0,969 | 0,486 |
| GREEN | 6 | 0,30 | 0 | 0,222 | 0,844 | 0,880 | 0,790 | 0,526 |
| GREEN | 8 | −0,41 | 0 | 0,000 | 0,667 | 0,722 | 0,784 | 0,552 |
| CHROM | 2 | −∞ | 399 | 0,480 | 0,438 | 0,590 | 0,543 | 0,516 |
| CHROM | 3 | −∞ | 103 | 0,150 | 0,855 | 0,852 | 0,823 | 0,466 |
| CHROM | 4 | 1,39 | 0 | 0,089 | 0,938 | 0,885 | 0,943 | 0,513 |
| CHROM | 6 | −2,44 | 0 | 0,056 | 0,978 | 0,960 | 0,952 | 0,562 |
| CHROM | 8 | −4,55 | 0 | 0,000 | 1,000 | 1,000 | 1,000 | 0,630 |
| POS | 2 | −∞ | 428 | 0,520 | 0,444 | 0,537 | 0,500 | 0,516 |
| POS | 3 | −∞ | 115 | 0,167 | 0,761 | 0,874 | 0,819 | 0,594 |
| POS | 4 | 2,16 | 0 | 0,067 | 0,889 | 0,928 | 0,885 | 0,501 |
| POS | 6 | −0,95 | 0 | 0,056 | 0,933 | 0,940 | 0,886 | 0,529 |
| POS | 8 | −2,24 | 0 | 0,000 | 0,933 | 0,778 | 0,811 | 0,363 |

Ở T ≤ 6 s, AUC giấy của cả bốn đường nằm trong 0,39–0,61: nguyên bản 0,466–0,594, board 80 px
0,450–0,611, 100 px 0,452–0,597, 120 px 0,394–0,549. Nghĩa là không hơn đoán mò.

**Lần chạy đầu** (`20261009-1613_12923a8`) cũng trượt, nhưng số của nó bỏ đi: 6.269 cửa sổ ở T = 2–3 s
mang SNR +∞ nên tấn công tự lọt, và 63 cửa sổ mang −∞ vì nội suy parabol đẩy đỉnh ra khỏi dải.
Commit `05e3e46e` sửa cả hai. Luật tính cửa sổ không chấm được (KẾ HOẠCH §3) viết **sau** lần chạy
đó, nhưng kết luận trượt không dựa vào luật ấy: ở T = 4 và 6 s không có cửa sổ nào như vậy.

**Vì sao trượt** — năm phép kiểm ngoài giao thức:

1. **Vùng da đặt đúng chỗ.** Vẽ ba vùng lên khung giữa của 3 clip thật và 3 clip tấn công (khoét
   lỗ, mặt nạ giấy 3D, phát lại): cả ba nằm trên trán và hai má. Ảnh không commit (CLAUDE.md §6).
2. **Người thật không cho ra mạch.** Ba phương pháp cùng ra một nhịp (lệch nhau ≤ 3 bpm) ở 4,3%
   cửa sổ 6 s của người thật và 5,5% của tấn công (board 100 px); ở đường nguyên bản là 6,2% và
   6,0%. SNR trung vị của người thật ngang tấn công, và cả hai chỉ nhỉnh hơn **nhiễu trắng thuần**
   đi qua cùng pipeline (board 100 px, dB, khoảng giữa ba phương pháp):

   | T | Nhiễu trắng | Người thật | Giấy | Mặt nạ | Phát lại |
   |---|---|---|---|---|---|
   | 4 s | 4,4–5,6 | 6,6–8,1 | 6,7–9,0 | 7,1–8,0 | 7,0–7,8 |
   | 6 s | 1,2–1,5 | 2,5–4,0 | 2,4–2,8 | 3,0–3,3 | 2,8–3,2 |

3. **Bám mặt mọi khung không làm mạch hiện ra.** Trích lại 29 clip thật ở đường nguyên bản, detector
   chạy ở mọi khung chứ không 270 ms một lần. Ở 6 s, SNR trung vị của POS lên từ 3,0 tới 4,8 dB và
   nhịp trong một clip bớt nhảy (độ lệch chuẩn 14,7 → 6,1 bpm, trên 6 clip đủ dài), nhưng ba phương
   pháp chỉ cùng ra một nhịp ở 2% cửa sổ, so với 6%. Nhịp dò 270 ms có thêm nhiễu, nhưng không phải
   thứ che mất mạch.
4. **Video selfie cầm tay.** Người thật của UniqueData tự quay bằng điện thoại cầm tay, có người
   quay đầu giữa clip. Mã hoá H.264, HEVC, MPEG-4 ở 0,7–39,8 Mbps, trung vị 9,2 Mbps (0,25 bit mỗi
   điểm ảnh mỗi khung): phần lớn không nén nặng. Nghi phạm chính vì thế là chuyển động và khâu xử
   lý ảnh của điện thoại. Không tách được hai thứ đó: bộ này không có ai vừa quay cầm tay vừa đứng
   yên.
5. **2–3 s quá ngắn, kể cả với dữ liệu tốt.** Ở 2 s, khung ±2/T quanh đỉnh và hoạ âm phủ kín dải
   0,75–3 Hz với mọi nhịp từ 60 đến 105 bpm. Chính nhiễu trắng cũng có 49% cửa sổ 2 s và 9–12%
   cửa sổ 3 s không chấm được, khớp với video (49% và 15%). Trong 1–2 s người dùng đứng chấm công,
   SNR phổ không quyết được; mốc ngắn nhất còn đo được là 4 s.
