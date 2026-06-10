import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { dirname, join } from 'path'

const PORTABLE_DATA_DIR = 'data'
const STABLE_PACKAGED_DATA_DIR = 'MMO Auto Review'
const LEGACY_DATA_CANDIDATES = ['mmo-auto-review', 'MMO Auto Review']

function nowSuffix(): string {
    return new Date().toISOString().replace(/[:.]/g, '-')
}

function ensureDirectory(path: string): void {
    if (!existsSync(path)) {
        mkdirSync(path, { recursive: true })
    }
}

function getPortableExecutableDir(): string | null {
    const envDir = process.env.PORTABLE_EXECUTABLE_DIR
    if (envDir && envDir.trim().length > 0) {
        return envDir
    }

    if (app.isPackaged) {
        return dirname(process.execPath)
    }

    return null
}

function shouldUsePortableMode(executableDir: string): boolean {
    const envMode = (process.env.MMO_PORTABLE_MODE || '').trim()
    if (envMode === '1' || envMode.toLowerCase() === 'true') {
        return true
    }

    const markerFile = join(executableDir, 'portable.mode')
    return existsSync(markerFile)
}

function maybeSeedDataIfTargetEmpty(targetPath: string, sourcePath: string): void {
    if (targetPath === sourcePath) {
        return
    }

    if (!existsSync(sourcePath)) {
        return
    }

    const sourceCount = safeCountEntries(sourcePath)
    if (sourceCount === 0) {
        return
    }

    const targetCount = safeCountEntries(targetPath)
    if (targetCount > 0) {
        return
    }

    cpSync(sourcePath, targetPath, { recursive: true, force: true })
}

function safeCountEntries(path: string): number {
    try {
        return readdirSync(path).length
    } catch {
        return 0
    }
}

class DataRootService {
    configurePortableUserDataPath(): { portable: boolean; dataRoot: string } {
        const portableDir = getPortableExecutableDir()
        if (!portableDir) {
            const current = app.getPath('userData')
            ensureDirectory(current)
            return { portable: false, dataRoot: current }
        }

        const defaultUserDataPath = app.getPath('userData')
        const portableMode = shouldUsePortableMode(portableDir)
        const dataRoot = portableMode
            ? join(portableDir, PORTABLE_DATA_DIR)
            : join(app.getPath('appData'), STABLE_PACKAGED_DATA_DIR)

        ensureDirectory(dataRoot)

        // Seed data once when moving between storage strategies.
        // 1) From old default Electron userData path
        maybeSeedDataIfTargetEmpty(dataRoot, defaultUserDataPath)
        // 2) From legacy portable root next to EXE
        maybeSeedDataIfTargetEmpty(dataRoot, join(portableDir, PORTABLE_DATA_DIR))

        app.setPath('userData', dataRoot)
        return { portable: portableMode, dataRoot }
    }

    getDataRoot(): string {
        const root = app.getPath('userData')
        ensureDirectory(root)
        return root
    }

    detectLegacyRoots(): Array<{ path: string; exists: boolean; fileCount: number }> {
        const appData = app.getPath('appData')
        return LEGACY_DATA_CANDIDATES.map(folderName => {
            const candidatePath = join(appData, folderName)
            const exists = existsSync(candidatePath)
            const fileCount = exists ? this.safeCountEntries(candidatePath) : 0
            return {
                path: candidatePath,
                exists,
                fileCount,
            }
        })
    }

    migrateLegacyData(sourcePath?: string): {
        success: boolean
        sourcePath?: string
        targetPath: string
        backupPath?: string
        message: string
    } {
        const targetPath = this.getDataRoot()
        const source = sourcePath || this.detectLegacyRoots().find(item => item.exists && item.fileCount > 0)?.path

        if (!source) {
            return {
                success: false,
                targetPath,
                message: 'No legacy data source found',
            }
        }

        if (!existsSync(source)) {
            return {
                success: false,
                sourcePath: source,
                targetPath,
                message: 'Legacy source path does not exist',
            }
        }

        let backupPath: string | undefined
        if (this.safeCountEntries(targetPath) > 0) {
            backupPath = `${targetPath}.backup-${nowSuffix()}`
            cpSync(targetPath, backupPath, { recursive: true, force: true })
        }

        cpSync(source, targetPath, { recursive: true, force: true })
        return {
            success: true,
            sourcePath: source,
            targetPath,
            backupPath,
            message: 'Legacy data migrated successfully',
        }
    }

    private safeCountEntries(path: string): number {
        return safeCountEntries(path)
    }
}

export const dataRootService = new DataRootService()
