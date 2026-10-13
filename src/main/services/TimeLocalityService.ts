/**
 * Local-time review windows.
 *
 * Location addresses are matched to an IANA timezone. Night hours wait for the
 * next golden window; peak hours are preferred but daytime outside those windows
 * is still allowed. Conversion uses Intl only (no timezone library).
 */

const MS_PER_MINUTE = 60_000

/** Default ±30 minutes. Spreads scheduled wakes off the exact window boundary. */
export const DEFAULT_HUMAN_JITTER_MS = 30 * MS_PER_MINUTE

/**
 * Most locations in this product are Vietnam-based.
 * Used when the address is missing or has no known region keyword.
 */
export const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh'

/**
 * Country and city keywords → IANA zone.
 * Insertion order is match priority: the first keyword contained in the address wins.
 * Every listed US city maps to America/New_York (product default, not the city's real zone).
 * Melbourne maps to Australia/Sydney for the same reason.
 */
const TIMEZONE_RULES: ReadonlyArray<readonly [string, string]> = [
    ['vietnam', 'Asia/Ho_Chi_Minh'],
    ['việt nam', 'Asia/Ho_Chi_Minh'],
    ['viet nam', 'Asia/Ho_Chi_Minh'],
    ['ho chi minh', 'Asia/Ho_Chi_Minh'],
    ['hanoi', 'Asia/Ho_Chi_Minh'],
    ['hà nội', 'Asia/Ho_Chi_Minh'],
    ['thailand', 'Asia/Bangkok'],
    ['bangkok', 'Asia/Bangkok'],
    ['japan', 'Asia/Tokyo'],
    ['tokyo', 'Asia/Tokyo'],
    ['osaka', 'Asia/Tokyo'],
    ['korea', 'Asia/Seoul'],
    ['seoul', 'Asia/Seoul'],
    ['singapore', 'Asia/Singapore'],
    ['malaysia', 'Asia/Kuala_Lumpur'],
    ['kuala lumpur', 'Asia/Kuala_Lumpur'],
    ['indonesia', 'Asia/Jakarta'],
    ['jakarta', 'Asia/Jakarta'],
    ['philippines', 'Asia/Manila'],
    ['manila', 'Asia/Manila'],
    ['taiwan', 'Asia/Taipei'],
    ['taipei', 'Asia/Taipei'],
    ['australia', 'Australia/Sydney'],
    ['sydney', 'Australia/Sydney'],
    ['melbourne', 'Australia/Sydney'],
    ['united states', 'America/New_York'],
    ['new york', 'America/New_York'],
    ['los angeles', 'America/New_York'],
    ['chicago', 'America/New_York'],
    ['united kingdom', 'Europe/London'],
    ['london', 'Europe/London'],
    ['germany', 'Europe/Berlin'],
    ['berlin', 'Europe/Berlin'],
    ['france', 'Europe/Paris'],
    ['paris', 'Europe/Paris'],
]

export const TIMEZONE_MAP: Map<string, string> = new Map(
    TIMEZONE_RULES.map(([keyword, timezone]) => [keyword.toLowerCase(), timezone]),
)

export interface ReviewWindowDecision {
    allowed: boolean
    reason: string
    localHour: number
    timezone: string
    waitMs?: number
}

interface ZonedDateTime {
    year: number
    month: number
    day: number
    hour: number
    minute: number
    second: number
    millisecond: number
}

function resolveNow(now: Date | undefined, label: string): Date {
    if (now == null) return new Date()
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error(`${label}: invalid now date`)
    }
    return now
}

function assertTimezone(timezone: string, label: string): void {
    if (typeof timezone !== 'string' || timezone.trim() === '') {
        throw new Error(`${label}: timezone must be a non-empty IANA name`)
    }
}

function readFormatPart(
    parts: readonly Intl.DateTimeFormatPart[],
    type: Intl.DateTimeFormatPartTypes,
    timezone: string,
): number {
    const part = parts.find((item) => item.type === type)
    if (!part) {
        throw new Error(`${timezone}: missing ${type} from Intl.DateTimeFormat`)
    }
    const value = Number(part.value)
    if (!Number.isFinite(value)) {
        throw new Error(`${timezone}: invalid ${type} "${part.value}"`)
    }
    return value
}

