# MMO Auto Review - AI Login & Check All Update Handoff

Updated: 2026-03-16
Status: Needs further refinement
Audience: Takeover Devs

## 1. Tính năng AI Auto Login (Mới)
**Mục tiêu:** Cho phép AI tự động điều khiển trình duyệt (qua Ollama + Playwright) để login Google Account, tự động điền email, mật khẩu và xử lý các bước recovery/2FA nếu có.
**File cốt lõi:**
- `src/main/automation/AgenticLoginHandler.ts`: Chứa logic trích xuất DOM, gửi cho Ollama LLM phân tích, parse JSON action (click, type, done) và thực thi trên Playwright.
- `src/main/automation/agentSchemas.ts`: Schema JSON cho logic login.
- `src/main/ipc/accounts.ts`: Các hàm `accounts:testLogin` và `accounts:loginVisible` đã được trỏ qua dùng `AgenticLoginHandler.ts` khi `loginType === 'auto'`.

**Cấu hình hiện tại:**
- Hiện tại `accounts:testLogin` đã được đổi sang `headless: false` (hiển thị UI trình duyệt) để người dùng có thể can thiệp nếu AI bị kẹt.

## 2. Tính năng Kiểm tra tất cả (Check All)
**Tình trạng cũ:** Chạy vòng lặp ngầm trên backend, user không thấy được browser và không biết tiến độ từng tài khoản.
**Tình trạng mới cập nhật:** 
- Đã được dời vòng lặp ra ngoài Frontend (`src/renderer/src/pages/Accounts.tsx` - hàm `handleCheckAll`).
- Thay vì gọi API tổng, Frontend sẽ lặp qua từng account `pending` và gọi `electronAPI.accounts.testLogin`.
- Kết quả: Có indicator tiến trình (loading -> success/failed) cho từng account trên UI, và browser bật lên hiển thị AI đang login cho từng acc.

## 3. Vấn đề còn tồn đọng cần fix (Next Steps cho Dev)
- **Tối ưu AI Login:** AI (Ollama LLM) đôi khi phản hồi chậm hoặc phân tích DOM không chính xác 100%, dẫn đến nhập sai form hoặc kẹt ở các màn hình lạ. Cần tinh chỉnh Prompt trong `AgenticLoginHandler.ts`.
- **Luồng 2FA / Login thủ công kết hợp:** Cần thiết kế giao diện cho phép user nhập mã 2FA trực tiếp trên UI app hoặc trên cửa sổ trình duyệt an toàn hơn.
- **Lỗi Foreign Key:** Đã fix lỗi xoá tài khoản (update `AccountService.delete` xoá history/traffic_logs trước), nhưng cần test kỹ lại các tác động phụ.
- **Tiến trình "Kiểm tra tất cả" bị khựng (Freeze UI):** Do vòng lặp chờ `testLogin` có thể kéo dài nếu AI xử lý chậm. Có thể cân nhắc chạy background job + gửi event IPC progress thay vì await trực tiếp ở frontend loop nếu số lượng acc quá lớn.

---
End of Handoff
