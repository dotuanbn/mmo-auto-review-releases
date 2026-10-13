import { useState } from 'react'
import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { useI18n } from '../../i18n'
import { Panel, PrimaryButton } from '../ui/surface'
import { formatComplianceTimestamp } from './api'
import type { PendingReviewIntent, ReviewReconcileOutcome } from './types'
import { REVIEW_INTENT_PANEL_MAX } from './types'

/** Keep in sync with COMPLIANCE_RECONCILE_NOTE_MAX (shared contracts). */
const RECONCILE_NOTE_MAX = 1000

interface ReviewIntentReconcilePanelProps {
    intents: PendingReviewIntent[]
    loading?: boolean
    refreshing?: boolean
    error?: string | null
    actingId: number | null
    available?: boolean
    onReconcile: (
        historyId: number,
        outcome: ReviewReconcileOutcome,
        note?: string
    ) => void | Promise<void>
    onRefresh?: () => void | Promise<void>
    maxItems?: number
}

function statusLabel(
    status: PendingReviewIntent['status'],
    t: (key: string, fallback: string) => string
): string {
    if (status === 'submitting') {
        return t('compliance.intentStatusSubmitting', 'submitting')
    }
    return t('compliance.intentStatusUnconfirmed', 'unconfirmed')
}

function clampNote(raw: string): string {
    const trimmed = raw.trim()
    if (trimmed.length <= RECONCILE_NOTE_MAX) return trimmed
    return trimmed.slice(0, RECONCILE_NOTE_MAX)
}

