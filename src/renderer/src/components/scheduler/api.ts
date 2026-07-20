import type {
    CampaignSchedule,
    ScheduleCreateConfig,
    ScheduleMutationResult,
    ScheduleRepeatType,
    ScheduleUpdateConfig,
} from './types'
import { REPEAT_TYPES } from './types'

interface SchedulerApi {
    create: (config: ScheduleCreateConfig) => Promise<ScheduleMutationResult>
    update: (id: number, config: ScheduleUpdateConfig) => Promise<ScheduleMutationResult>
    delete: (id: number) => Promise<ScheduleMutationResult>
    getForCampaign: (campaignId: number) => Promise<unknown>
    getAll: () => Promise<unknown>
    toggle: (id: number) => Promise<ScheduleMutationResult>
}

interface ElectronApiWithScheduler {
    scheduler?: SchedulerApi
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null
    }
    return value as Record<string, unknown>
}

function asNumber(value: unknown, fallback = 0): number {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? n : fallback
}

function asBoolean(value: unknown, fallback = false): boolean {
    if (typeof value === 'boolean') {
        return value
    }
    if (value === 1 || value === '1' || value === 'true') {
        return true
    }
    if (value === 0 || value === '0' || value === 'false') {
        return false
    }
    return fallback
}

function asDateString(value: unknown): string | null {
    if (value == null) {
        return null
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString()
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        const d = new Date(value)
        return Number.isNaN(d.getTime()) ? null : d.toISOString()
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        const d = new Date(value)
        return Number.isNaN(d.getTime()) ? value : d.toISOString()
    }
    return null
}

function parseRepeatType(value: unknown): ScheduleRepeatType {
    if (typeof value === 'string' && (REPEAT_TYPES as readonly string[]).includes(value)) {
        return value as ScheduleRepeatType
    }
    return 'once'
}

function parseRepeatDays(value: unknown): number[] | null {
    if (value == null) {
        return null
    }
    if (Array.isArray(value)) {
        const days = value
            .map((item) => (typeof item === 'number' ? item : Number(item)))
            .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
        return days.length > 0 ? days : null
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        try {
            const parsed: unknown = JSON.parse(value)
            return parseRepeatDays(parsed)
        } catch {
            return null
        }
    }
    return null
}

export function normalizeSchedule(raw: unknown): CampaignSchedule | null {
    const record = asRecord(raw)
    if (!record) {
        return null
    }

    const id = asNumber(record.id, -1)
    const campaignId = asNumber(record.campaignId, -1)
    if (id < 0 || campaignId < 0) {
        return null
    }

    const scheduledAt = asDateString(record.scheduledAt)
    if (!scheduledAt) {
        return null
    }

    return {
        id,
        campaignId,
        scheduledAt,
        repeatType: parseRepeatType(record.repeatType),
        repeatDays: parseRepeatDays(record.repeatDays),
        endDate: asDateString(record.endDate),
        lastRunAt: asDateString(record.lastRunAt),
        nextRunAt: asDateString(record.nextRunAt),
        isActive: asBoolean(record.isActive, false),
        createdAt: asDateString(record.createdAt),
    }
}

export function getSchedulerApi(): SchedulerApi | null {
    if (typeof window === 'undefined') {
        return null
    }
    const api = (window as Window & { electronAPI?: ElectronApiWithScheduler }).electronAPI
    if (
        !api?.scheduler?.create ||
        !api.scheduler.update ||
        !api.scheduler.delete ||
        !api.scheduler.getForCampaign ||
        !api.scheduler.toggle
    ) {
        return null
    }
    return api.scheduler
}

export async function fetchScheduleForCampaign(campaignId: number): Promise<CampaignSchedule | null> {
    const api = getSchedulerApi()
    if (!api) {
        throw new Error('scheduler API unavailable')
    }
    const raw = await api.getForCampaign(campaignId)
    return normalizeSchedule(raw)
}

export async function createSchedule(config: ScheduleCreateConfig): Promise<ScheduleMutationResult> {
    const api = getSchedulerApi()
    if (!api) {
        return { success: false, error: 'scheduler API unavailable' }
    }
    return api.create(config)
}

export async function updateSchedule(
    id: number,
    config: ScheduleUpdateConfig
): Promise<ScheduleMutationResult> {
    const api = getSchedulerApi()
    if (!api) {
        return { success: false, error: 'scheduler API unavailable' }
    }
    return api.update(id, config)
}

export async function deleteSchedule(id: number): Promise<ScheduleMutationResult> {
    const api = getSchedulerApi()
    if (!api) {
        return { success: false, error: 'scheduler API unavailable' }
    }
    return api.delete(id)
}

export async function toggleSchedule(id: number): Promise<ScheduleMutationResult> {
    const api = getSchedulerApi()
    if (!api) {
        return { success: false, error: 'scheduler API unavailable' }
    }
    return api.toggle(id)
}

/** Format Date / ISO for datetime-local input (local timezone). */
export function toDateTimeLocalValue(isoOrDate: string | Date | null | undefined): string {
    if (!isoOrDate) {
        return ''
    }
    const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate)
    if (Number.isNaN(d.getTime())) {
        return ''
    }
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Convert datetime-local value to ISO string for IPC. */
export function fromDateTimeLocalValue(localValue: string): string {
    const d = new Date(localValue)
    if (Number.isNaN(d.getTime())) {
        return localValue
    }
    return d.toISOString()
}

export function formatScheduleTimestamp(
    value: string | null | undefined,
    locale = 'vi-VN'
): string {
    if (!value) {
        return '—'
    }
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) {
        return value
    }
    return d.toLocaleString(locale)
}
