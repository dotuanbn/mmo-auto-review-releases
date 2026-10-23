# Traffic Concurrency & FProxy Rotation Sync (L3)

Quy tắc bất biến từ **v1.0.18**: **`1 Key = 1 Browser = 1 Visit ứng với 1 IP duy nhất`**, đồng bộ tuyệt đối với bộ đếm xoay IP trên `https://sv1.fproxy.me/`.

## Quy tắc cốt lõi

**Local low-resource mode (sửa 2026-10-23, chưa phát hành):** không giới hạn thêm phiên trình duyệt, luồng hoặc map song song; không thêm RAM wait, launch spacing hay bước chờ reservation trước IP lease. BrowserResourceGovernor chỉ theo dõi vòng đời và cảnh báo RAM. Traffic/Automation và worker nền giữ mức song song vốn có. Giữ nguyên cấu hình concurrency của người dùng, cooldown nghiệp vụ, khóa profile và các quy tắc FProxy bên dưới. Chính sách này thay thế giới hạn một phiên ngày 2026-10-21. Xem `docs/LOW_RESOURCE_MODE.md`.

| Thành phần | Quy tắc |
|------------|---------|
| **1 Key = 1 Browser** | Mỗi FProxy API-key slot chỉ giữ tối đa **1 lease tại một thời điểm** (không chia sẻ 1 key cho nhiều Map/Location cùng lúc). |
| **1 Visit = 1 IP** | Mỗi visit bắt buộc chạy trên 1 IP mới (`observedIp !== runtime.lastUsedIp`). Không bao giờ mở visit thứ 2 trên cùng IP cũ của visit trước. |
| **Hoàn thành KPI sớm** | Khi visit chạy xong KPI trước khi hết thời gian đếm ngược xoay IP (~120s), browser của key đó **đóng ngay** (`recycleVisitContext`), luồng chuyển sang `waiting` (`Chờ xoay IP...`) và **chờ đến khi key xoay sang IP mới** rồi mới mở browser cho visit tiếp theo. |
| **`K` Keys = `K` Browsers độc lập** | Khi chạy `K` keys đồng thời, mỗi luồng `threadIdx` gắn cố định với 1 key riêng (`assignedSlotId`). Mỗi key tự quản lý lượt tắt/bật browser và chu kỳ chờ xoay IP riêng mà không chặn key khác. |

## Cơ chế `FProxyPoolService` (`src/main/services/FProxyPoolService.ts`)

1. **Per-Key Affinity & Non-Blocking Waiter Queue:**
   - `FProxyLeaseRequest.slotId` và `waitForFreshRotation(..., preferredSlotId)` ghim mỗi worker `threadIdx` vào đúng `assignedSlotId = enabledPoolSlots[threadIdx % enabledPoolSlots.length]?.id`.
   - `drainWaiters()` duyệt qua toàn bộ `this.waiters` theo chỉ mục thay vì dừng ở phần tử đầu (`this.waiters[0]`), đảm bảo khi Key 1 đang `cooldown` chờ xoay IP thì Key 2 xoay xong vẫn lấy được lease và mở browser ngay lập tức (không bị head-of-line blocking).

2. **Chống mất bộ đếm Cooldown khi UI tự refresh 30s (`refreshSlot`):**
   - `FProxyRuntimePoolPanel` gọi `refreshAll()` mỗi 30 giây (`getCurrent`).
   - API `getCurrent` của FProxy thường mirror `waiting_time == time_die` (~1800s), được `resolveFProxyDeadlines()` sanitize thành `rotateAllowedAt = Date.now()`.
   - Khi slot đang ở trạng thái `cooldown` giữa 2 visit (`runtime.lease === null` nhưng `runtime.endpoint !== null`), `refreshSlot()` chỉ cập nhật in-place `endpointExpiresAt`, **không bao giờ** ghi đè `rotateAllowedAt` đang đếm ngược về `Date.now()` và **không bao giờ** xóa `rotationPending`.
   - Cờ `seededByRefresh = true` đánh dấu các slot chỉ mới được `getCurrent` khởi tạo thụ động để Visit đầu tiên luôn gọi `fetchInitialEndpoint` (`getNew`) lấy đúng `waiting_time` thực của server.

3. **Xác thực IP mới & Xử lý phản hồi Cooldown thực tế của FProxy (`FProxyApiClient` + `ensureLeaseEndpoint`):**
   - Payload thực tế của `sv1.fproxy.me` không trả trường `data.ip` riêng mà đặt IP dân cư trong host của `httpuserpass` (`<ip>:<port>:<user>:<pass>`). `buildEndpoint()` tự động fallback `observedIp` sang `normalizeObservedIp(proxySnapshot.host)`.
   - Khi gọi `getNew` lúc server chưa hết thời gian chờ xoay, FProxy trả về:
     - `{"success":true,"message":"Vui lòng chờ 65 giây","data":{"httpuserpass":"<IP_CŨ>:...","waiting_time":"65","time_die":"1745"}}` (`endpoint.coolingDown = true`), hoặc
     - `{"success":false,"message":"WAITING","data":{"httpuserpass":"","waiting_time":"0"}}` (`FProxyApiError('provider_rejected', retryable=true)`).
   - Trong `ensureLeaseEndpoint()`, khi `forceFreshIp` (`rotate_per_visit && rotationPending`):
     - Nếu `observedIp === runtime.lastUsedIp` hoặc `endpoint.coolingDown === true` hoặc gặp `provider_rejected` retryable, slot cập nhật lại `rotateAllowedAt` theo số giây server báo, giữ `rotationPending = true` và trả về `null` để tiếp tục chờ đến khi server thực sự cấp IP mới.

## Thread Clamp & Vòng đời Browser (`TrafficBoostEngine.ts`)

```text
configuredMaxBrowsers = settings.maxConcurrentBrowsers ?? 3
maxGlobalBrowsers = fproxyPoolEnabled
  ? Math.max(configuredMaxBrowsers, Math.min(10, enabledPoolSlotCount))
  : configuredMaxBrowsers
safeThreadCount = Math.min(maxGlobalBrowsers, Math.max(1, campaign.threadsCount))
if (fproxyPoolEnabled):
  safeThreadCount = Math.min(safeThreadCount, enabledPoolSlotCount) // Strict 1 Key = 1 Browser
```

- Trước khi mở trình duyệt, luồng giữ trạng thái `status = 'waiting'` (`Chờ xoay IP...`) trong suốt `waitForFreshRotation()` và `fproxyPoolService.acquire()`.
- Bộ đếm `waitTicker` đọc trực tiếp snapshot của `assignedSlotId` mỗi giây để đồng bộ thời gian chờ thực tế từ server lên giao diện.
- Chỉ sau khi `fproxyLease` đã nhận được IP mới, luồng mới chuyển sang `status = 'visiting'` (`Opening browser...`) và gọi `browserService.createContext` / `createEphemeralContext`.
- Khi visit hoàn thành KPI (kể cả hoàn thành sớm) hoặc gặp lỗi/timeout, `recycleVisitContext()` đóng trình duyệt trước rồi gọi `fproxyLease.release()`, chuyển key sang `cooldown` chờ chu kỳ xoay IP kế tiếp.

Related: `src/main/services/FProxyApiClient.ts`, `src/main/services/FProxyPoolService.ts`, `src/main/services/FProxyService.ts`, `src/main/automation/TrafficBoostEngine.ts`, `src/renderer/src/components/proxy/FProxyRuntimePoolPanel.tsx`, `tests/TrafficBoostMultiMapConcurrency.test.ts`, `tests/FProxyPoolService.test.ts`.
