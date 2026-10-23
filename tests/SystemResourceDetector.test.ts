import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserResourceGovernor } from '../src/main/services/BrowserResourceGovernor'

vi.mock('os', () => ({
    totalmem: () => 8 * 1024 ** 3,
    freemem: vi.fn(() => 500 * 1024 ** 2),
    cpus: () => Array.from({ length: 4 }, () => ({})),
}))
vi.mock('../src/main/utils/runtimeLogger', () => ({
    getRuntimeLogger: () => ({ warn: vi.fn(), info: vi.fn() }),
}))

import * as os from 'os'
import { systemResourceDetector } from '../src/main/services/SystemResourceDetector'

afterEach(() => { browserResourceGovernor.configure(false) })

describe('low-resource recommendation parity', () => {
    it.each([500, 1700])('does not add a concurrency or stagger override with %s MB free', (freeMB) => {
        vi.mocked(os.freemem).mockReturnValue(freeMB * 1024 ** 2)
        browserResourceGovernor.configure(false)
        const normal = systemResourceDetector.getRecommendations()
        browserResourceGovernor.configure(true)
        expect(systemResourceDetector.getRecommendations()).toEqual(normal)
    })
})
