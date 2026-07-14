/**
 * Pure contract tests for automation IPC Zod schemas + recovery normalize helpers.
 * No Electron / DB / JobQueue.
 */
import { describe, expect, it } from 'vitest'
import {
    automationCampaignIdSchema,
    automationConfigSaveSchema,
    automationOptionalCampaignIdSchema,
    automationTestQuerySchema,
    hasPendingRecoveryWork,
    listResumeCandidateIds,
    normalizeRecoveryReport,
    normalizeResumePlan,
    recoveryReportSchema,
    resumePlanSchema,
    type RecoveryReportDto,
} from '../src/shared/automation-contracts'

function expectOk(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify({ input, result })).toBe(true)
    return result
}

function expectFail(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify({ input, result })).toBe(false)
    return result
}

// ---------------------------------------------------------------------------
// saveConfig schema
// ---------------------------------------------------------------------------

describe('automationConfigSaveSchema', () => {
    it('accepts empty partial and known fields', () => {
        expectOk(automationConfigSaveSchema, {})
        expectOk(automationConfigSaveSchema, {
            threads: 3,
            maxReviewsPerAccountPerDay: 5,
            delayMin: 30,
            delayMax: 120,
            workingHoursStart: '08:00',
            workingHoursEnd: '22:00',
            headless: true,
            autoRetry: false,
            proxyMode: 'rotate',
        })
    })

    it('rejects unknown keys (strict)', () => {
        expectFail(automationConfigSaveSchema, { threads: 2, evil: true })
    })

    it('rejects invalid bounds and time format', () => {
        expectFail(automationConfigSaveSchema, { threads: 0 })
        expectFail(automationConfigSaveSchema, { threads: 99 })
        expectFail(automationConfigSaveSchema, { proxyMode: 'random' })
        expectFail(automationConfigSaveSchema, { workingHoursStart: '8:00' })
        expectFail(automationConfigSaveSchema, { delayMin: 100, delayMax: 10 })
    })
})

// ---------------------------------------------------------------------------
// campaign id / queue / test inputs
// ---------------------------------------------------------------------------

describe('automationCampaignIdSchema', () => {
    it('accepts positive ints only', () => {
        expectOk(automationCampaignIdSchema, 1)
        expectOk(automationCampaignIdSchema, 42)
        expectFail(automationCampaignIdSchema, 0)
        expectFail(automationCampaignIdSchema, -1)
        expectFail(automationCampaignIdSchema, 1.5)
        expectFail(automationCampaignIdSchema, '1')
        expectFail(automationCampaignIdSchema, undefined)
    })
})

describe('automationOptionalCampaignIdSchema', () => {
    it('accepts undefined or positive id', () => {
        expectOk(automationOptionalCampaignIdSchema, undefined)
        expectOk(automationOptionalCampaignIdSchema, 7)
        expectFail(automationOptionalCampaignIdSchema, 0)
        expectFail(automationOptionalCampaignIdSchema, -3)
    })
})

describe('automationTestQuerySchema', () => {
    it('accepts optional non-empty query', () => {
        expectOk(automationTestQuerySchema, undefined)
        expectOk(automationTestQuerySchema, 'quán cà phê')
        expectFail(automationTestQuerySchema, '')
        expectFail(automationTestQuerySchema, 'x'.repeat(600))
    })
})

// ---------------------------------------------------------------------------
// Recovery report / resume plan schemas + normalize
// ---------------------------------------------------------------------------

const sampleReport: RecoveryReportDto = {
    loaded: true,
    requeuedRunningJobs: true,
    requeuedRunningCount: 2,
    zombieCampaigns: [
        {
            campaignId: 10,
            pendingJobs: 3,
            doneJobs: 1,
            failedJobs: 0,
            cancelledJobs: 0,
            previousStatus: 'running',
            reconciledStatus: 'paused',
        },
    ],
    pendingCampaignIds: [10, 11],
    totalPendingJobs: 5,
}

describe('recoveryReportSchema', () => {
    it('accepts a full recovery report', () => {
        expectOk(recoveryReportSchema, sampleReport)
    })

    it('rejects bad reconciledStatus and negative counts', () => {
        expectFail(recoveryReportSchema, {
            ...sampleReport,
            zombieCampaigns: [
                {
                    ...sampleReport.zombieCampaigns[0],
                    reconciledStatus: 'running',
                },
            ],
        })
        expectFail(recoveryReportSchema, {
            ...sampleReport,
            totalPendingJobs: -1,
        })
    })
})

