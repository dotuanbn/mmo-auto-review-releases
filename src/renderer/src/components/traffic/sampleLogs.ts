import type { TrafficLogRow } from './types'

const DEFAULT_SAMPLE_LIMIT = 24

function logTimestamp(log: TrafficLogRow): number {
    const value = log.createdAt
    if (value instanceof Date) {
        return value.getTime()
    }
    const parsed = new Date(value).getTime()
    return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Build a bounded sample for UI: prefer failed visits, then newest successes.
 * Keeps renderer work O(n log n) once per fetch, not per render row explosion.
 */
export function selectSampleLogs(
    logs: TrafficLogRow[],
    limit: number = DEFAULT_SAMPLE_LIMIT
): TrafficLogRow[] {
    if (logs.length === 0 || limit <= 0) {
        return []
    }

    const failed = logs
        .filter(log => log.status === 'failed')
        .sort((a, b) => logTimestamp(b) - logTimestamp(a))

    const success = logs
        .filter(log => log.status !== 'failed')
        .sort((a, b) => logTimestamp(b) - logTimestamp(a))

    const failedBudget = Math.min(failed.length, Math.max(8, Math.ceil(limit * 0.6)))
    const picked: TrafficLogRow[] = failed.slice(0, failedBudget)
    const remaining = limit - picked.length

    if (remaining > 0) {
        picked.push(...success.slice(0, remaining))
    }

    return picked
}

export function formatLogTime(value: string | number | Date): string {
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) {
        return '—'
    }
    return date.toLocaleString('vi-VN')
}