/** Wall-clock parts in `timeZone`. Hour 24 (midnight ICU quirk) is normalized to 0. */
function getZonedDateTime(instant: Date, timeZone: string): ZonedDateTime {
    let parts: Intl.DateTimeFormatPart[]
    try {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        }).formatToParts(instant)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`invalid timezone ${timeZone}: ${message}`)
    }

    const hour = readFormatPart(parts, 'hour', timeZone)
    return {
        year: readFormatPart(parts, 'year', timeZone),
        month: readFormatPart(parts, 'month', timeZone),
        day: readFormatPart(parts, 'day', timeZone),
        hour: hour === 24 ? 0 : hour,
        minute: readFormatPart(parts, 'minute', timeZone),
        second: readFormatPart(parts, 'second', timeZone),
        millisecond: instant.getUTCMilliseconds(),
    }
}

/**
 * Offset such that local-as-UTC = instant + offset.
 * UTC instant of a wall time is therefore localAsUtc - offset.
 */
function getTimeZoneOffsetMs(instant: Date, timeZone: string): number {
    const zoned = getZonedDateTime(instant, timeZone)
    const localAsUtc = Date.UTC(
        zoned.year,
        zoned.month - 1,
        zoned.day,
        zoned.hour,
        zoned.minute,
        zoned.second,
        zoned.millisecond,
    )
    return localAsUtc - instant.getTime()
}

function zonedLocalToUtcMs(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    millisecond: number,
    timeZone: string,
): number {
    const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
    const firstOffset = getTimeZoneOffsetMs(new Date(localAsUtc), timeZone)
    const firstUtc = localAsUtc - firstOffset
    const secondOffset = getTimeZoneOffsetMs(new Date(firstUtc), timeZone)
    if (secondOffset === firstOffset) return firstUtc
    return localAsUtc - secondOffset
}

function shiftCalendarDay(
    year: number,
    month: number,
    day: number,
    days: number,
): { year: number; month: number; day: number } {
    const shifted = new Date(Date.UTC(year, month - 1, day + days))
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
    }
}

/**
 * First TIMEZONE_MAP keyword contained in the address, else DEFAULT_TIMEZONE.
 * Matching is case-insensitive. Whitespace is collapsed so wrapped addresses still hit.
 */
export function inferTimezone(address: string | null | undefined): string {
    if (typeof address !== 'string') return DEFAULT_TIMEZONE
    const normalized = address.toLowerCase().replace(/\s+/g, ' ').trim()
    if (normalized.length === 0) return DEFAULT_TIMEZONE

    // forEach keeps Map insertion order without downlevelIteration (tsconfig.node target).
    let match: string | undefined
    TIMEZONE_MAP.forEach((timezone, keyword) => {
        if (match !== undefined) return
        if (keyword.length > 0 && normalized.includes(keyword)) match = timezone
    })
    return match ?? DEFAULT_TIMEZONE
}

/** Clock hour 0–23 in `timezone`. */
export function getLocalHour(timezone: string, now?: Date): number {
    assertTimezone(timezone, 'getLocalHour')
    const instant = resolveNow(now, 'getLocalHour')
    const zoned = getZonedDateTime(instant, timezone)
    if (!Number.isInteger(zoned.hour) || zoned.hour < 0 || zoned.hour > 23) {
        throw new Error(`getLocalHour: hour ${String(zoned.hour)} out of range for ${timezone}`)
    }
    return zoned.hour
}

/** Peak review hours: 10–14 and 18–21 inclusive. */
export function isGoldenHour(localHour: number): boolean {
    if (!Number.isFinite(localHour)) return false
    return (localHour >= 10 && localHour <= 14) || (localHour >= 18 && localHour <= 21)
}

/** Local night: 0–6 and 23 inclusive. */
export function isNightTime(localHour: number): boolean {
    if (!Number.isFinite(localHour)) return false
    return (localHour >= 0 && localHour <= 6) || (localHour >= 23 && localHour <= 23)
}

/**
 * Milliseconds until the next golden window *starts* (10:00 or 18:00 local).
 * Inside a window this is the following start, not zero — callers that want
 * "review now" should check isGoldenHour first.
 */
