/**
 * Release workflow contracts — static checks for quality gate coupling,
 * packaged smoke, and publish-after-smoke policy.
 * Reads workflow YAML / scripts / package.json only (no Electron launch).
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const root = process.cwd()

function readRepoFile(...parts: string[]): string {
  const filePath = path.join(root, ...parts)
  expect(fs.existsSync(filePath), `missing file: ${filePath}`).toBe(true)
  return fs.readFileSync(filePath, 'utf8')
}

function indexOfOrThrow(haystack: string, needle: string, label: string): number {
  const idx = haystack.indexOf(needle)
  expect(idx, `${label}: expected to find ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0)
  return idx
}

const qualityYml = readRepoFile('.github', 'workflows', 'quality.yml')
const buildYml = readRepoFile('.github', 'workflows', 'build-macos.yml')
const smokeCjs = readRepoFile('scripts', 'app-feature-smoke.cjs')
const packagedPs1 = readRepoFile('scripts', 'packaged-feature-smoke.ps1')
const packageJson = JSON.parse(readRepoFile('package.json')) as {
  scripts?: Record<string, string>
  build?: { productName?: string; directories?: { output?: string } }
}

describe('quality.yml reusable workflow_call', () => {
  it('exposes workflow_call so release builds can depend on quality', () => {
    expect(qualityYml).toMatch(/workflow_call\s*:/)
    expect(qualityYml).toMatch(/on\s*:/)
    expect(qualityYml).toMatch(/gate:quick/)
    expect(qualityYml).toMatch(/test:run/)
  })

  it('still runs on push and pull_request', () => {
    expect(qualityYml).toMatch(/pull_request\s*:/)
    expect(qualityYml).toMatch(/push\s*:/)
  })
})

describe('build-macos.yml quality gate + publish-after-smoke', () => {
  it('calls the reusable quality workflow and gates both platform jobs on it', () => {
    expect(buildYml).toMatch(/uses:\s*\.\/\.github\/workflows\/quality\.yml/)
    expect(buildYml).toMatch(/needs:\s*quality/)

    // Both Windows and macOS build jobs must wait on quality
    const winJob = buildYml.indexOf('build-win:')
    const macJob = buildYml.indexOf('build-mac:')
    expect(winJob).toBeGreaterThanOrEqual(0)
    expect(macJob).toBeGreaterThanOrEqual(0)

    const winSection = buildYml.slice(winJob, macJob > winJob ? macJob : undefined)
    const macSection = buildYml.slice(macJob)
    expect(winSection).toMatch(/needs:\s*quality/)
    expect(macSection).toMatch(/needs:\s*quality/)
  })

  it('builds Windows with --publish never before any smoke or upload', () => {
    const winJob = buildYml.indexOf('build-win:')
    const macJob = buildYml.indexOf('build-mac:')
    const winSection = buildYml.slice(winJob, macJob > winJob ? macJob : undefined)

    const publishNeverIdx = indexOfOrThrow(
      winSection,
      '--publish never',
      'Windows electron-builder must not publish before smoke'
    )
    const unpackedSmokeIdx = indexOfOrThrow(
      winSection,
      'packaged-feature-smoke.ps1 -Mode unpacked',
      'Windows must smoke win-unpacked'
    )
    const nsisSmokeIdx = indexOfOrThrow(
      winSection,
      'packaged-feature-smoke.ps1 -Mode nsis',
      'Windows must smoke NSIS installed exe'
    )
    const uploadIdx = indexOfOrThrow(
      winSection,
      'Upload Windows artifacts to GitHub Release',
      'Windows must upload release artifacts after smoke'
    )

    expect(publishNeverIdx).toBeLessThan(unpackedSmokeIdx)
    expect(unpackedSmokeIdx).toBeLessThan(nsisSmokeIdx)
    expect(nsisSmokeIdx).toBeLessThan(uploadIdx)

    // Upload is tag-gated; workflow_dispatch without tag must not upload release
    expect(winSection).toMatch(/if:\s*startsWith\(github\.ref,\s*'refs\/tags\/'\)/)
    expect(winSection).not.toMatch(/electron-builder --win --publish always/)
    // No heavy extra installer build step beyond the single electron-builder --win
    expect(winSection).not.toMatch(/build:installer|npm run build:installer/)
  })

  it('uploads only after smoke and targets the releases repository', () => {
    const winJob = buildYml.indexOf('build-win:')
    const macJob = buildYml.indexOf('build-mac:')
    const winSection = buildYml.slice(winJob, macJob > winJob ? macJob : undefined)

    expect(winSection).toMatch(/softprops\/action-gh-release@v2/)
    expect(winSection).toMatch(/dotuanbn\/mmo-auto-review-releases/)
    expect(winSection).toMatch(/MMO-Auto-Review-Setup-\*\.exe/)
  })

  it('macOS build also uses publish never then tag-gated upload', () => {
    const macJob = buildYml.indexOf('build-mac:')
    const macSection = buildYml.slice(macJob)
    expect(macSection).toMatch(/--publish never/)
    expect(macSection).toMatch(/Upload macOS artifacts to GitHub Release/)
    expect(macSection).toMatch(/if:\s*startsWith\(github\.ref,\s*'refs\/tags\/'\)/)
  })
})

describe('app-feature-smoke.cjs packaged mode contracts', () => {
  it('supports SMOKE_EXECUTABLE / isolated dirs and unsets ELECTRON_RUN_AS_NODE', () => {
    expect(smokeCjs).toMatch(/SMOKE_EXECUTABLE/)
    expect(smokeCjs).toMatch(/SMOKE_OUT_DIR/)
    expect(smokeCjs).toMatch(/SMOKE_USER_DATA_DIR/)
    expect(smokeCjs).toMatch(/delete env\.ELECTRON_RUN_AS_NODE|ELECTRON_RUN_AS_NODE/)
    expect(smokeCjs).toMatch(/MMO_SMOKE_MODE/)
    expect(smokeCjs).toMatch(/app userData is not isolated/)
    expect(smokeCjs).toMatch(/buildLaunchEnv|resolveLaunchConfig/)
    expect(smokeCjs).toMatch(/mode:\s*'packaged'|mode === 'packaged'|"packaged"/)
  })

  it('uses strict non-zero exit on failure (no fake pass)', () => {
    expect(smokeCjs).toMatch(/process\.exitCode\s*=\s*1/)
    expect(smokeCjs).toMatch(/process\.exit\(/)
    // Still runs the real feature assertions
    expect(smokeCjs).toMatch(/app\.bridge-isolated/)
    expect(smokeCjs).toMatch(/captcha\.metrics/)
    expect(smokeCjs).toMatch(/traffic\.web-seo-config/)
  })

  it('covers reconciliation list, backup list/create/inspect, compliance audit, traffic stats/recover', () => {
    expect(smokeCjs).toMatch(/reconciliation\.list/)
    expect(smokeCjs).toMatch(/getPendingReviewIntents/)
    expect(smokeCjs).toMatch(/backup\.list-create-inspect/)
    expect(smokeCjs).toMatch(/listBackups/)
    expect(smokeCjs).toMatch(/createBackup/)
    expect(smokeCjs).toMatch(/inspectBackup/)
    expect(smokeCjs).toMatch(/compliance\.audit/)
    expect(smokeCjs).toMatch(/getComplianceAudit/)
    expect(smokeCjs).toMatch(/getVisitQueueStats/)
    expect(smokeCjs).toMatch(/recoverVisitLeases/)
  })

  it('only restores against isolated smoke userData', () => {
    expect(smokeCjs).toMatch(/backup\.restore-isolated/)
    expect(smokeCjs).toMatch(/allowIsolatedRestore/)
    expect(smokeCjs).toMatch(/restore refused: userData is not an isolated smoke path/)
    expect(smokeCjs).toMatch(/confirmation:\s*'RESTORE'/)
    expect(smokeCjs).toMatch(/restoreBackup/)
  })

  it('does not launch packaged apps with project-root "." as first arg', () => {
    // Packaged branch args must be user-data-dir only; dev keeps ['.', ...]
    expect(smokeCjs).toMatch(/args:\s*\[`?--user-data-dir=/)
    expect(smokeCjs).toMatch(/args:\s*\[\s*'\.'\s*,/)
  })
})

describe('packaged-feature-smoke.ps1 safety contracts', () => {
  it('stays ASCII-safe for Windows PowerShell 5 parsing', () => {
    expect(packagedPs1).not.toMatch(/[^\x00-\x7F]/)
  })

  it('supports unpacked and nsis modes with isolated temp paths', () => {
    expect(packagedPs1).toMatch(/ValidateSet\('unpacked',\s*'nsis'\)/)
    expect(packagedPs1).toMatch(/mmo-packaged-smoke/)
    expect(packagedPs1).toMatch(/GetTempPath|TEMP/)
    expect(packagedPs1).toMatch(/user-data/)
    expect(packagedPs1).toMatch(/SMOKE_EXECUTABLE/)
    expect(packagedPs1).toMatch(/SMOKE_USER_DATA_DIR/)
    expect(packagedPs1).toMatch(/SMOKE_OUT_DIR/)
  })

  it('unsets ELECTRON_RUN_AS_NODE and uses silent NSIS /S /D=', () => {
    expect(packagedPs1).toMatch(/Remove-Item Env:ELECTRON_RUN_AS_NODE/)
    expect(packagedPs1).toMatch(/\/S/)
    expect(packagedPs1).toMatch(/\/D=/)
    expect(packagedPs1).toMatch(/MMO-Auto-Review-Setup-\*\.exe/)
    expect(packagedPs1).toMatch(/win-unpacked/)
  })

  it('uses strict exit codes and never fakes success', () => {
    expect(packagedPs1).toMatch(/Assert-ExitZero|exit code/)
    expect(packagedPs1).toMatch(/\$exitCode\s*=\s*1/)
    expect(packagedPs1).toMatch(/exit \$exitCode/)
    // Success path must set 0 explicitly
    expect(packagedPs1).toMatch(/\$exitCode\s*=\s*0/)
    // Must not contain always-exit-0 anti-pattern without failure path
    expect(packagedPs1).not.toMatch(/exit 0\s*\n\s*catch/)
  })

  it('refuses unsafe install roots', () => {
    expect(packagedPs1).toMatch(/Refusing unsafe InstallDir/)
    expect(packagedPs1).toMatch(/ProgramFiles|SystemRoot/)
  })

  it('cleans temp only under TEMP\\mmo-packaged-smoke', () => {
    expect(packagedPs1).toMatch(/mmo-packaged-smoke/)
    expect(packagedPs1).toMatch(/Skipping cleanup|underTempSmoke|GetTempPath/)
    expect(packagedPs1).toMatch(/Remove-Item -LiteralPath \$safeRoot/)
  })
})

describe('package.json smoke scripts', () => {
  it('exposes app and packaged smoke entry points', () => {
    const scripts = packageJson.scripts ?? {}
    expect(scripts['smoke:app']).toMatch(/app-feature-smoke\.cjs/)
    expect(scripts['smoke:packaged:unpacked']).toMatch(/packaged-feature-smoke\.ps1/)
    expect(scripts['smoke:packaged:unpacked']).toMatch(/unpacked/)
    expect(scripts['smoke:packaged:nsis']).toMatch(/packaged-feature-smoke\.ps1/)
    expect(scripts['smoke:packaged:nsis']).toMatch(/nsis/)
    expect(scripts['smoke:packaged']).toMatch(/smoke:packaged:unpacked/)
    expect(scripts['smoke:packaged']).toMatch(/smoke:packaged:nsis/)
  })

  it('keeps release output directory as release/', () => {
    expect(packageJson.build?.directories?.output).toBe('release')
    expect(packageJson.build?.productName).toBe('MMO Auto Review')
  })
})
