/**
 * IPC Handlers for Automation Scripts
 */

import { ipcMain } from 'electron'
import { scriptRunner } from '../automation/ScriptRunner'
import type { AutomationScript } from '../automation/ScriptTypes'
import { getDatabase } from '../database'
import { accounts, automationScripts } from '../database/schema'
import { eq, inArray } from 'drizzle-orm'
import { app } from 'electron'
import * as path from 'path'
import { loadSettings } from './settings'
import {
    automationScriptSchema,
    scriptIdSchema,
    scriptsRunSchema,
    scriptsRunWithAccountsSchema,
} from '../../shared/ipc-schemas'
import {
    assertPathWithinRoots,
    getDefaultAllowedRoots,
    parseIpcArgs,
    parseIpcPayload,
    withIpcValidation,
} from './validate'

// Helper: Convert DB row to AutomationScript
function rowToScript(row: {
    scriptId: string
    name: string
    description: string | null
    version: string | null
    createdAt: Date | number
    updatedAt: Date | number | null
    variables: string | null
    actions: string | null
    settings: string | null
}): AutomationScript {
    return {
        id: row.scriptId,
        name: row.name,
        description: row.description || '',
        version: row.version || '1.0.0',
        createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt * 1000),
        updatedAt: row.updatedAt instanceof Date
            ? row.updatedAt
            : new Date(((row.updatedAt ?? row.createdAt) as number) * 1000),
        variables: row.variables ? JSON.parse(row.variables) : [],
        actions: row.actions ? JSON.parse(row.actions) : [],
        settings: row.settings ? JSON.parse(row.settings) : {
            headless: loadSettings().headless ?? false,
            defaultTimeout: 30000,
            viewport: { width: 1366, height: 768 },
        },
    }
}

function toAutomationScript(parsed: ReturnType<typeof automationScriptSchema.parse>): AutomationScript {
    const defaults = {
        headless: Boolean(loadSettings().headless),
        defaultTimeout: 30000,
        viewport: { width: 1366, height: 768 },
    }
    return {
        id: parsed.id,
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        createdAt: parsed.createdAt ? new Date(parsed.createdAt) : new Date(),
        updatedAt: parsed.updatedAt ? new Date(parsed.updatedAt) : new Date(),
        variables: parsed.variables,
        actions: parsed.actions as AutomationScript['actions'],
        settings: parsed.settings
            ? {
                headless: parsed.settings.headless,
                defaultTimeout: parsed.settings.defaultTimeout,
                viewport: parsed.settings.viewport,
                userAgent: parsed.settings.userAgent,
                locale: parsed.settings.locale,
                timezone: parsed.settings.timezone,
            }
            : defaults,
    }
}

