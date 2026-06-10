import { BrowserWindow } from 'electron'

export interface ReviewSubmissionDecision {
    allowed: boolean
    reason: string
    host?: string
}

export interface ComplianceSettings {
    manualReviewSubmit?: boolean
    allowAutoSubmitOnTrustedHosts?: boolean
    trustedAutoSubmitHosts?: string
}

export interface ManualReviewSubmissionRequest {
    requestId: string
    createdAt: string
    expiresAt: string
    locationUrl: string
    locationName?: string
    accountEmail?: string
    campaignId?: number
    threadId?: number
    reason: string
}

interface ManualReviewSubmissionRequestInternal {
    request: ManualReviewSubmissionRequest
    resolve: (result: ManualReviewSubmissionResult) => void
    timeoutHandle: ReturnType<typeof setTimeout>
}

export interface ManualReviewSubmissionResult {
    approved: boolean
    reason: string
}

export const DEFAULT_TRUSTED_AUTO_SUBMIT_HOSTS = 'localhost,127.0.0.1'
const DEFAULT_MANUAL_SUBMIT_TIMEOUT_MS = 120000

const pendingManualReviewRequests = new Map<string, ManualReviewSubmissionRequestInternal>()

function normalizeHost(host: string): string {
    return host.trim().toLowerCase()
}

function parseTrustedHosts(raw?: string): string[] {
    const value = (raw || DEFAULT_TRUSTED_AUTO_SUBMIT_HOSTS)
        .split(',')
        .map(item => normalizeHost(item))
        .filter(Boolean)

    return value.length > 0 ? value : DEFAULT_TRUSTED_AUTO_SUBMIT_HOSTS.split(',').map(normalizeHost)
}

function parseHostFromUrl(inputUrl: string): string | undefined {
    try {
        return normalizeHost(new URL(inputUrl).hostname)
    } catch {
        return undefined
    }
}

function matchesTrustedHost(host: string, trustedHosts: string[]): boolean {
    for (const trusted of trustedHosts) {
        if (!trusted) {
            continue
        }

        if (host === trusted) {
            return true
        }

        if (trusted.startsWith('*.')) {
            const suffix = trusted.slice(1)
            if (host.endsWith(suffix)) {
                return true
            }
        }
    }

    return false
}

export function getReviewSubmissionDecision(locationUrl: string, settings: ComplianceSettings): ReviewSubmissionDecision {
    const manualReviewSubmit = settings.manualReviewSubmit !== false
    if (!manualReviewSubmit) {
        return {
            allowed: true,
            reason: 'manual_submit_disabled_in_settings',
        }
    }

    const allowTrusted = settings.allowAutoSubmitOnTrustedHosts === true
    const host = parseHostFromUrl(locationUrl)
    const trustedHosts = parseTrustedHosts(settings.trustedAutoSubmitHosts)

    if (allowTrusted && host && matchesTrustedHost(host, trustedHosts)) {
        return {
            allowed: true,
            reason: 'trusted_host_allowed',
            host,
        }
    }

    return {
        allowed: false,
        reason: allowTrusted
            ? 'manual_confirm_required_for_untrusted_host'
            : 'manual_confirm_required_globally',
        host,
    }
}

export function buildManualSubmitMessage(locationUrl: string, settings: ComplianceSettings): string {
    const decision = getReviewSubmissionDecision(locationUrl, settings)
    if (decision.allowed) {
        return ''
    }

    const hostPart = decision.host ? `target host "${decision.host}"` : `target url "${locationUrl}"`
    return `Manual confirm required before submitting review (${hostPart}).`
}

function broadcast(channel: string, payload: unknown): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
        if (!win.isDestroyed()) {
            win.webContents.send(channel, payload)
        }
    }
}

function toPublicRequests(): ManualReviewSubmissionRequest[] {
    return Array.from(pendingManualReviewRequests.values())
        .map(item => item.request)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function getPendingManualReviewSubmissionRequests(): ManualReviewSubmissionRequest[] {
    return toPublicRequests()
}

export function requestManualReviewSubmissionApproval(
    input: Omit<ManualReviewSubmissionRequest, 'requestId' | 'createdAt' | 'expiresAt'>,
    timeoutMs = DEFAULT_MANUAL_SUBMIT_TIMEOUT_MS
): Promise<ManualReviewSubmissionResult> {
    const requestId = `manual-submit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const createdAt = new Date().toISOString()
    const expiresAt = new Date(Date.now() + Math.max(10000, timeoutMs)).toISOString()
    const request: ManualReviewSubmissionRequest = {
        requestId,
        createdAt,
        expiresAt,
        ...input,
    }

    return new Promise<ManualReviewSubmissionResult>((resolve) => {
        const timeoutHandle = setTimeout(() => {
            const entry = pendingManualReviewRequests.get(requestId)
            if (!entry) {
                return
            }
            pendingManualReviewRequests.delete(requestId)
            broadcast('compliance:reviewSubmissionResolved', {
                requestId,
                approved: false,
                reason: 'timeout',
            })
            broadcast('compliance:reviewSubmissionQueue', toPublicRequests())
            resolve({
                approved: false,
                reason: 'timeout',
            })
        }, Math.max(10000, timeoutMs))

        pendingManualReviewRequests.set(requestId, {
            request,
            resolve,
            timeoutHandle,
        })

        broadcast('compliance:reviewSubmissionPending', request)
        broadcast('compliance:reviewSubmissionQueue', toPublicRequests())
    })
}

function resolvePendingManualSubmission(
    requestId: string,
    approved: boolean,
    reason: string
): { success: boolean; message: string } {
    const entry = pendingManualReviewRequests.get(requestId)
    if (!entry) {
        return { success: false, message: 'Request not found or already resolved.' }
    }

    clearTimeout(entry.timeoutHandle)
    pendingManualReviewRequests.delete(requestId)
    entry.resolve({
        approved,
        reason,
    })

    broadcast('compliance:reviewSubmissionResolved', {
        requestId,
        approved,
        reason,
    })
    broadcast('compliance:reviewSubmissionQueue', toPublicRequests())
    return { success: true, message: approved ? 'Approved' : 'Rejected' }
}

export function approveManualReviewSubmission(requestId: string): { success: boolean; message: string } {
    return resolvePendingManualSubmission(requestId, true, 'approved_by_user')
}

export function rejectManualReviewSubmission(requestId: string, reason = 'rejected_by_user'): { success: boolean; message: string } {
    return resolvePendingManualSubmission(requestId, false, reason)
}
