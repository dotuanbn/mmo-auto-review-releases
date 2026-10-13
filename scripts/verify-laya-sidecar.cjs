'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SOURCE_REL = 'scripts/laya-sidecar/laya_sidecar.py'
const REQUIRED_MODEL = [
  'model/multilingual/encoder/config.json',
  'model/multilingual/model.safetensors',
  'model/multilingual/rl_agent_config.json',
  'model/multilingual/tokenizer/tokenizer.json',
  'model/multilingual/tokenizer/tokenizer_config.json',
]
const REQUIRED_DLLS = ['python313.dll', 'python3.dll', 'vcruntime140.dll']
const AMD64 = 0x8664

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const options = {
    requireSignature: false,
    root: path.resolve(__dirname, '..', 'resources', 'laya-sidecar'),
  }
  for (const arg of argv) {
    if (arg === '--require-signature') {
      options.requireSignature = true
    } else if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length)
      if (!value) fail('Missing value for --root')
      options.root = path.resolve(value)
    } else if (arg === '--help') {
      console.log('Usage: node scripts/verify-laya-sidecar.cjs [--require-signature] [--root=<sidecar-dir>]')
      process.exit(0)
    } else {
      fail(`Unknown argument: ${arg}`)
    }
  }
  return options
}

function resolveInside(root, relativePath) {
  const normalized = String(relativePath).replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || /^[a-zA-Z]:/.test(normalized)) {
    fail(`Unsafe manifest path: ${relativePath}`)
  }
  if (normalized.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    fail(`Unsafe manifest path: ${relativePath}`)
  }
  const full = path.resolve(root, ...normalized.split('/'))
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  if (full !== root && !full.startsWith(prefix)) fail(`Manifest path escapes the sidecar root: ${relativePath}`)
  return full
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    let read = 0
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (read > 0) hash.update(buffer.subarray(0, read))
    } while (read > 0)
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function readPeMachine(filePath) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const dos = Buffer.alloc(64)
    if (fs.readSync(fd, dos, 0, 64, 0) !== 64) fail('Sidecar executable has a truncated DOS header')
    if (dos.toString('latin1', 0, 2) !== 'MZ') fail('Sidecar executable is not a PE file')
    const peOffset = dos.readUInt32LE(0x3c)
    if (peOffset < 64 || peOffset > 1024 * 1024) fail('Sidecar executable has an invalid PE header offset')
    const pe = Buffer.alloc(6)
    if (fs.readSync(fd, pe, 0, 6, peOffset) !== 6) fail('Sidecar executable has a truncated PE header')
    if (pe.toString('latin1', 0, 4) !== 'PE\u0000\u0000') fail('Sidecar executable is missing the PE signature')
    return pe.readUInt16LE(4)
  } finally {
    fs.closeSync(fd)
  }
}

function runAuthenticode(host, filePath) {
  // The path is JSON on stdin. It is never interpolated into the PowerShell command.
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$request = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    '$signature = Get-AuthenticodeSignature -LiteralPath $request.path',
    '$payload = [pscustomobject]@{ status = [string]$signature.Status; statusMessage = [string]$signature.StatusMessage }',
    '$payload | ConvertTo-Json -Compress',
  ].join('; ')
  return spawnSync(host, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', command,
  ], {
    input: JSON.stringify({ path: filePath }),
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  })
}

function authenticodeStatus(filePath) {
  let result = runAuthenticode('pwsh.exe', filePath)
  if (result.error && result.error.code === 'ENOENT') result = runAuthenticode('powershell.exe', filePath)
  if (result.error) fail(`Authenticode check could not start: ${result.error.message}`)
  if (result.status !== 0) fail('Authenticode check failed. Signature status was not claimed.')
  const line = String(result.stdout || '').split(/\r?\n/).map((item) => item.trim()).filter((item) => item.startsWith('{')).pop()
  if (!line) fail('Authenticode check returned no status. Signature status was not claimed.')
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    fail('Authenticode check returned unreadable status. Signature status was not claimed.')
  }
  if (!parsed || typeof parsed.status !== 'string' || !parsed.status) {
    fail('Authenticode check returned an empty status. Signature status was not claimed.')
  }
  return { status: parsed.status, statusMessage: typeof parsed.statusMessage === 'string' ? parsed.statusMessage : '' }
}

function loadJson(filePath, label) {
  if (!fs.existsSync(filePath)) fail(`Missing ${label}: ${filePath}`)
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    fail(`Unreadable ${label}: ${filePath}`)
  }
}

function assertFileRecord(relativePath, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail(`Manifest entry is invalid: ${relativePath}`)
  if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(record.sha256)) {
    fail(`Manifest hash is invalid: ${relativePath}`)
  }
  if (!Number.isSafeInteger(record.size) || record.size < 0) fail(`Manifest size is invalid: ${relativePath}`)
}

