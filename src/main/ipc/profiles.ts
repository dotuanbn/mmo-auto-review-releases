import { ipcMain } from 'electron'
import { cpSync, existsSync, mkdirSync, rmSync } from 'fs'
import { basename, join } from 'path'
import { accountService } from '../services/AccountService'
import { profileService } from '../services/ProfileService'

interface ProfileSummary {
    accountId: number
    email: string
    profilePath: string | null
    exists: boolean
    hasCookies: boolean
    hasStorage: boolean
    sizeBytes: number
    createdAt?: Date
}

async function getProfileSummary(accountId: number): Promise<ProfileSummary> {
    const account = await accountService.getById(accountId)
    if (!account) {
        throw new Error(`Account ${accountId} not found`)
    }

    const profilePath = account.profilePath || null
    if (!profilePath) {
        return {
            accountId: account.id,
            email: account.email,
            profilePath: null,
            exists: false,
            hasCookies: false,
            hasStorage: false,
            sizeBytes: 0,
        }
    }

    const info = profileService.getProfileInfo(profilePath)
    return {
        accountId: account.id,
        email: account.email,
        profilePath,
        exists: info.exists,
        hasCookies: info.hasCookies,
        hasStorage: info.hasStorage,
        sizeBytes: info.sizeBytes,
        createdAt: info.createdAt,
    }
}

export function registerProfileHandlers() {
    ipcMain.handle('profiles:list', async () => {
        const accounts = await accountService.getAll()
        const summaries: ProfileSummary[] = []

        for (const account of accounts) {
            if (!account.profilePath) {
                summaries.push({
                    accountId: account.id,
                    email: account.email,
                    profilePath: null,
                    exists: false,
                    hasCookies: false,
                    hasStorage: false,
                    sizeBytes: 0,
                })
                continue
            }

            const info = profileService.getProfileInfo(account.profilePath)
            summaries.push({
                accountId: account.id,
                email: account.email,
                profilePath: account.profilePath,
                exists: info.exists,
                hasCookies: info.hasCookies,
                hasStorage: info.hasStorage,
                sizeBytes: info.sizeBytes,
                createdAt: info.createdAt,
            })
        }

        return summaries
    })

    ipcMain.handle('profiles:get', async (_event, accountId: number) => {
        return getProfileSummary(accountId)
    })

    ipcMain.handle('profiles:create', async (_event, accountId: number) => {
        const account = await accountService.getById(accountId)
        if (!account) {
            throw new Error(`Account ${accountId} not found`)
        }

        const profilePath = await profileService.createProfile(account.id, account.email)
        return getProfileSummary(account.id).then(summary => ({
            ...summary,
            profilePath,
        }))
    })

    ipcMain.handle('profiles:update', async (_event, payload: {
        accountId: number
        profilePath?: string
        basePath?: string
    }) => {
        const account = await accountService.getById(payload.accountId)
        if (!account) {
            throw new Error(`Account ${payload.accountId} not found`)
        }

        let targetPath = payload.profilePath
        if (!targetPath && payload.basePath) {
            const folderName = account.profilePath
                ? basename(account.profilePath)
                : `profile_${account.id}_${account.email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`
            targetPath = join(payload.basePath, folderName)
        }

        if (!targetPath) {
            throw new Error('profilePath or basePath is required')
        }

        mkdirSync(targetPath, { recursive: true })
        if (account.profilePath && existsSync(account.profilePath) && account.profilePath !== targetPath) {
            cpSync(account.profilePath, targetPath, { recursive: true, force: true })
        }

        await accountService.update(account.id, { profilePath: targetPath })
        return getProfileSummary(account.id)
    })

    ipcMain.handle('profiles:delete', async (_event, accountId: number) => {
        const account = await accountService.getById(accountId)
        if (!account) {
            throw new Error(`Account ${accountId} not found`)
        }

        if (account.profilePath && existsSync(account.profilePath)) {
            rmSync(account.profilePath, { recursive: true, force: true })
        }

        await accountService.update(account.id, { profilePath: null as any })
        return {
            success: true,
            accountId: account.id,
        }
    })

    ipcMain.handle('profiles:migrate', async (_event, payload: {
        accountId: number
        targetBasePath: string
    }) => {
        const account = await accountService.getById(payload.accountId)
        if (!account) {
            throw new Error(`Account ${payload.accountId} not found`)
        }

        if (!account.profilePath || !existsSync(account.profilePath)) {
            throw new Error('Source profile does not exist')
        }

        const targetPath = join(payload.targetBasePath, basename(account.profilePath))
        mkdirSync(targetPath, { recursive: true })
        cpSync(account.profilePath, targetPath, { recursive: true, force: true })

        await accountService.update(account.id, { profilePath: targetPath })
        return {
            success: true,
            accountId: account.id,
            sourcePath: account.profilePath,
            targetPath,
        }
    })
}