describe('resumePlanSchema', () => {
    it('accepts resumeable and blocked plans', () => {
        expectOk(resumePlanSchema, {
            canResume: true,
            pendingJobs: 4,
            doneJobs: 1,
            cancelledJobs: 0,
            failedJobs: 0,
        })
        expectOk(resumePlanSchema, {
            canResume: false,
            pendingJobs: 0,
            doneJobs: 2,
            cancelledJobs: 0,
            failedJobs: 0,
            reason: 'All jobs already completed — nothing to resume',
        })
    })
})

describe('normalizeRecoveryReport', () => {
    it('returns null for null / non-object', () => {
        expect(normalizeRecoveryReport(null)).toBeNull()
        expect(normalizeRecoveryReport(undefined)).toBeNull()
        expect(normalizeRecoveryReport('x')).toBeNull()
        expect(normalizeRecoveryReport(42)).toBeNull()
    })

    it('returns strict-parsed report when valid', () => {
        expect(normalizeRecoveryReport(sampleReport)).toEqual(sampleReport)
    })

    it('soft-normalizes extra keys via fallback when strict fails', () => {
        const soft = normalizeRecoveryReport({
            ...sampleReport,
            extraMainField: true,
            zombieCampaigns: [
                {
                    ...sampleReport.zombieCampaigns[0],
                    extra: 'ignored',
                },
            ],
        })
        expect(soft).not.toBeNull()
        expect(soft?.loaded).toBe(true)
        expect(soft?.pendingCampaignIds).toEqual([10, 11])
        expect(soft?.totalPendingJobs).toBe(5)
        expect(soft?.zombieCampaigns).toHaveLength(1)
        expect(soft?.zombieCampaigns[0]?.campaignId).toBe(10)
    })
})

describe('normalizeResumePlan', () => {
    it('returns null for invalid payloads', () => {
        expect(normalizeResumePlan(null)).toBeNull()
        expect(normalizeResumePlan({})).toBeNull()
        expect(normalizeResumePlan({ canResume: 'yes' })).toBeNull()
    })

    it('normalizes a valid plan', () => {
        const plan = normalizeResumePlan({
            canResume: true,
            pendingJobs: 3,
            doneJobs: 0,
            cancelledJobs: 0,
            failedJobs: 1,
        })
        expect(plan).toEqual({
            canResume: true,
            pendingJobs: 3,
            doneJobs: 0,
            cancelledJobs: 0,
            failedJobs: 1,
        })
    })
})

describe('listResumeCandidateIds / hasPendingRecoveryWork', () => {
    it('lists unique pendingCampaignIds and detects pending work', () => {
        expect(listResumeCandidateIds(sampleReport)).toEqual([10, 11])
        expect(hasPendingRecoveryWork(sampleReport)).toBe(true)
    })

    it('falls back to zombie campaigns with pending jobs', () => {
        const report: RecoveryReportDto = {
            loaded: true,
            requeuedRunningJobs: false,
            requeuedRunningCount: 0,
            zombieCampaigns: [
                {
                    campaignId: 5,
                    pendingJobs: 2,
                    doneJobs: 0,
                    failedJobs: 0,
                    cancelledJobs: 0,
                    previousStatus: 'running',
                    reconciledStatus: 'paused',
                },
                {
                    campaignId: 6,
                    pendingJobs: 0,
                    doneJobs: 4,
                    failedJobs: 0,
                    cancelledJobs: 0,
                    previousStatus: 'running',
                    reconciledStatus: 'done',
                },
            ],
            pendingCampaignIds: [],
            totalPendingJobs: 2,
        }
        expect(listResumeCandidateIds(report)).toEqual([5])
        expect(hasPendingRecoveryWork(report)).toBe(true)
    })

    it('returns false / empty when no pending work', () => {
        const empty: RecoveryReportDto = {
            loaded: true,
            requeuedRunningJobs: false,
            requeuedRunningCount: 0,
            zombieCampaigns: [],
            pendingCampaignIds: [],
            totalPendingJobs: 0,
        }
        expect(listResumeCandidateIds(empty)).toEqual([])
        expect(hasPendingRecoveryWork(empty)).toBe(false)
        expect(hasPendingRecoveryWork(null)).toBe(false)
        expect(hasPendingRecoveryWork({ ...empty, loaded: false })).toBe(false)
    })
})