export function getNextGoldenHourMs(timezone: string, now?: Date): number {
    assertTimezone(timezone, 'getNextGoldenHourMs')
    const instant = resolveNow(now, 'getNextGoldenHourMs')
    const zoned = getZonedDateTime(instant, timezone)
    const minuteOfDay = zoned.hour * 60
        + zoned.minute
        + (zoned.second + zoned.millisecond / 1000) / 60

    const morningStart = 10 * 60
    const eveningStart = 18 * 60
    let targetHour = 10
    let dayOffset = 0
    if (minuteOfDay < morningStart) {
        targetHour = 10
    } else if (minuteOfDay < eveningStart) {
        targetHour = 18
    } else {
        targetHour = 10
        dayOffset = 1
    }

    const targetDay = dayOffset === 0
        ? { year: zoned.year, month: zoned.month, day: zoned.day }
        : shiftCalendarDay(zoned.year, zoned.month, zoned.day, dayOffset)

    const targetUtc = zonedLocalToUtcMs(
        targetDay.year,
        targetDay.month,
        targetDay.day,
        targetHour,
        0,
        0,
        0,
        timezone,
    )
    const waitMs = targetUtc - instant.getTime()
    if (!Number.isFinite(waitMs)) {
        throw new Error(`getNextGoldenHourMs: non-finite wait for ${timezone}`)
    }
    return Math.max(0, Math.round(waitMs))
}

/**
 * baseMs plus a uniform offset in [-maxJitterMs, +maxJitterMs].
 * Default span is ±30 minutes. The result may be negative when baseMs is small;
 * delay callers clamp to zero.
 */
export function addHumanJitter(baseMs: number, maxJitterMs: number = DEFAULT_HUMAN_JITTER_MS): number {
    if (!Number.isFinite(baseMs)) {
        throw new Error(`addHumanJitter: baseMs must be a finite number (${String(baseMs)})`)
    }
    if (!Number.isFinite(maxJitterMs)) {
        throw new Error(`addHumanJitter: maxJitterMs must be a finite number (${String(maxJitterMs)})`)
    }
    const jitterCap = Math.max(0, maxJitterMs)
    const offset = (Math.random() * 2 - 1) * jitterCap
    return Math.round(baseMs + offset)
}

function delayUntilNextGoldenMs(timezone: string, now: Date): number {
    return Math.max(0, addHumanJitter(getNextGoldenHourMs(timezone, now)))
}

export class TimeLocalityService {
    /**
     * Night blocks the review and reports a jittered wait until the next golden start.
     * Golden hours are allowed as the peak window. Other daytime hours are allowed
     * but are not optimal (see getOptimalDelay).
     */
    shouldReviewNow(address: string | null | undefined, now?: Date): ReviewWindowDecision {
        const instant = resolveNow(now, 'shouldReviewNow')
        const timezone = inferTimezone(address)
        const localHour = getLocalHour(timezone, instant)

        if (isNightTime(localHour)) {
            const waitMs = delayUntilNextGoldenMs(timezone, instant)
            return {
                allowed: false,
                reason: `Night time at local hour ${localHour} in ${timezone}`,
                localHour,
                timezone,
                waitMs,
            }
        }

        if (isGoldenHour(localHour)) {
            return {
                allowed: true,
                reason: `Golden hour at local hour ${localHour} in ${timezone}`,
                localHour,
                timezone,
            }
        }

        return {
            allowed: true,
            reason: `Acceptable hour at local hour ${localHour} in ${timezone}, outside peak golden windows`,
            localHour,
            timezone,
        }
    }

    /**
     * 0 during a golden hour. Otherwise milliseconds until the next golden start, with jitter.
     */
    getOptimalDelay(address: string | null | undefined, now?: Date): number {
        const instant = resolveNow(now, 'getOptimalDelay')
        const timezone = inferTimezone(address)
        const localHour = getLocalHour(timezone, instant)
        if (isGoldenHour(localHour)) return 0
        return delayUntilNextGoldenMs(timezone, instant)
    }
}

export const timeLocalityService = new TimeLocalityService()