export function registerScriptHandlers() {
    console.log('Registering script IPC handlers...')

    // Get all saved scripts from database
    ipcMain.handle('scripts:getAll', withIpcValidation('scripts:getAll', async () => {
        console.log('Getting all scripts from database...')
        try {
            const db = getDatabase()
            const rows = await db.select().from(automationScripts)
            return rows.map(rowToScript)
        } catch (error) {
            console.error('Error getting scripts:', error)
            return []
        }
    }))

    // Save a script (upsert: insert or update)
    ipcMain.handle('scripts:save', withIpcValidation('scripts:save', async (_event, script: unknown) => {
        const parsed = parseIpcPayload('scripts:save', automationScriptSchema, script)
        const safeScript = toAutomationScript(parsed)
        console.log('Saving script to database:', safeScript.name)
        try {
            const db = getDatabase()
            const existing = await db.select()
                .from(automationScripts)
                .where(eq(automationScripts.scriptId, safeScript.id))
                .limit(1)

            const data = {
                name: safeScript.name,
                description: safeScript.description || '',
                version: safeScript.version || '1.0.0',
                actions: JSON.stringify(safeScript.actions || []),
                variables: JSON.stringify(safeScript.variables || []),
                settings: JSON.stringify(safeScript.settings || {}),
                updatedAt: new Date(),
            }

            if (existing.length > 0) {
                await db.update(automationScripts)
                    .set(data)
                    .where(eq(automationScripts.scriptId, safeScript.id))
            } else {
                await db.insert(automationScripts).values({
                    scriptId: safeScript.id,
                    ...data,
                    createdAt: new Date(),
                })
            }

            return { success: true }
        } catch (error) {
            console.error('Error saving script:', error)
            return { success: false, error: String(error) }
        }
    }))

    // Delete a script from database
    ipcMain.handle('scripts:delete', withIpcValidation('scripts:delete', async (_event, scriptId: unknown) => {
        const parsedId = parseIpcPayload('scripts:delete', scriptIdSchema, scriptId)
        console.log('Deleting script from database:', parsedId)
        try {
            const db = getDatabase()
            await db.delete(automationScripts)
                .where(eq(automationScripts.scriptId, parsedId))
            return { success: true }
        } catch (error) {
            console.error('Error deleting script:', error)
            return { success: false, error: String(error) }
        }
    }))

    // Run a script (simple, no account)
    ipcMain.handle('scripts:run', withIpcValidation('scripts:run', async (
        _event,
        script: unknown,
        variables?: unknown,
    ) => {
        const [parsedScript, parsedVars] = parseIpcArgs(
            'scripts:run',
            scriptsRunSchema,
            [script, variables],
        )
        const safeScript = toAutomationScript(parsedScript)
        console.log('Running script:', safeScript.name)
        try {
            const result = await scriptRunner.execute(safeScript, parsedVars || {})
            console.log('Script execution result:', result)
            return result
        } catch (error) {
            console.error('Script execution error:', error)
            return {
                success: false,
                startTime: new Date(),
                endTime: new Date(),
                totalActions: safeScript.actions.length,
                completedActions: 0,
                failedActions: 1,
                errors: [{ actionId: 'system', actionName: 'System', error: String(error), timestamp: new Date() }],
                variables: {},
                screenshots: [],
            }
        }
    }))

    // Run script with selected accounts (multi-account execution)
    ipcMain.handle('scripts:runWithAccounts', withIpcValidation('scripts:runWithAccounts', async (
        _event,
        script: unknown,
        accountIds: unknown,
        variables?: unknown,
    ) => {
        const [parsedScript, parsedAccountIds, parsedVars] = parseIpcArgs(
            'scripts:runWithAccounts',
            scriptsRunWithAccountsSchema,
            [script, accountIds, variables],
        )
        const safeScript = toAutomationScript(parsedScript)
        console.log('Running script with accounts:', safeScript.name, 'accounts:', parsedAccountIds)
        const results: Array<Record<string, unknown>> = []

        try {
            const db = getDatabase()
            const selectedAccounts = await db.select().from(accounts).where(inArray(accounts.id, parsedAccountIds))

            for (let i = 0; i < selectedAccounts.length; i++) {
                const account = selectedAccounts[i]
                console.log(`Running for account ${i + 1}/${selectedAccounts.length}: ${account.email}`)

                const rawProfilePath = account.profilePath || path.join(
                    app.getPath('userData'),
                    'browser-profiles',
                    `account-${account.id}`,
                )

                let profilePath: string
                try {
                    profilePath = assertPathWithinRoots(
                        'scripts:runWithAccounts',
                        rawProfilePath,
                        getDefaultAllowedRoots(),
                    )
                } catch (pathError) {
                    results.push({
                        accountId: account.id,
                        email: account.email,
                        success: false,
                        error: pathError instanceof Error ? pathError.message : String(pathError),
                    })
                    continue
                }

                try {
                    const result = await scriptRunner.execute(safeScript, parsedVars || {}, {
                        profilePath,
                        email: account.email,
                        name: account.email.split('@')[0],
                    })
                    results.push({ accountId: account.id, email: account.email, ...result })
                } catch (error) {
                    console.error(`Error running script for account ${account.email}:`, error)
                    results.push({
                        accountId: account.id,
                        email: account.email,
                        success: false,
                        error: String(error),
                    })
                }
            }
        } catch (error) {
            console.error('Error in runWithAccounts:', error)
            return { success: false, error: String(error), results }
        }

        const allSuccess = results.every(r => r.success)
        return { success: allSuccess, results }
    }))

    // Stop running script
    ipcMain.handle('scripts:stop', withIpcValidation('scripts:stop', async () => {
        console.log('Stopping script...')
        scriptRunner.stop()
        return { success: true }
    }))
}
