/**
 * Build create-campaign payload with correct empty-pool semantics.
 * Empty accountIds / proxyIds => omit field (backend stores null = entire pool).
 * Non-empty arrays are sent as-is.
 */

export interface CampaignCreateFormState {
    name: string
    locationIds: number[]
    accountIds: number[]
    proxyIds: number[]
    reviewTemplates: string[]
    rating: number
    delayMin: number
    delayMax: number
}

export interface CampaignCreatePayload {
    name: string
    locationIds: number[]
    accountIds?: number[]
    proxyIds?: number[]
    reviewTemplates: string[]
    rating: number
    delayMin: number
    delayMax: number
}

export interface PoolSelectionSummary {
    useAllAccounts: boolean
    useAllProxies: boolean
    needsPoolConfirm: boolean
}

export function getPoolSelectionSummary(form: CampaignCreateFormState): PoolSelectionSummary {
    const useAllAccounts = form.accountIds.length === 0
    const useAllProxies = form.proxyIds.length === 0
    return {
        useAllAccounts,
        useAllProxies,
        needsPoolConfirm: useAllAccounts || useAllProxies,
    }
}

export function buildCampaignCreatePayload(form: CampaignCreateFormState): CampaignCreatePayload {
    const templates = form.reviewTemplates.map((line) => line.trim()).filter(Boolean)
    const payload: CampaignCreatePayload = {
        name: form.name.trim(),
        locationIds: [...form.locationIds],
        reviewTemplates: templates,
        rating: form.rating,
        delayMin: form.delayMin,
        delayMax: form.delayMax,
    }

    // null/omitted on backend = entire active pool; never send [] (would lock empty set)
    if (form.accountIds.length > 0) {
        payload.accountIds = [...form.accountIds]
    }
    if (form.proxyIds.length > 0) {
        payload.proxyIds = [...form.proxyIds]
    }

    return payload
}

/**
 * Build confirm message parts for empty pool selection.
 * Caller should pass already-translated strings.
 */
export function buildPoolConfirmMessage(parts: {
    useAllAccounts: boolean
    useAllProxies: boolean
    accountPoolLabel: string
    proxyPoolLabel: string
    title: string
}): string {
    const lines: string[] = [parts.title]
    if (parts.useAllAccounts) lines.push(`• ${parts.accountPoolLabel}`)
    if (parts.useAllProxies) lines.push(`• ${parts.proxyPoolLabel}`)
    return lines.join('\n')
}
