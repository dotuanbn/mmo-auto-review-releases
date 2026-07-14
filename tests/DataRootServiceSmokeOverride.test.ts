import { describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        getPath: vi.fn(() => resolve('test-user-data')),
        setPath: vi.fn(),
    },
}))

import { resolveSmokeDataRootOverride } from '../src/main/services/DataRootService'

describe('resolveSmokeDataRootOverride', () => {
    const tempRoot = resolve('test-temp')

    it('does nothing unless explicit smoke mode is enabled', () => {
        expect(resolveSmokeDataRootOverride({}, tempRoot)).toBeNull()
    })

    it('requires a userData path in smoke mode', () => {
        expect(() =>
            resolveSmokeDataRootOverride({ MMO_SMOKE_MODE: '1' }, tempRoot),
        ).toThrow(/SMOKE_USER_DATA_DIR/)
    })

    it('accepts only a child of the temp mmo-packaged-smoke root', () => {
        const requested = join(tempRoot, 'mmo-packaged-smoke', 'run-1', 'user-data')
        expect(
            resolveSmokeDataRootOverride(
                { MMO_SMOKE_MODE: '1', SMOKE_USER_DATA_DIR: requested },
                tempRoot,
            ),
        ).toBe(resolve(requested))
    })

    it('rejects paths outside the dedicated smoke root', () => {
        const requested = join(tempRoot, 'real-user-data')
        expect(() =>
            resolveSmokeDataRootOverride(
                { MMO_SMOKE_MODE: '1', SMOKE_USER_DATA_DIR: requested },
                tempRoot,
            ),
        ).toThrow(/mmo-packaged-smoke/)
    })
})
