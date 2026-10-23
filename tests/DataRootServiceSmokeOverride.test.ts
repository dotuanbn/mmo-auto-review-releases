import { afterEach, describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        getPath: vi.fn(() => resolve('test-user-data')),
        setPath: vi.fn(),
    },
}))

import { resolveSmokeDataRootOverride } from '../src/main/services/DataRootService'

const fixtures: string[] = []
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }) })

function tempFixture() {
    const root = mkdtempSync(join(tmpdir(), 'mmo-path-regression-'))
    fixtures.push(root)
    const temp = join(root, 'temp')
    const outside = join(root, 'outside')
    mkdirSync(join(temp, 'mmo-packaged-smoke'), { recursive: true })
    mkdirSync(outside)
    return { root, temp, outside }
}

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

    it('rejects relative paths and similarly prefixed siblings', () => {
        expect(() => resolveSmokeDataRootOverride({ MMO_SMOKE_MODE: '1', SMOKE_USER_DATA_DIR: 'user-data' }, tempRoot)).toThrow(/absolute/)
        const requested = join(tempRoot, 'mmo-packaged-smoke-other', 'user-data')
        expect(() => resolveSmokeDataRootOverride({ MMO_SMOKE_MODE: '1', SMOKE_USER_DATA_DIR: requested }, tempRoot)).toThrow(/mmo-packaged-smoke/)
    })

    it('canonicalizes temp aliases before checking a nonexistent descendant (Windows junction / short-path regression)', () => {
        const { root, temp } = tempFixture()
        const alias = join(root, 'temp-alias')
        symlinkSync(temp, alias, process.platform === 'win32' ? 'junction' : 'dir')
        const requested = join(alias, 'mmo-packaged-smoke', 'new-run', 'user-data')
        expect(resolveSmokeDataRootOverride({ MMO_SMOKE_MODE: '1', SMOKE_USER_DATA_DIR: requested }, temp))
            .toBe(join(temp, 'mmo-packaged-smoke', 'new-run', 'user-data'))
    })

    it('rejects a nonexistent child beneath a junction that escapes the smoke root', () => {
        const { temp, outside } = tempFixture()
        const junction = join(temp, 'mmo-packaged-smoke', 'escape')
        symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir')
        expect(() => resolveSmokeDataRootOverride({ MMO_SMOKE_MODE: '1', SMOKE_USER_DATA_DIR: join(junction, 'new-user-data') }, temp))
            .toThrow(/mmo-packaged-smoke/)
    })

    it('rejects replacing the entire allowed root with a junction outside temp', () => {
        const { temp, outside } = tempFixture()
        rmSync(join(temp, 'mmo-packaged-smoke'), { recursive: true })
        symlinkSync(outside, join(temp, 'mmo-packaged-smoke'), process.platform === 'win32' ? 'junction' : 'dir')
        expect(() => resolveSmokeDataRootOverride({ MMO_SMOKE_MODE: '1', SMOKE_USER_DATA_DIR: join(temp, 'mmo-packaged-smoke', 'new-user-data') }, temp))
            .toThrow(/mmo-packaged-smoke/)
    })

    it.runIf(process.platform !== 'win32')('does not treat POSIX filename backslashes as directory separators', () => {
        const requested = join(tempRoot, 'mmo-packaged-smoke\\..\\outside')
        expect(() => resolveSmokeDataRootOverride({ MMO_SMOKE_MODE: '1', SMOKE_USER_DATA_DIR: requested }, tempRoot)).toThrow(/mmo-packaged-smoke/)
    })
})
