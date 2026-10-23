# Chế độ tiết kiệm tài nguyên

Trong Cài đặt → Hiệu năng & máy cấu hình thấp, bật **Chế độ tiết kiệm tài nguyên**, rồi bấm **Lưu cài đặt**. Mặc định tắt. Chính sách sửa ngày 23/10/2026 theo yêu cầu người dùng: tối ưu phần phụ trợ, giữ nguyên mức chạy song song đã cấu hình.

## Cách hoạt động

- Không áp thêm giới hạn số phiên trình duyệt, số luồng hoặc số map hoạt động song song. Traffic và Automation dùng cấu hình hiện có của người dùng.
- Không giãn lần cấp phiên, không có hàng chờ RAM và không hoãn lượt mới do công tắc tiết kiệm. Cấu hình khoảng nghỉ nghiệp vụ, proxy/IP, khóa profile và giới hạn đã chọn trong Cài đặt vẫn giữ nguyên.
- Dưới 768 MB RAM trống chỉ hiện cảnh báo; từ 1280 MB trở lên xóa cảnh báo để tránh nhấp nháy. Không dùng cảnh báo này để chặn công việc.
- BrowserResourceGovernor chỉ đếm phiên đang mở/khởi động và kiểm tra hủy; không còn bộ lập lịch admission. Snapshot giữ `maxContexts: null`, `queuedLaunches: 0` để tương thích IPC, không đại diện cho hàng đợi nghiệp vụ hay proxy.
- Vùng render tối đa 1280×720. Đồng bộ kích thước màn hình trong fingerprint, giữ đầy đủ ảnh, bản đồ, JavaScript và các yêu cầu mạng.
- Chrome dùng chung không có phiên hoạt động được đóng sau 30 giây. Khi chuyển sang phiên profile riêng, thu hồi Chrome dùng chung đang nhàn rỗi trước. Profile đăng nhập của người dùng được giữ nguyên.
- Warmup, xác minh review và Helpful Vote không bị hoãn hoặc giảm mức song song do công tắc tiết kiệm. Các quy tắc tài khoản, lịch và tốc độ nghiệp vụ vốn có vẫn áp dụng.
- Laya cục bộ chỉ khởi động khi RAM trống từ 2 GB; thiếu RAM dùng chính cơ chế dự phòng hiện có. Giới hạn thư viện tính toán còn 1 luồng và tắt model sau 60 giây không suy luận, không ngắt yêu cầu đang xử lý. Kiểm tra sức khỏe thụ động không giữ model trong RAM.
- Giảm hiệu ứng trang trí và tải giao diện theo trang. Hoãn polling/nhật ký monitor khi cửa sổ ẩn; bộ đệm sự kiện và số nhật ký hiển thị có giới hạn. Nhật ký bền vững không bị xóa.

## Kiểm chứng

`npm run test:run` kiểm tra cấp nhiều phiên ngay cả khi thiếu RAM, bật/tắt không giảm luồng, hủy/lỗi không rò tài nguyên, dọn Chrome không ngắt phiên song song, rollback DB và vòng lặp 24 giờ **mô phỏng**. Đây không phải thời gian chạy thật.

`npm run smoke:performance -- --minutes=3 --parallel=3 --cpu-throttle=4 --executable="<đường dẫn EXE>"` mở app đóng gói với userData thử trong thư mục tạm, thử lưu công tắc/reload/tắt lại, giữ 3 phiên Chrome thật song song qua BrowserService (profile riêng + ephemeral), hủy lần mở đã bị dừng và xác nhận thu hồi nhàn rỗi. Thay `--parallel` theo tải cần thử. RAM 8 GB với 500/1700 MB trống chỉ là dữ liệu tiêm để chứng minh không chặn lượt; không chiếm RAM thật của máy. Giảm tốc CPU qua CDP không tương đương hoàn toàn CPU i3-2130.

Chạy dài hơn với `--minutes=480` (8 giờ) hoặc `--minutes=1440` (24 giờ). Báo cáo và ảnh nằm ở `output/performance-soak/<run>/`. Phải xem `ok`, `status`, `completedAt`, các gate và sample thực tế trước khi kết luận pass.

Số luồng thực tế do người dùng chọn; chế độ tiết kiệm không hạ số luồng thay người dùng. Theo dõi RAM trống và đóng ứng dụng không cần thiết. Tối ưu phụ trợ không tạo thêm RAM/CPU: khi tải website vượt sức máy, vẫn có thể chậm hoặc hết bộ nhớ. Không thể bảo đảm mượt cả ngày cho mọi số luồng khi chưa kiểm thử trên máy đích.

## Phát hành

Đây là thay đổi local, chưa publish OTA. Không hạ gate ký Authenticode. CI release phải kiểm tra tag trùng `package.json`; kiểm tra đường dẫn smoke dùng đường dẫn thật của các ancestor để hỗ trợ Windows alias và từ chối junction thoát ra dữ liệu thật.

Các bộ cài/báo cáo ngày 21/10/2026 dùng chính sách cũ giới hạn một phiên, không phải bằng chứng cho chính sách song song mới. Không dùng bộ cài cũ để đánh giá thay đổi ngày 23/10/2026.

## Kết quả local ngày 23/10/2026

- Typecheck main/renderer, lint và Vite build: đạt. Toàn bộ 71 file kiểm thử: 1065 đạt, 0 lỗi, 1 trường hợp POSIX bỏ qua trên Windows. Báo cáo `output/performance-parallel-unit-20261023.json`.
- Smoke test bản đóng gói: 25/25 đạt, không có lỗi page/console; lưu công tắc không ghi đè số luồng người dùng.
- Bài tải ngắn: 153 vòng, mỗi vòng 3 phiên Chrome thật song song, gồm profile riêng và ephemeral; cả 7 gate đạt. Báo cáo `output/performance-soak/2026-10-23T01-40-04-624Z/result.json`.
- Máy thử thực tế là i7/16 GB, chỉ giả lập dữ liệu RAM 8 GB và giảm tốc CPU qua CDP. Đây không phải bằng chứng chạy cả ngày trên i3. Số RAM trong báo cáo Electron không gồm Chrome ngoài tiến trình.
- Lần thử đầu có lỗi Chrome thoát lúc khởi động, được giữ ở `output/performance-soak/2026-10-23T01-36-42-186Z/result.json`; các probe Chrome riêng và lần soak kèm log sau đó đều đạt. Nguyên nhân chưa xác định; không coi lần thử sau là chứng minh đã sửa lỗi khởi động.
- Bộ cài mới: `output/performance-parallel-20261023/MMO-Auto-Review-Setup-1.0.18.exe`. Đây là bản local chưa ký số, chưa publish OTA và chưa thử cài đặt/nâng cấp NSIS; không tự cài đè ứng dụng đang dùng.
