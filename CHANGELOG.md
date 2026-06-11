# Changelog

Tất cả thay đổi đáng chú ý của dự án sẽ được ghi lại trong file này.

---

## Unreleased / Next (Anti-Detection Initiative + Proxy Providers)

### Proxy Improvements
- **2026-05-28**: Added light but practical support for paid providers (DataImpulse, Smartproxy, etc.) using "mix" approach.
  - New optional `provider` column on proxies table + migration.
  - Auto-detection for DataImpulse sticky sessions (`session-` in username).
  - UI: Provider badge in list, preset selector in Add/Import modals, DataImpulse-specific tips.
  - Kept architecture clean (everything still goes through `ProxyService`).

### Anti-Detection Initiative
- **2026-05-28**: Launched major Anti-Detection & Stealth Improvement Initiative.
- Created comprehensive strategy document `docs/ANTI_DETECTION_STRATEGY.md` (permanent project memory).
- Full audit of FingerprintService, HumanBehavior, AutonomousMapAgent, KpiSkills, review engines, schema, and profile handling.
- Documented 2026 Google review spam threat model (account age, advanced fingerprint, behavioral biometrics, linguistic content analysis, velocity/coordination, Maps-specific signals).
- Defined 4-phase roadmap:
  - Phase 1: CDP stealth + fingerprint depth + behavior primitives
  - Phase 2: Account reputation & gradual warmup system (critical)
  - Phase 3: Per-account writing style + intelligent content generation (critical)
  - Phase 4: Session orchestration, velocity control, return-visitor modeling
- No code changes in this entry — strategy recorded first per project requirements before implementation.

### 📋 Strategy & Architecture
- **2026-05-28**: Launched major Anti-Detection & Stealth Improvement Initiative.
- Created comprehensive strategy document `docs/ANTI_DETECTION_STRATEGY.md` (permanent project memory).
- Full audit of FingerprintService, HumanBehavior, AutonomousMapAgent, KpiSkills, review engines, schema, and profile handling.
- Documented 2026 Google review spam threat model (account age, advanced fingerprint, behavioral biometrics, linguistic content analysis, velocity/coordination, Maps-specific signals).
- Defined 4-phase roadmap:
  - Phase 1: CDP stealth + fingerprint depth + behavior primitives
  - Phase 2: Account reputation & gradual warmup system (critical)
  - Phase 3: Per-account writing style + intelligent content generation (critical)
  - Phase 4: Session orchestration, velocity control, return-visitor modeling
- No code changes in this entry — strategy recorded first per project requirements before implementation.

---

## [1.0.2] - 2026-03-20

### 🐛 Sửa lỗi
- **Nút Dừng chiến dịch:** Trước đây ấn nút "Dừng" chiến dịch Traffic Boost không có tác dụng ngay — trình duyệt vẫn tiếp tục chạy. Bây giờ ấn Dừng sẽ **đóng ngay lập tức** tất cả trình duyệt đang hoạt động và cập nhật giao diện.
- **Nút Tạm dừng chiến dịch:** Tương tự nút Dừng, nút Tạm dừng giờ cũng đóng trình duyệt và cập nhật trạng thái UI ngay lập tức.
- **Khôi phục lỗi build:** Sửa lỗi cú pháp bị hỏng trong `TrafficBoostEngine.ts` khiến app không thể build được.
- **Giao diện bị trắng khi dừng:** Sau khi dừng/tạm dừng chiến dịch, app tự động chuyển về tab "Chiến dịch" thay vì hiển thị màn hình trắng.

### ✨ Cải thiện
- **Cài đặt Ẩn/Hiện trình duyệt:** Tùy chọn "Headless mode" trong Cài đặt giờ hoạt động chính xác — bật ẩn thì trình duyệt sẽ chạy nền, không hiện cửa sổ.
- **Cài đặt liên kết chặt chẽ với app:** Tất cả cài đặt (số luồng đồng thời, chế độ ẩn trình duyệt, v.v.) giờ được áp dụng đúng khi chạy chiến dịch.

---

## [1.0.1] - 2026-03-14

### ✨ Tính năng mới
- **AI Traffic Boost:** Tích hợp AI (local LLM) để duyệt web giống người thật hơn.
- **CAPTCHA Bypass:** Tích hợp công cụ vượt CAPTCHA tự động.
- **Google Analytics Dashboard:** Thêm trang Analytics để theo dõi số liệu từ Google Analytics.

### 🐛 Sửa lỗi
- Các bản sửa lỗi nhỏ và cải thiện ổn định.

---

## [1.0.0] - Bản phát hành đầu tiên

### ✨ Tính năng
- Tự động đánh giá Google Maps
- Traffic Boost với nhiều chiến lược SEO
- Quản lý tài khoản và proxy
- Quản lý địa điểm
- Cài đặt tùy chỉnh đầy đủ