function verify(options) {
  if (process.platform !== 'win32') {
    fail('Laya sidecar verification must run on Windows. Signature status was not checked and is not claimed.')
  }
  const root = path.resolve(options.root)
  const repoRoot = path.resolve(__dirname, '..')
  const manifestPath = path.join(root, 'artifact-manifest.json')
  const manifest = loadJson(manifestPath, 'sidecar manifest')
  const modelLock = loadJson(path.join(__dirname, 'laya-sidecar', 'model-lock.json'), 'model lock')

  if (manifest.schema !== 1) fail(`Unsupported sidecar manifest schema: ${manifest.schema}`)
  if (manifest.arch !== 'win32-x64') fail(`Sidecar arch is ${manifest.arch}; expected win32-x64`)
  if (manifest.protocol !== 1) fail(`Sidecar manifest protocol is ${manifest.protocol}; expected 1`)
  if (!manifest.source || manifest.source.path !== SOURCE_REL) fail('Sidecar manifest does not record the current adapter source path')
  if (typeof manifest.source.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.source.sha256)) {
    fail('Sidecar manifest source hash is invalid')
  }

  const sourcePath = path.resolve(repoRoot, SOURCE_REL)
  if (!fs.existsSync(sourcePath)) fail(`Missing adapter source: ${sourcePath}`)
  const sourceHash = sha256File(sourcePath)
  if (sourceHash !== manifest.source.sha256.toLowerCase()) {
    fail('Sidecar source hash does not match scripts/laya-sidecar/laya_sidecar.py. Rebuild the sidecar; this artifact is stale.')
  }

  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    fail('Sidecar manifest file map is missing')
  }
  const relativePaths = Object.keys(manifest.files)
  if (relativePaths.length === 0) fail('Sidecar manifest file map is empty')

  for (const relativePath of relativePaths) {
    const record = manifest.files[relativePath]
    assertFileRecord(relativePath, record)
    const full = resolveInside(root, relativePath)
    if (!fs.existsSync(full)) fail(`Manifest file is missing: ${relativePath}`)
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`Manifest path is not a regular file: ${relativePath}`)
    if (stat.size !== record.size) fail(`Size mismatch for ${relativePath}: manifest ${record.size}, disk ${stat.size}`)
    const actual = sha256File(full)
    if (actual !== record.sha256.toLowerCase()) fail(`Hash mismatch for ${relativePath}`)
  }

  if (!manifest.files['laya-sidecar.exe']) fail('Manifest does not list laya-sidecar.exe')
  const exePath = resolveInside(root, 'laya-sidecar.exe')
  const machine = readPeMachine(exePath)
  if (machine !== AMD64) fail(`Sidecar PE machine is 0x${machine.toString(16)}; expected x64 (0x8664)`)

  if (modelLock.repository !== 'convaiinnovations/laya' || modelLock.revision !== '55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851') {
    fail('Model lock is not the pinned convaiinnovations/laya multilingual revision')
  }
  const locked = new Map()
  if (!Array.isArray(modelLock.files) || modelLock.files.length !== REQUIRED_MODEL.length) {
    fail('Model lock must contain exactly 5 files')
  }
  for (const file of modelLock.files) {
    const relativePath = `model/multilingual/${String(file.path || '').replace(/\\/g, '/')}`
    locked.set(relativePath, file)
  }
  for (const relativePath of REQUIRED_MODEL) {
    const expected = locked.get(relativePath)
    const actual = manifest.files[relativePath]
    if (!expected || !actual) fail(`Required model file is not in the manifest: ${relativePath}`)
    if (String(expected.sha256 || '').toLowerCase() !== actual.sha256.toLowerCase() || expected.size !== actual.size) {
      fail(`Required model file does not match the pinned lock: ${relativePath}`)
    }
  }

  for (const dllName of REQUIRED_DLLS) {
    const found = relativePaths.some((relativePath) => relativePath.replace(/\\/g, '/').toLowerCase().endsWith(`/${dllName.toLowerCase()}`))
    if (!found) fail(`Required runtime DLL is not in the manifest: ${dllName}`)
  }

  const signature = authenticodeStatus(exePath)
  const signed = signature.status === 'Valid'
  if (manifest.build && manifest.build.signed === true && !signed) {
    fail(`Manifest says the sidecar is signed, but Authenticode status is ${signature.status}.`)
  }
  if (options.requireSignature && !signed) {
    fail(`Release verification requires a valid Authenticode signature. Status: ${signature.status}. Not signed.`)
  }
  if (!signed && signature.status !== 'NotSigned') {
    fail(`Authenticode status is ${signature.status}. A present but invalid signature cannot be published or treated as a local unsigned build.`)
  }

  console.log(`Laya sidecar verification OK: ${exePath}`)
  console.log(`arch: ${manifest.arch}; protocol: ${manifest.protocol}; files: ${relativePaths.length}`)
  console.log(`source: ${sourceHash}`)
  if (signed) {
    console.log('signature: Valid')
  } else {
    console.log('signature: NOT SIGNED. Local artifact checks passed. This sidecar must not be published until Authenticode status is Valid.')
  }
}

if (require.main === module) {
  try {
    verify(parseArgs(process.argv.slice(2)))
  } catch (error) {
    fail(error && error.message ? error.message : 'Laya sidecar verification failed')
  }
}

module.exports = {
  authenticodeStatus,
  readPeMachine,
  resolveInside,
}
