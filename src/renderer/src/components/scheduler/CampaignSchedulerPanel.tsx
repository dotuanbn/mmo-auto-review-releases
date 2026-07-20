import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarClock, Loader2, Power, Save, Trash2 } from 'lucide-react'
import { useI18n } from '../../i18n'
import { Badge, PrimaryButton, StatusPill } from '../ui/surface'
import {
    createSchedule,
    deleteSchedule,
    fetchScheduleForCampaign,
    formatScheduleTimestamp,
    fromDateTimeLocalValue,
    toDateTimeLocalValue,
    toggleSchedule,
    updateSchedule,
} from './api'
import type { CampaignSchedule, ScheduleRepeatType, WeekdayIndex } from './types'
import { REPEAT_TYPES, WEEKDAY_LABELS } from './types'

interface CampaignSchedulerPanelProps {
    campaignId: number
    campaignName?: string
}

interface ScheduleFormState {
    scheduledAtLocal: string
    repeatType: ScheduleRepeatType
    repeatDays: number[]
    endDateLocal: string
    isActive: boolean
}

function defaultFormState(): ScheduleFormState {
    const now = new Date()
    now.setMinutes(now.getMinutes() + 30, 0, 0)
    return {
        scheduledAtLocal: toDateTimeLocalValue(now),
        repeatType: 'once',
        repeatDays: [1, 2, 3, 4, 5],
        endDateLocal: '',
        isActive: true,
    }
}

function formFromSchedule(schedule: CampaignSchedule): ScheduleFormState {
    return {
        scheduledAtLocal: toDateTimeLocalValue(schedule.scheduledAt),
        repeatType: schedule.repeatType,
        repeatDays: schedule.repeatDays?.length ? [...schedule.repeatDays] : [1, 2, 3, 4, 5],
        endDateLocal: schedule.endDate ? toDateTimeLocalValue(schedule.endDate).slice(0, 10) : '',
        isActive: schedule.isActive,
    }
}

function isWeekdayIndex(n: number): n is WeekdayIndex {
    return Number.isInteger(n) && n >= 0 && n <= 6
}

