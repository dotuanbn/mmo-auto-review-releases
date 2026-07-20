/** Schedule repeat types supported by SchedulerService / IPC. */
export type ScheduleRepeatType = 'once' | 'daily' | 'weekly' | 'custom'

/** Weekday index matching JS Date.getDay(): 0 = Sunday … 6 = Saturday. */
export type WeekdayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** Create payload for scheduler:create (IPC coerces scheduledAt/endDate to Date). */
export interface ScheduleCreateConfig {
    campaignId: number
    scheduledAt: string
    repeatType: ScheduleRepeatType
    repeatDays?: number[]
    endDate?: string
    isActive: boolean
}

/** Partial update payload for scheduler:update. */
export interface ScheduleUpdateConfig {
    scheduledAt?: string
    repeatType?: ScheduleRepeatType
    repeatDays?: number[]
    endDate?: string | null
    isActive?: boolean
}

/** Normalized schedule row from scheduler:getForCampaign / getAll. */
export interface CampaignSchedule {
    id: number
    campaignId: number
    scheduledAt: string
    repeatType: ScheduleRepeatType
    /** Parsed from JSON string stored in DB. */
    repeatDays: number[] | null
    endDate: string | null
    lastRunAt: string | null
    nextRunAt: string | null
    isActive: boolean
    createdAt: string | null
}

export interface ScheduleMutationResult {
    success: boolean
    id?: number
    isActive?: boolean
    error?: string
}

export const REPEAT_TYPES: readonly ScheduleRepeatType[] = [
    'once',
    'daily',
    'weekly',
    'custom',
] as const

export const WEEKDAY_LABELS: ReadonlyArray<{ value: WeekdayIndex; key: string; fallback: string }> = [
    { value: 0, key: 'scheduler.weekdaySun', fallback: 'Sun' },
    { value: 1, key: 'scheduler.weekdayMon', fallback: 'Mon' },
    { value: 2, key: 'scheduler.weekdayTue', fallback: 'Tue' },
    { value: 3, key: 'scheduler.weekdayWed', fallback: 'Wed' },
    { value: 4, key: 'scheduler.weekdayThu', fallback: 'Thu' },
    { value: 5, key: 'scheduler.weekdayFri', fallback: 'Fri' },
    { value: 6, key: 'scheduler.weekdaySat', fallback: 'Sat' },
]
