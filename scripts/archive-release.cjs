#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function computeSha256(filePath) {
  const hash = crypto.createHash('sha256')
  const data = fs.readFileSync(filePath)
  hash.update(data)
  return hash.digest('hex')
}

function pickArtifacts(releaseDir, version) {
  const preferred = [
    `MMO-Auto-Review-Setup-${version}.exe`,
    `MMO-Auto-Review-Setup-${version}.exe.blockmap`,
    'latest.yml',
  ]

  const existingPreferred = preferred
    .map((name) => path.join(releaseDir, name))
    .filter((fullPath) => fs.existsSync(fullPath))

  const dynamicMatches = fs
    .readdirSync(releaseDir)
    .filter((name) => {
      if (name.includes(version)) return true
      return false
    })
    .map((name) => path.join(releaseDir, name))
    .filter((fullPath) => fs.statSync(fullPath).isFile())

  const latestYml = path.join(releaseDir, 'latest.yml')
  if (fs.existsSync(latestYml) && !dynamicMatches.includes(latestYml)) {
    dynamicMatches.push(latestYml)
  }

  const unique = Array.from(new Set([...existingPreferred, ...dynamicMatches]))
  return unique
}

function resolveArchiveDir(historyRoot, version) {
  const base = `v${version}`
  let candidate = path.join(historyRoot, base)
  if (!fs.existsSync(candidate)) {
    return { name: base, dir: candidate }
  }

  let revision = 2
  while (true) {
    const name = `${base}-r${revision}`
    candidate = path.join(historyRoot, name)
    if (!fs.existsSync(candidate)) {
      return { name, dir: candidate }
    }
    revision += 1
  }
}

function main() {
  const root = path.resolve(__dirname, '..')
  const pkgPath = path.join(root, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const version = pkg.version
  const releaseDir = path.join(root, 'release')
  const historyRoot = path.join(root, 'release-history')

  if (!fs.existsSync(releaseDir)) {
    throw new Error(`Release directory not found: ${releaseDir}`)
  }

  const artifacts = pickArtifacts(releaseDir, version)
  if (artifacts.length === 0) {
    throw new Error(`No release artifacts found for version ${version} in ${releaseDir}`)
  }

  ensureDir(historyRoot)
  const archiveTarget = resolveArchiveDir(historyRoot, version)
  ensureDir(archiveTarget.dir)

  const fileRecords = []
  for (const sourcePath of artifacts) {
    const fileName = path.basename(sourcePath)
    const destinationPath = path.join(archiveTarget.dir, fileName)
    fs.copyFileSync(sourcePath, destinationPath)
    const stat = fs.statSync(destinationPath)
    fileRecords.push({
      name: fileName,
      size: stat.size,
      sha256: computeSha256(destinationPath),
    })
  }

  const packageSnapshotPath = path.join(archiveTarget.dir, 'package.json.snapshot')
  fs.copyFileSync(pkgPath, packageSnapshotPath)
  const packageSnapshotStat = fs.statSync(packageSnapshotPath)
  fileRecords.push({
    name: 'package.json.snapshot',
    size: packageSnapshotStat.size,
    sha256: computeSha256(packageSnapshotPath),
  })

  const metadata = {
    app: pkg.name,
    version,
    archivedAt: new Date().toISOString(),
    sourceReleaseDir: path.relative(root, releaseDir) || 'release',
    archiveDir: path.relative(root, archiveTarget.dir),
    files: fileRecords,
  }
  fs.writeFileSync(
    path.join(archiveTarget.dir, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
    'utf8'
  )

  const indexPath = path.join(historyRoot, 'index.json')
  const index = readJsonSafe(indexPath, [])
  const nextIndex = Array.isArray(index) ? index : []
  nextIndex.unshift({
    version,
    archivedAt: metadata.archivedAt,
    folder: metadata.archiveDir,
    fileCount: fileRecords.length,
  })
  fs.writeFileSync(indexPath, JSON.stringify(nextIndex, null, 2), 'utf8')

  console.log(`[archive-release] Archived ${fileRecords.length} files to ${metadata.archiveDir}`)
}

try {
  main()
} catch (error) {
  console.error('[archive-release] Failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
}