export function CampaignSchedulerPanel({ campaignId, campaignName }: CampaignSchedulerPanelProps) {
    const { t } = useI18n()
    const [schedule, setSchedule] = useState<CampaignSchedule | null>(null)
    const [form, setForm] = useState<ScheduleFormState>(defaultFormState)
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [message, setMessage] = useState<string | null>(null)

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const row = await fetchScheduleForCampaign(campaignId)
            setSchedule(row)
            setForm(row ? formFromSchedule(row) : defaultFormState())
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to load schedule'
            setError(msg)
            setSchedule(null)
        } finally {
            setLoading(false)
        }
    }, [campaignId])

    useEffect(() => {
        void load()
    }, [load])

    const needsWeekdays = form.repeatType === 'custom'

    const canSave = useMemo(() => {
        if (!form.scheduledAtLocal) {
            return false
        }
        if (needsWeekdays && form.repeatDays.length === 0) {
            return false
        }
        return true
    }, [form.repeatDays.length, form.scheduledAtLocal, needsWeekdays])

    const buildPayloadFields = () => {
        const scheduledAt = fromDateTimeLocalValue(form.scheduledAtLocal)
        const endDate = form.endDateLocal
            ? fromDateTimeLocalValue(`${form.endDateLocal}T23:59`)
            : undefined
        return {
            scheduledAt,
            repeatType: form.repeatType,
            repeatDays: needsWeekdays ? form.repeatDays.filter(isWeekdayIndex) : undefined,
            endDate,
            isActive: form.isActive,
        }
    }

    const handleSave = async () => {
        if (!canSave || saving) {
            return
        }
        setSaving(true)
        setError(null)
        setMessage(null)
        try {
            const fields = buildPayloadFields()
            if (schedule) {
                const result = await updateSchedule(schedule.id, fields)
                if (!result.success) {
                    setError(result.error || t('scheduler.saveFailed', 'Failed to update schedule'))
                    return
                }
                setMessage(t('scheduler.updated', 'Schedule updated'))
            } else {
                const result = await createSchedule({
                    campaignId,
                    ...fields,
                })
                if (!result.success) {
                    setError(result.error || t('scheduler.saveFailed', 'Failed to create schedule'))
                    return
                }
                setMessage(t('scheduler.created', 'Schedule created'))
            }
            await load()
        } catch (err) {
            setError(err instanceof Error ? err.message : t('scheduler.saveFailed', 'Save failed'))
        } finally {
            setSaving(false)
        }
    }

    const handleToggle = async () => {
        if (!schedule || saving) {
            return
        }
        setSaving(true)
        setError(null)
        setMessage(null)
        try {
            const result = await toggleSchedule(schedule.id)
            if (!result.success) {
                setError(result.error || t('scheduler.toggleFailed', 'Failed to toggle schedule'))
                return
            }
            setMessage(
                result.isActive
                    ? t('scheduler.enabled', 'Schedule enabled')
                    : t('scheduler.disabled', 'Schedule disabled')
            )
            await load()
        } catch (err) {
            setError(err instanceof Error ? err.message : t('scheduler.toggleFailed', 'Toggle failed'))
        } finally {
            setSaving(false)
        }
    }

    const handleDelete = async () => {
        if (!schedule || saving) {
            return
        }
        const confirmed = window.confirm(
            t('scheduler.confirmDelete', 'Delete this schedule? Campaign will no longer auto-run.')
        )
        if (!confirmed) {
            return
        }
        setSaving(true)
        setError(null)
        setMessage(null)
        try {
            const result = await deleteSchedule(schedule.id)
            if (!result.success) {
                setError(result.error || t('scheduler.deleteFailed', 'Failed to delete schedule'))
                return
            }
            setSchedule(null)
            setForm(defaultFormState())
            setMessage(t('scheduler.deleted', 'Schedule deleted'))
        } catch (err) {
            setError(err instanceof Error ? err.message : t('scheduler.deleteFailed', 'Delete failed'))
        } finally {
            setSaving(false)
        }
    }

    const toggleWeekday = (day: WeekdayIndex) => {
        setForm((prev) => {
            const has = prev.repeatDays.includes(day)
            const next = has
                ? prev.repeatDays.filter((d) => d !== day)
                : [...prev.repeatDays, day].sort((a, b) => a - b)
            return { ...prev, repeatDays: next }
        })
    }

    const selectClass =
        'w-full rounded-[12px] border border-[#e9e4f2] bg-white px-3 py-2 text-sm text-[#17171f] outline-none focus:border-[#8d74e8] focus:ring-2 focus:ring-[#8d74e8]/20'
    const inputClass = selectClass

    return (
        <div className="mt-4 rounded-[16px] border border-[#e9e4f2] bg-[#fbfaff] p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <CalendarClock className="h-4 w-4 shrink-0 text-[#8d74e8]" />
                    <div className="min-w-0">
                        <h4 className="text-sm font-semibold text-[#17171f]">
                            {t('scheduler.title', 'Schedule')}
                        </h4>
                        {campaignName && (
                            <p className="truncate text-xs text-[#908a9e]">{campaignName}</p>
                        )}
                    </div>
                </div>
                {schedule ? (
                    <StatusPill tone={schedule.isActive ? 'emerald' : 'slate'}>
                        {schedule.isActive
                            ? t('scheduler.active', 'Active')
                            : t('scheduler.inactive', 'Inactive')}
                    </StatusPill>
                ) : (
                    <Badge tone="slate">{t('scheduler.none', 'No schedule')}</Badge>
                )}
            </div>

            {loading ? (
                <div className="flex items-center gap-2 py-4 text-sm text-[#908a9e]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('scheduler.loading', 'Loading schedule…')}
                </div>
            ) : (
                <div className="space-y-3">
                    {schedule && (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <div className="rounded-[12px] border border-[#e9e4f2] bg-white px-3 py-2">
                                <div className="text-[10px] font-bold uppercase tracking-wider text-[#908a9e]">
                                    {t('scheduler.nextRun', 'Next run')}
                                </div>
                                <div className="mt-0.5 text-sm font-medium text-[#17171f]">
                                    {formatScheduleTimestamp(schedule.nextRunAt)}
                                </div>
                            </div>
                            <div className="rounded-[12px] border border-[#e9e4f2] bg-white px-3 py-2">
                                <div className="text-[10px] font-bold uppercase tracking-wider text-[#908a9e]">
                                    {t('scheduler.lastRun', 'Last run')}
                                </div>
                                <div className="mt-0.5 text-sm font-medium text-[#17171f]">
                                    {formatScheduleTimestamp(schedule.lastRunAt)}
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="block space-y-1">
                            <span className="text-xs font-medium text-[#5f5a6d]">
                                {t('scheduler.scheduledAt', 'Start date & time')}
                            </span>
                            <input
                                type="datetime-local"
                                className={inputClass}
                                value={form.scheduledAtLocal}
                                onChange={(e) =>
                                    setForm((prev) => ({ ...prev, scheduledAtLocal: e.target.value }))
                                }
                            />
                        </label>

                        <label className="block space-y-1">
                            <span className="text-xs font-medium text-[#5f5a6d]">
                                {t('scheduler.repeatType', 'Repeat interval')}
                            </span>
                            <select
                                className={selectClass}
                                value={form.repeatType}
                                onChange={(e) =>
                                    setForm((prev) => ({
                                        ...prev,
                                        repeatType: e.target.value as ScheduleRepeatType,
                                    }))
                                }
                            >
                                {REPEAT_TYPES.map((type) => (
                                    <option key={type} value={type}>
                                        {t(`scheduler.repeat.${type}`, type)}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="block space-y-1">
                            <span className="text-xs font-medium text-[#5f5a6d]">
                                {t('scheduler.endDate', 'End date (optional)')}
                            </span>
                            <input
                                type="date"
                                className={inputClass}
                                value={form.endDateLocal}
                                onChange={(e) =>
                                    setForm((prev) => ({ ...prev, endDateLocal: e.target.value }))
                                }
                            />
                        </label>

                        <label className="flex items-center gap-2 pt-5 sm:pt-6">
                            <input
                                type="checkbox"
                                className="h-4 w-4 rounded accent-[#8d74e8]"
                                checked={form.isActive}
                                onChange={(e) =>
                                    setForm((prev) => ({ ...prev, isActive: e.target.checked }))
                                }
                            />
                            <span className="text-sm text-[#17171f]">
                                {t('scheduler.isActive', 'Enable schedule')}
                            </span>
                        </label>
                    </div>

                    {needsWeekdays && (
                        <div>
                            <div className="mb-1.5 text-xs font-medium text-[#5f5a6d]">
                                {t('scheduler.weekdays', 'Weekdays')}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {WEEKDAY_LABELS.map((day) => {
                                    const selected = form.repeatDays.includes(day.value)
                                    return (
                                        <button
                                            key={day.value}
                                            type="button"
                                            onClick={() => toggleWeekday(day.value)}
                                            className={[
                                                'rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors',
                                                selected
                                                    ? 'border-[#8d74e8] bg-[#8d74e8] text-white'
                                                    : 'border-[#e9e4f2] bg-white text-[#5f5a6d] hover:bg-[#f4f0ff]',
                                            ].join(' ')}
                                        >
                                            {t(day.key, day.fallback)}
                                        </button>
                                    )
                                })}
                            </div>
                        </div>
                    )}

                    {error && (
                        <p className="text-xs font-medium text-rose-600" role="alert">
                            {error}
                        </p>
                    )}
                    {message && !error && (
                        <p className="text-xs font-medium text-emerald-600">{message}</p>
                    )}

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                        <PrimaryButton
                            icon={saving ? Loader2 : Save}
                            onClick={() => {
                                void handleSave()
                            }}
                            disabled={!canSave || saving}
                            className={`!px-3 !py-1.5 !text-xs ${saving ? '[&_svg]:animate-spin' : ''}`}
                        >
                            {schedule
                                ? t('scheduler.save', 'Save changes')
                                : t('scheduler.create', 'Create schedule')}
                        </PrimaryButton>

                        {schedule && (
                            <>
                                <PrimaryButton
                                    variant="quiet"
                                    icon={Power}
                                    onClick={() => {
                                        void handleToggle()
                                    }}
                                    disabled={saving}
                                    className="!px-3 !py-1.5 !text-xs"
                                >
                                    {schedule.isActive
                                        ? t('scheduler.disable', 'Disable')
                                        : t('scheduler.enable', 'Enable')}
                                </PrimaryButton>
                                <PrimaryButton
                                    tone="rose"
                                    variant="quiet"
                                    icon={Trash2}
                                    onClick={() => {
                                        void handleDelete()
                                    }}
                                    disabled={saving}
                                    className="!px-3 !py-1.5 !text-xs"
                                >
                                    {t('scheduler.delete', 'Delete')}
                                </PrimaryButton>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
