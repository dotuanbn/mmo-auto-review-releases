import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const { patchTemplate, LEGACY, SAFE } = createRequire(resolve('package.json'))('./scripts/patch-nsis-safe-path.cjs') as {
    patchTemplate: (source: string) => string
    LEGACY: string
    SAFE: string
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    build: { beforePack: string }
}

describe('NSIS per-user shell path backport', () => {
    it('registers the backport for normal Windows packaging', () => {
        expect(pkg.build.beforePack).toBe('./scripts/patch-nsis-safe-path.cjs')
    })

    it('uses a bounded null-terminated copy and balanced register preservation', () => {
        const patched = patchTemplate(LEGACY)
        expect(patched).toBe(SAFE)
        expect(patched).toContain('KERNEL32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN})p')
        expect(patched).not.toContain('System::Store')
        expect(patched).not.toContain('&w${NSIS_MAX_STRLEN}')
        expect(patched).toContain('Push $1\n      Push $2')
        expect(patched).toContain('Pop $2\n      Pop $1')
        expect(patched).toContain('${If} $2 != 0')
        expect(patched).toContain('OLE32::CoTaskMemFree(p r2)')
    })

    it('preserves surrounding registry and directory logic, and is idempotent', () => {
        const prefix = 'ReadRegStr $perUserInstallationFolder HKCU\n'
        const suffix = '\n${StdUtils.GetParameter} $R0 "D" ""'
        const patched = patchTemplate(`${prefix}${LEGACY}${suffix}`)
        expect(patched).toBe(`${prefix}${SAFE}${suffix}`)
        expect(patchTemplate(patched)).toBe(patched)
        expect(patchTemplate(LEGACY.replace(/\n/g, '\r\n'))).toBe(SAFE.replace(/\n/g, '\r\n'))
    })

    it('fails closed for unknown or ambiguous dependency templates', () => {
        expect(() => patchTemplate('unrecognized upstream source')).toThrow(/Unrecognized/)
        expect(() => patchTemplate(`${LEGACY}\n${LEGACY}`)).toThrow(/Unrecognized/)
    })
})
