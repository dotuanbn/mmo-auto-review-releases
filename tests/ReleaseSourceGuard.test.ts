import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const version: string = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version

function check(type: string, name: string) {
    return spawnSync(process.execPath, [resolve('scripts/verify-release-source.cjs')], {
        env: { ...process.env, GITHUB_REF_TYPE: type, GITHUB_REF_NAME: name }, encoding: 'utf8',
    })
}

describe('release source provenance guard', () => {
    it('accepts the version matching the release tag', () => {
        expect(check('tag', `v${version}`).status).toBe(0)
    })
    it('refuses a tag pointing to a different source version', () => {
        const result = check('tag', 'v0.0.0-stale-source')
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('does not match source version')
    })
    it('fails closed when tag context has no tag name', () => {
        expect(check('tag', '').status).toBe(1)
    })
    it('permits local and manual non-tag builds', () => {
        expect(check('branch', 'master').status).toBe(0)
    })
})
