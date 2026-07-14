export type TrafficFailBucket =
    | 'captcha_blocked'
    | 'watchdog_timeout'
    | 'proxy_error'
    | 'navigation_error'
    | 'login_gate'
    | 'browser_crash'
    | 'direct_map_not_ready'
    | 'web_seo_target_not_found'
    | 'agentic_planner'
    | 'other'

export interface TrafficFailureClassification {
    bucket: TrafficFailBucket
    code: string
    retryable: boolean
    message: string
    evidence: string[]
}

const KNOWN_BUCKETS = new Set<TrafficFailBucket>([
    'captcha_blocked',
    'watchdog_timeout',
    'proxy_error',
    'navigation_error',
    'login_gate',
    'browser_crash',
    'direct_map_not_ready',
    'web_seo_target_not_found',
    'agentic_planner',
    'other',
])

function toMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message
    }
    return String(error ?? 'unknown')
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null
    }
    return value as Record<string, unknown>
}

function bucketFromValue(value: unknown): TrafficFailBucket | null {
    if (typeof value !== 'string') {
        return null
    }
    return KNOWN_BUCKETS.has(value as TrafficFailBucket) ? value as TrafficFailBucket : null
}

function buildClassification(
    bucket: TrafficFailBucket,
    code: string,
    retryable: boolean,
    message: string,
    evidence: string[]
): TrafficFailureClassification {
    return { bucket, code, retryable, message, evidence }
}

export function classifyTrafficFailure(error: unknown): TrafficFailureClassification {
    return classifyTrafficFailureMessage(toMessage(error))
}

export function classifyTrafficFailureMessage(message: string): TrafficFailureClassification {
    const lower = message.toLowerCase()

    if (/captcha/.test(lower)) {
        return buildClassification('captcha_blocked', 'captcha_gate', false, 'Visit blocked by CAPTCHA gate', ['captcha'])
    }
    if (/visit_(watchdog_timeout|aborted_by_watchdog)|watchdog/.test(lower)) {
        return buildClassification('watchdog_timeout', 'visit_watchdog', true, 'Visit exceeded watchdog or runtime budget', ['watchdog'])
    }
    if (/err_proxy_connection_failed|proxy connection failed|err_tunnel_connection_failed|proxy authentication required|\b407\b|socks|proxy/.test(lower)) {
        return buildClassification('proxy_error', 'proxy_connection', true, 'Proxy connection, tunnel, or authentication failed', ['proxy'])
    }
    if (/direct_mode_map_not_ready/.test(lower)) {
        return buildClassification('direct_map_not_ready', 'direct_map_not_ready', true, 'Direct mode could not restore map context', ['direct_mode'])
    }

    // Web SEO structured error codes (prefer exact codes before generic target-not-found)
    if (/web_seo_invalid_target/.test(lower)) {
        return buildClassification(
            'web_seo_target_not_found',
            'web_seo_invalid_target',
            false,
            'Web SEO target URL/host is invalid',
            ['web_seo', 'invalid_target']
        )
    }
    if (/web_seo_host_mismatch|host_mismatch/.test(lower)) {
        return buildClassification(
            'web_seo_target_not_found',
            'web_seo_host_mismatch',
            true,
            'Web SEO landed on a host that does not match the target',
            ['web_seo', 'host_mismatch']
        )
    }
    if (/web_seo_deadline/.test(lower)) {
        return buildClassification(
            'watchdog_timeout',
            'web_seo_deadline',
            true,
            'Web SEO visit hit soft/hard deadline before completion',
            ['web_seo', 'deadline']
        )
    }
    if (/web_seo_organic_required|organic_required/.test(lower)) {
        return buildClassification(
            'web_seo_target_not_found',
            'web_seo_organic_required',
            false,
            'Web SEO campaign requires an organic Google discovery hit',
            ['web_seo', 'organic_required']
        )
    }
    if (/web_seo_low_quality/.test(lower)) {
        return buildClassification(
            'web_seo_target_not_found',
            'web_seo_low_quality',
            false,
            'Web SEO reached the target but did not meet the quality gate',
            ['web_seo', 'low_quality']
        )
    }
    if (/web_seo_cancelled/.test(lower)) {
        return buildClassification(
            'other',
            'web_seo_cancelled',
            true,
            'Web SEO visit was cancelled cooperatively',
            ['web_seo', 'cancelled']
        )
    }
    if (/web_seo_target_not_found|web_seo.*not.*found|target_not_found|target.*not.*found/.test(lower)) {
        return buildClassification(
            'web_seo_target_not_found',
            'web_seo_target_not_found',
            true,
            'Web SEO target could not be found',
            ['web_seo']
        )
    }

    if (/agentic|planner|llm|ollama/.test(lower)) {
        return buildClassification('agentic_planner', 'agentic_planner_failed', true, 'Agentic planner failed during visit', ['agentic'])
    }
    if (/navigation|net::err|timeout.*goto|page\.goto/.test(lower)) {
        return buildClassification('navigation_error', 'navigation_failed', true, 'Page navigation failed before visit completion', ['navigation'])
    }
    if (/google_login_blocked|login|sign in|signin/.test(lower)) {
        return buildClassification('login_gate', 'login_gate', false, 'Google login gate blocked the visit', ['login'])
    }
    if (/target closed|browser|context.*closed|page.*closed/.test(lower)) {
        return buildClassification('browser_crash', 'browser_context_closed', true, 'Browser, context, or page closed unexpectedly', ['browser_context'])
    }

    return buildClassification('other', 'unclassified_runtime_error', false, 'Runtime visit failed without a known bucket', [])
}

export function readTrafficFailureBucketFromActions(rawActions: unknown): TrafficFailBucket | null {
    if (!Array.isArray(rawActions)) {
        return null
    }

    for (const action of rawActions) {
        const record = asRecord(action)
        if (!record || record.action !== 'visit_failure_classified') {
            continue
        }

        const bucket = bucketFromValue(record.retryCategory)
        if (bucket) {
            return bucket
        }
    }

    return null
}
