/** Narrow MIT upstream a356198 backport for the pinned electron-builder 24 template. */
const fs = require('node:fs')
const path = require('node:path')

const LEGACY = [
  '      System::Store S',
  '      # Win7 has a per-user programfiles known folder and this can be a non-default location',
  '      System::Call \'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1\'',
  '      ${If} $1 == 0',
  "        System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'",
  '        StrCpy $0 $1',
  "        System::Call 'OLE32::CoTaskMemFree(p r2)'",
  '      ${endif}',
  '      System::Store L',
].join('\n')

const SAFE = [
  '      # MMO safe path backport: electron-builder a356198 (MIT).',
  '      Push $1',
  '      Push $2',
  '      StrCpy $2 0',
  '      System::Call \'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1\'',
  '      ${If} $1 == 0',
  "        System::Call 'KERNEL32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN})p'",
  '      ${endif}',
  '      ${If} $2 != 0',
  "        System::Call 'OLE32::CoTaskMemFree(p r2)'",
  '      ${endif}',
  '      Pop $2',
  '      Pop $1',
].join('\n')

function patchTemplate(source) {
  const normalized = source.replace(/\r\n/g, '\n')
  if (normalized.includes(SAFE) && !normalized.includes(LEGACY)) return source
  if (normalized.split(LEGACY).length !== 2) {
    throw new Error('Unrecognized NSIS per-user template. Review the upstream backport before packaging.')
  }
  const patched = normalized.replace(LEGACY, SAFE)
  return source.includes('\r\n') ? patched.replace(/\n/g, '\r\n') : patched
}

function applyPatch(context) {
  if (context && context.electronPlatformName !== 'win32') return
  const root = path.dirname(require.resolve('app-builder-lib/package.json'))
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  if (version !== '24.13.3') throw new Error(`Review NSIS safe-copy backport for app-builder-lib ${version}`)
  const file = path.join(root, 'templates', 'nsis', 'multiUser.nsh')
  const source = fs.readFileSync(file, 'utf8')
  const patched = patchTemplate(source)
  // Mechanical dependency backport: never rewrite unknown templates.
  if (patched !== source) fs.writeFileSync(file, patched)
  console.log('NSIS bounded shell-path copy verified (upstream a356198; app-builder-lib 24.13.3)')
}

module.exports = applyPatch
module.exports.patchTemplate = patchTemplate
module.exports.LEGACY = LEGACY
module.exports.SAFE = SAFE
if (require.main === module) applyPatch()