export function ReviewIntentReconcilePanel({
    intents,
    loading = false,
    refreshing = false,
    error = null,
    actingId,
    available = true,
    onReconcile,
    onRefresh,
    maxItems = REVIEW_INTENT_PANEL_MAX,
}: ReviewIntentReconcilePanelProps) {
    const { t } = useI18n()
    const [confirmingId, setConfirmingId] = useState<number | null>(null)
    const [pendingOutcome, setPendingOutcome] = useState<ReviewReconcileOutcome | null>(
        null
    )
    const [noteDraft, setNoteDraft] = useState('')

    if (!available) {
        return null
    }

    const visible = intents.slice(0, maxItems)
    const remaining = intents.length - visible.length
    const isEmpty = !loading && intents.length === 0
    const busyGlobal = loading || refreshing || actingId != null

    const title = t(
        'compliance.intentTitle',
        'Manual reconciliation — submitting / unconfirmed reviews'
    )
    const subtitle = t(
        'compliance.intentSubtitle',
        'Durable intents blocked auto re-post. Confirm only after checking Google.'
    )

    const requestConfirm = (historyId: number, outcome: ReviewReconcileOutcome) => {
        setConfirmingId(historyId)
        setPendingOutcome(outcome)
        setNoteDraft('')
    }

    const cancelConfirm = () => {
        setConfirmingId(null)
        setPendingOutcome(null)
        setNoteDraft('')
    }

    const runConfirm = (item: PendingReviewIntent) => {
        if (!pendingOutcome || confirmingId !== item.historyId) return
        const outcome = pendingOutcome
        const note = clampNote(noteDraft)
        cancelConfirm()
        void onReconcile(item.historyId, outcome, note.length > 0 ? note : undefined)
    }

    return (
        <Panel tone="rose" className="space-y-3 p-4" key="review-intent-reconcile-panel">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600 dark:text-rose-400" />
                    <div className="min-w-0">
                        <div className="text-sm font-semibold text-rose-800 dark:text-rose-200">
                            {title}
                            {!loading && intents.length > 0 && (
                                <span className="ml-1 font-bold">({intents.length})</span>
                            )}
                        </div>
                        <p className="mt-0.5 text-xs text-rose-700/80 dark:text-rose-300/80">{subtitle}</p>
                    </div>
                </div>
                {onRefresh && (
                    <PrimaryButton
                        tone="slate"
                        onClick={() => void onRefresh()}
                        disabled={busyGlobal}
                        className="!px-3 !py-1.5 !text-xs"
                    >
                        <RefreshCw
                            className={`mr-1 inline h-3.5 w-3.5 ${
                                loading || refreshing ? 'animate-spin' : ''
                            }`}
                        />
                        {t('compliance.intentRefresh', 'Refresh')}
                    </PrimaryButton>
                )}
            </div>

            {error && (
                <div
                    className="rounded-[14px] border border-rose-200 dark:border-rose-800/60 bg-white/80 dark:bg-[#2a2540] px-3 py-2 text-xs text-rose-700 dark:text-rose-300"
                    role="alert"
                >
                    {error}
                </div>
            )}

            {loading && intents.length === 0 && (
                <div className="rounded-[14px] border border-rose-100 dark:border-rose-900/50 bg-white/60 dark:bg-[#2a2540] px-3 py-4 text-center text-xs text-rose-700/80 dark:text-rose-300/80">
                    {t('compliance.intentLoading', 'Loading reconcilable intents…')}
                </div>
            )}

            {isEmpty && (
                <div className="rounded-[14px] border border-dashed border-rose-200 dark:border-rose-800/60 bg-white/50 dark:bg-[#2a2540] px-3 py-4 text-center text-xs text-rose-700/70 dark:text-rose-300/70">
                    {t(
                        'compliance.intentEmpty',
                        'No submitting or unconfirmed review intents. Nothing to reconcile.'
                    )}
                </div>
            )}

            {visible.length > 0 && (
                <div className="space-y-2">
                    {visible.map((item) => {
                        const busy = actingId === item.historyId
                        const confirming =
                            confirmingId === item.historyId && pendingOutcome != null
                        const locationLabel = item.locationName || item.locationUrl || `Location #${item.locationId}`
                        return (
                            <div
                                key={item.historyId}
                                className="rounded-[14px] border border-[#e9e4f2] dark:border-[#3d3558] bg-white/70 dark:bg-[#2a2540] p-3"
                            >
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="truncate text-sm font-medium text-[#17171f] dark:text-[#f0ecff]" title={locationLabel}>
                                                {locationLabel}
                                            </span>
                                            <span
                                                className={
                                                    item.status === 'unconfirmed'
                                                        ? 'inline-flex rounded-full bg-rose-100 dark:bg-rose-950/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700 dark:text-rose-300'
                                                        : 'inline-flex rounded-full bg-amber-100 dark:bg-amber-950/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800 dark:text-amber-200'
                                                }
                                            >
                                                {statusLabel(item.status, t)}
                                            </span>
                                        </div>
                                        {item.locationUrl && (
                                            <div className="mt-1 break-all text-xs text-[#908a9e] dark:text-[#9a8fba]">
                                                {item.locationUrl}
                                            </div>
                                        )}
                                        <div className="mt-1 text-xs text-[#908a9e] dark:text-[#9a8fba]">
                                            {t('compliance.historyId', 'History')} #
                                            {item.historyId}
                                            {' · '}
                                            {item.accountEmail ||
                                                t(
                                                    'compliance.unknownAccount',
                                                    'Unknown account'
                                                )}
                                            {item.campaignId != null && (
                                                <>
                                                    {' · '}
                                                    {t('compliance.campaign', 'Campaign')} #
                                                    {item.campaignId}
                                                </>
                                            )}
                                            {' · '}
                                            {item.rating}★
                                            {' · '}
                                            {t('compliance.created', 'created')}{' '}
                                            {formatComplianceTimestamp(item.createdAt)}
                                        </div>
                                        {item.reviewTextPreview && (
                                            <div className="mt-1 line-clamp-2 text-xs text-[#565263] dark:text-[#c8c0d8]" title={item.reviewTextPreview}>
                                                {item.reviewTextPreview}
                                            </div>
                                        )}
                                        {item.errorMessage && (
                                            <div className="mt-1 text-xs text-rose-700/80 dark:text-rose-300/80">
                                                {t('compliance.reason', 'Reason')}:{' '}
                                                {item.errorMessage}
                                            </div>
                                        )}
                                        {confirming && (
                                            <div className="mt-2">
                                                <label className="block text-[11px] font-medium text-rose-800 dark:text-rose-200">
                                                    {t(
                                                        'compliance.intentNote',
                                                        'Optional note (max 1000)'
                                                    )}
                                                </label>
                                                <textarea
                                                    value={noteDraft}
                                                    onChange={(e) =>
                                                        setNoteDraft(
                                                            e.target.value.slice(
                                                                0,
                                                                RECONCILE_NOTE_MAX
                                                            )
                                                        )
                                                    }
                                                    maxLength={RECONCILE_NOTE_MAX}
                                                    rows={2}
                                                    disabled={busy}
                                                    className="mt-1 w-full resize-y rounded-[10px] border border-rose-200 dark:border-rose-800/60 bg-white dark:bg-[#1e1b2e] px-2 py-1.5 text-xs text-[#17171f] dark:text-[#f0ecff] outline-none placeholder:text-[#908a9e] dark:placeholder:text-[#9a8fba] focus:border-rose-400"
                                                    placeholder={t(
                                                        'compliance.intentNotePlaceholder',
                                                        'e.g. verified on Google Maps'
                                                    )}
                                                />
                                                <div className="mt-0.5 text-right text-[10px] text-[#908a9e] dark:text-[#9a8fba]">
                                                    {noteDraft.length}/{RECONCILE_NOTE_MAX}
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
                                        {confirming ? (
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="text-[11px] font-medium text-rose-800 dark:text-rose-200">
                                                    {pendingOutcome === 'confirmed_success'
                                                        ? t(
                                                              'compliance.intentConfirmingSuccess',
                                                              'Confirm: posted?'
                                                          )
                                                        : t(
                                                              'compliance.intentConfirmingNotPosted',
                                                              'Confirm: not posted?'
                                                          )}
                                                </span>
                                                <PrimaryButton
                                                    tone="emerald"
                                                    onClick={() => runConfirm(item)}
                                                    disabled={busy}
                                                    className="!px-3 !py-1.5 !text-xs"
                                                >
                                                    {t('compliance.intentYes', 'Yes')}
                                                </PrimaryButton>
                                                <PrimaryButton
                                                    tone="slate"
                                                    onClick={cancelConfirm}
                                                    disabled={busy}
                                                    className="!px-3 !py-1.5 !text-xs"
                                                >
                                                    {t('compliance.intentCancel', 'Cancel')}
                                                </PrimaryButton>
                                            </div>
                                        ) : (
                                            <div className="flex flex-wrap items-center gap-2">
                                                <PrimaryButton
                                                    tone="emerald"
                                                    onClick={() =>
                                                        requestConfirm(
                                                            item.historyId,
                                                            'confirmed_success'
                                                        )
                                                    }
                                                    disabled={busy || actingId != null}
                                                    className="!px-3 !py-1.5 !text-xs"
                                                >
                                                    <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
                                                    {busy
                                                        ? t(
                                                              'compliance.intentWorking',
                                                              'Working…'
                                                          )
                                                        : t(
                                                              'compliance.intentMarkPosted',
                                                              'Confirm posted'
                                                          )}
                                                </PrimaryButton>
                                                <PrimaryButton
                                                    tone="rose"
                                                    onClick={() =>
                                                        requestConfirm(
                                                            item.historyId,
                                                            'confirmed_not_posted'
                                                        )
                                                    }
                                                    disabled={busy || actingId != null}
                                                    className="!px-3 !py-1.5 !text-xs"
                                                >
                                                    <XCircle className="mr-1 inline h-3.5 w-3.5" />
                                                    {t(
                                                        'compliance.intentMarkNotPosted',
                                                        'Not posted'
                                                    )}
                                                </PrimaryButton>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}

            {remaining > 0 && (
                <p className="text-xs text-rose-700/80 dark:text-rose-300/80">
                    {t('compliance.intentMore', '+{n} more intents').replace(
                        '{n}',
                        String(remaining)
                    )}
                </p>
            )}
        </Panel>
    )
}
