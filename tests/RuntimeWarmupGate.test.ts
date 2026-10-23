/**
 * Runtime Warmup Gate — pure helpers (P0 crash-resume / throttled cap).
 * Covers: blocked cancel all active; throttled max 1 non-terminal; full no cancel;
 * deterministic keeper; done history never selected.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
    app: {
        getPath: () => 'C:\\tmp\\mmo-runtime-warmup-gate',
    },
    BrowserWindow: class {
        webContents = { send: vi.fn() }
    },
}))

vi.mock('playwright', () => ({
    chromium: {},
}))

vi.mock('../src/main/database', () => ({
    getDatabase: vi.fn(),
}))

vi.mock('../src/main/database/schema', () => ({
    campaigns: { id: 'id' },
    accounts: { id: 'id' },
    locations: { id: 'id' },
    settings: { key: 'key' },
}))

vi.mock('../src/main/services/AccountService', () => ({ accountService: {} }))
vi.mock('../src/main/services/ProxyService', () => ({ proxyService: {} }))
vi.mock('../src/main/services/OllamaService', () => ({ ollamaService: {} }))
vi.mock('../src/main/services/AccountWarmupService', () => ({
    accountWarmupService: {},
}))
vi.mock('../src/main/services/ReviewContentGenerator', () => ({
    reviewContentGenerator: {},
}))
vi.mock('../src/main/services/ReviewService', () => ({
    reviewService: {},
    shouldUseAgenticReview: vi.fn(),
}))
vi.mock('../src/main/services/LocationService', () => ({ locationService: {} }))
vi.mock('../src/main/automation/ReviewRecoveryService', () => ({
    reviewRecoveryService: {},
}))
vi.mock('../src/main/automation/BrowserService', () => ({ browserService: {} }))
vi.mock('../src/main/automation/GoogleAuthHandler', () => ({ googleAuthHandler: {} }))
vi.mock('../src/main/automation/GoogleMapsReviewHandler', () => ({
    googleMapsReviewHandler: {},
}))
vi.mock('../src/main/automation/AgenticReviewHandler', () => ({
    agenticReviewHandler: {},
}))
vi.mock('../src/main/automation/JobQueue', () => ({
    jobQueue: {},
    Job: {},
}))
vi.mock('../src/main/ipc/campaigns', () => ({ sendReviewProgress: vi.fn() }))
vi.mock('../src/main/ipc/settings', () => ({
    loadSettings: vi.fn(() => ({ enforceAccountWarmup: true, enableAgenticReview: false, lowResourceMode: false })),
}))
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }))
vi.mock('fs', () => ({
    existsSync: () => true,
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
}))

import {
    automationController,
    groupJobsByAccount,
    isWarmupNonTerminalStatus,
    pickThrottledWarmupKeeper,
    selectWarmupJobsToCancel,
    type WarmupGateJobRef,
} from '../src/main/automation/AutomationController'
import { loadSettings } from '../src/main/ipc/settings'

describe('Automation low-resource concurrency parity', () => {
    it.each([false, true])('preserves all configured threads with lowResourceMode=%s', (lowResourceMode) => {
        vi.mocked(loadSettings).mockReturnValue({ lowResourceMode } as ReturnType<typeof loadSettings>)
        const controller = automationController as unknown as {
            config: { threads: number }
            threads: Array<{ id: number; status: string }>
            initializeThreads: () => void
        }
        const previous = controller.config.threads
        try {
            controller.config.threads = 8
            controller.initializeThreads()
            expect(controller.threads).toHaveLength(8)
            expect(controller.threads.map(thread => thread.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
        } finally {
            controller.config.threads = previous
            controller.initializeThreads()
            vi.mocked(loadSettings).mockReturnValue({ enforceAccountWarmup: true, enableAgenticReview: false } as ReturnType<typeof loadSettings>)
        }
    })
})

function job(
    overrides: Partial<WarmupGateJobRef> & Pick<WarmupGateJobRef, 'id'>,
): WarmupGateJobRef {
    return {
        accountId: 1,
        status: 'pending',
        createdAt: '2026-07-14T10:00:00.000Z',
        ...overrides,
    }
}

describe('isWarmupNonTerminalStatus', () => {
    it('treats only pending and running as non-terminal', () => {
        expect(isWarmupNonTerminalStatus('pending')).toBe(true)
        expect(isWarmupNonTerminalStatus('running')).toBe(true)
        expect(isWarmupNonTerminalStatus('done')).toBe(false)
        expect(isWarmupNonTerminalStatus('cancelled')).toBe(false)
        expect(isWarmupNonTerminalStatus('failed')).toBe(false)
    })
})

describe('pickThrottledWarmupKeeper', () => {
    it('returns null when no active jobs', () => {
        expect(
            pickThrottledWarmupKeeper([
                job({ id: 'd1', status: 'done' }),
                job({ id: 'c1', status: 'cancelled' }),
            ]),
        ).toBeNull()
    })

    it('prefers running over older pending', () => {
        const keeper = pickThrottledWarmupKeeper([
            job({ id: 'p-old', status: 'pending', createdAt: '2026-07-14T09:00:00.000Z' }),
            job({ id: 'r-new', status: 'running', createdAt: '2026-07-14T12:00:00.000Z' }),
        ])
        expect(keeper?.id).toBe('r-new')
    })

    it('among pending picks oldest createdAt then id', () => {
        const keeper = pickThrottledWarmupKeeper([
            job({ id: 'b', status: 'pending', createdAt: '2026-07-14T11:00:00.000Z' }),
            job({ id: 'a', status: 'pending', createdAt: '2026-07-14T11:00:00.000Z' }),
            job({ id: 'c', status: 'pending', createdAt: '2026-07-14T10:00:00.000Z' }),
        ])
        expect(keeper?.id).toBe('c')
    })
})

describe('selectWarmupJobsToCancel', () => {
    const pendingThree: WarmupGateJobRef[] = [
        job({ id: 'j1', createdAt: '2026-07-14T10:00:00.000Z' }),
        job({ id: 'j2', createdAt: '2026-07-14T11:00:00.000Z' }),
        job({ id: 'j3', createdAt: '2026-07-14T12:00:00.000Z' }),
        job({ id: 'done-keep', status: 'done', createdAt: '2026-07-14T08:00:00.000Z' }),
    ]

    it('blocked: cancels all non-terminal, never done', () => {
        const ids = selectWarmupJobsToCancel(pendingThree, 'blocked', 0)
        expect(ids.sort()).toEqual(['j1', 'j2', 'j3'])
        expect(ids).not.toContain('done-keep')
    })

    it('throttled: keeps exactly 1 oldest pending, cancels excess', () => {
        const ids = selectWarmupJobsToCancel(pendingThree, 'throttled', 1)
        expect(ids.sort()).toEqual(['j2', 'j3'])
        expect(ids).not.toContain('j1')
        expect(ids).not.toContain('done-keep')
    })

    it('throttled with running: keeps running, cancels all pending', () => {
        const jobs: WarmupGateJobRef[] = [
            job({ id: 'p1', status: 'pending', createdAt: '2026-07-14T09:00:00.000Z' }),
            job({ id: 'p2', status: 'pending', createdAt: '2026-07-14T09:30:00.000Z' }),
            job({ id: 'r1', status: 'running', createdAt: '2026-07-14T10:00:00.000Z' }),
            job({ id: 'd1', status: 'done' }),
        ]
        const ids = selectWarmupJobsToCancel(jobs, 'throttled', 1)
        expect(ids.sort()).toEqual(['p1', 'p2'])
    })

    it('full / maxNonTerminal null: cancels nothing (ready runs normally)', () => {
        expect(selectWarmupJobsToCancel(pendingThree, 'full', null)).toEqual([])
        expect(selectWarmupJobsToCancel(pendingThree, 'full', null)).toEqual([])
    })

    it('throttled concurrent race: two running → cancel newer deterministically', () => {
        const jobs: WarmupGateJobRef[] = [
            job({ id: 'r-old', status: 'running', createdAt: '2026-07-14T10:00:00.000Z' }),
            job({ id: 'r-new', status: 'running', createdAt: '2026-07-14T11:00:00.000Z' }),
        ]
        expect(selectWarmupJobsToCancel(jobs, 'throttled', 1)).toEqual(['r-new'])
    })

    it('single pending throttled: cancel nothing', () => {
        expect(
            selectWarmupJobsToCancel(
                [job({ id: 'only' })],
                'throttled',
                1,
            ),
        ).toEqual([])
    })
})

describe('groupJobsByAccount', () => {
    it('groups by accountId for per-account prune', () => {
        const map = groupJobsByAccount([
            job({ id: 'a1', accountId: 10 }),
            job({ id: 'a2', accountId: 20 }),
            job({ id: 'a3', accountId: 10 }),
        ])
        expect(map.get(10)?.map(j => j.id).sort()).toEqual(['a1', 'a3'])
        expect(map.get(20)?.map(j => j.id)).toEqual(['a2'])
    })
})
