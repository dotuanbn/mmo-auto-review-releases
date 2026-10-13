# Traffic Concurrency (L3)

Một FProxy API-key slot có thể chạy **nhiều browser song song** khi mỗi browser nhắm **map (locationId) khác nhau**. Cùng một map thì **chỉ 1 browser** (same-map mutual exclusion).

## Quy tắc

| Setup | Hành vi |
|-------|---------|
| 1 key + N maps (N>1) | N browser song song, cùng IP/endpoint của slot đó |
| 1 key + 1 map | 1 browser; thread thừa chờ FIFO |
| N keys + maps | Fair rank: slot rảnh → least-recently-leased; strict unique IP **giữa các slot** |
| `web_seo` | Không share theo map; clamp threads theo enabled slots **và** số account usable |

`mapsMultiIpTraffic = campaign.trafficMode !== 'web_seo'`. Maps (direct / organic / map_search) dùng ephemeral Playwright context, không ôm profile lock — nên 1 account vẫn chạy đa IP/map.

## SlotRuntime lease sharing

`FProxyPoolService` (`src/main/services/FProxyPoolService.ts`):

- `SlotRuntime.leases: Map<string, LeaseRecord>` — nhiều lease / slot. Getter `lease` = lease đầu (tương thích API cũ).
- `canShareSlot(runtime, locationId, minRemainingMs, now)`:
  - `locationId` phải là number
  - slot đã có lease
  - **chưa** có lease cho cùng `locationId` (`hasLeaseForLocation`)
  - endpoint còn `endpointExpiresAt - now >= minRemainingMs`
- Acquire: ưu tiên share slot đang leased cho location mới; nếu không, lấy slot idle hết cooldown rồi `prepareLease` (getnew nếu `rotationPending`).
- `commitLease`: lease đầu tiên publish endpoint/generation; lease thêm **reuse** endpoint, không bump generation — holder cũ giữ IP ổn định.
- `releaseLease`: xóa 1 record. Còn lease khác → **không** rotate. Lease cuối + policy `rotate_per_visit` → `rotationPending=true`, `stickyOwnerId=null`.
- Owner DTO: `{ kind: 'traffic_visit' \| 'automation_job', id, threadId, locationId? }`. Public snapshot có `activeLocationIds`, không có raw key.
- Strict unique: collision check **giữa slots** (endpointKey / observedIp). Share trong **một** slot là cố ý (cùng IP, khác map).

Wait path: `waitForFreshRotation` coi slot leased là candidate nếu `canShareLeasedSlot` (location khác). Visit budget bám **rotate window ~2 min**, không bám `time_die` ~30 min.

## Same-map mutual exclusion

Hai lớp, bổ sung nhau:

1. **Proxy**: `hasLeaseForLocation` chặn share slot cho cùng `locationId`.
2. **Queue**: `TrafficVisitQueue.claimNextVisit(..., { disallowRunningLocations: mapsMultiIpTraffic })` thu `locationId` của visit `running` trong campaign rồi skip candidate cùng map.

Worker không claim được → idle-poll 120ms (tối đa 20 lần nếu không còn in-flight) rồi thoát wave.

## TrafficVisitQueue

Durable per-visit (`traffic_visit_queue`, unique `campaignId+visitIndex`).

- Status: `pending` | `retry` | `running` | `done` | `failed` | `cancelled`. Claimable = pending/retry. Terminal = done/failed/cancelled.
- `claimNextVisit` atomic dưới mutex (`runExclusive`): persist trước return; persist fail → rollback memory.
- Lease mặc định 5 phút; hết hạn → `recoverExpiredLeases` (boot/mỗi wave). Max 3 attempts, backoff mũ (base 5s).
- Seed theo `visitIndex`; claim sort `visitIndex` rồi `createdAt`.
- Engine: `PQueue` concurrency = `safeThreadCount`; mỗi thread loop claim → chạy visit → complete/fail.

## Thread clamp (`safeThreadCount`)

```
base = min(settings.maxConcurrentBrowsers ?? 3, campaign.threadsCount)
if strict FProxy pool:
  multi-map maps: min(base, locations.length * enabledSlots)   // 1 key × 3 maps → 3
  single-map / web_seo: min(base, enabledSlots)
if web_seo && usableAccounts > 0: min(..., usableAccounts)
```

Thread start stagger theo `SystemResourceDetector` để tránh spike RAM.

## Dual-timer FProxy (không nhầm)

| Provider | UI | Internal | Ý nghĩa |
|----------|----|----------|---------|
| `waiting_time` | Xoay IP con | `rotateAllowedAt` / `nextRotateAt` | Countdown xoay ~0–120s |
| `time_die` | IP con | `endpointExpiresAt` / `ipExpiresAt` | Tuổi IP ~30 phút |

`getcurrent` thường mirror `waiting_time == time_die`; `getnew` mới ra rotate thật. `resolveFProxyDeadlines` sanitize mirror; visit wait theo rotate, không theo IP life.

## UI — `FProxyCapacityNotice` (5 kịch bản)

1. 1 map + threads>1 + capacity=1 → amber: multi-thread cùng map sẽ xếp hàng
2. 1 map + 1 thread → emerald: sẵn sàng
3. N maps + 1 thread → info: tuần tự từng map
4. N maps + 1<threads≤maps → emerald parallel (+ notice nếu maps>threads)
5. N maps + threads>maps → amber: thread thừa không chạy cùng map

Fallback: không chọn map → capacityWarning / capacityReady theo `waiting`.

## Close / rotate order

Context close → `lease.release()`. Slot chỉ `getnew` khi **lease cuối** rời và `rotate_per_visit`. Extra threads chờ waiter FIFO (`DEFAULT_ACQUIRE_TIMEOUT_MS=120s`).

Related: `FProxyPoolService.ts`, `TrafficBoostEngine.ts` (concurrency plan ~L2686–2984), `TrafficVisitQueue.ts`, `tests/TrafficBoostMultiMapConcurrency.test.ts`, `tests/TrafficVisitQueue.test.ts`, `tests/FProxyPoolService.test.ts`.
