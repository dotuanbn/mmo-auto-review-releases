import type { FailureBucketItem, TrafficAuditIssues } from './types'

const BUCKET_DEFS: Array<{
    key: FailureBucketItem['key']
    field: keyof TrafficAuditIssues
    i18nKey: string
    tone: FailureBucketItem['tone']
}> = [
    { key: 'captchaBlocked', field: 'captchaBlocked', i18nKey: 'traffic.audit.buckets.captchaBlocked', tone: 'rose' },
    { key: 'watchdogTimeout', field: 'watchdogTimeout', i18nKey: 'traffic.audit.buckets.watchdogTimeout', tone: 'amber' },
    { key: 'loginGate', field: 'loginGate', i18nKey: 'traffic.audit.buckets.loginGate', tone: 'violet' },
    { key: 'proxyErrors', field: 'proxyErrors', i18nKey: 'traffic.audit.buckets.proxyErrors', tone: 'cyan' },
    { key: 'navigationErrors', field: 'navigationErrors', i18nKey: 'traffic.audit.buckets.navigationErrors', tone: 'blue' },
    { key: 'browserCrashes', field: 'browserCrashes', i18nKey: 'traffic.audit.buckets.browserCrashes', tone: 'rose' },
    { key: 'otherErrors', field: 'otherErrors', i18nKey: 'traffic.audit.buckets.otherErrors', tone: 'slate' },
]

export function buildFailureBuckets(issues: TrafficAuditIssues | null | undefined): FailureBucketItem[] {
    if (!issues) {
        return []
    }

    return BUCKET_DEFS
        .map(def => ({
            key: def.key,
            count: Number(issues[def.field] || 0),
            i18nKey: def.i18nKey,
            tone: def.tone,
        }))
        .filter(item => item.count > 0)
        .sort((a, b) => b.count - a.count)
}

export function sumFailureBuckets(items: FailureBucketItem[]): number {
    return items.reduce((sum, item) => sum + item.count, 0)
}
