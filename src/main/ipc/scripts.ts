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

// Helper: Convert DB row to AutomationScript
function rowToScript(row: any): AutomationScript {
    return {
        id: row.scriptId,
        name: row.name,
        description: row.description || '',
        version: row.version || '1.0.0',
        createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt * 1000),
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date((row.updatedAt || row.createdAt) * 1000),
        variables: row.variables ? JSON.parse(row.variables) : [],
        actions: row.actions ? JSON.parse(row.actions) : [],
        settings: row.settings ? JSON.parse(row.settings) : {
            headless: loadSettings().headless ?? false,
            defaultTimeout: 30000,
            viewport: { width: 1366, height: 768 }
        }
    }
}

export function registerScriptHandlers() {
    console.log('Registering script IPC handlers...')

    // Get all saved scripts from database
    ipcMain.handle('scripts:getAll', async () => {
        console.log('Getting all scripts from database...')
        try {
            const db = getDatabase()
            const rows = await db.select().from(automationScripts)
            return rows.map(rowToScript)
        } catch (error) {
            console.error('Error getting scripts:', error)
            return []
        }
    })

    // Save a script (upsert: insert or update)
    ipcMain.handle('scripts:save', async (_event, script: AutomationScript) => {
        console.log('Saving script to database:', script.name)
        try {
            const db = getDatabase()
            const existing = await db.select()
                .from(automationScripts)
                .where(eq(automationScripts.scriptId, script.id))
                .limit(1)

            const data = {
                name: script.name,
                description: script.description || '',
                version: script.version || '1.0.0',
                actions: JSON.stringify(script.actions || []),
                variables: JSON.stringify(script.variables || []),
                settings: JSON.stringify(script.settings || {}),
                updatedAt: new Date()
            }

            if (existing.length > 0) {
                // Update existing
                await db.update(automationScripts)
                    .set(data)
                    .where(eq(automationScripts.scriptId, script.id))
            } else {
                // Insert new
                await db.insert(automationScripts).values({
                    scriptId: script.id,
                    ...data,
                    createdAt: new Date()
                })
            }

            return { success: true }
        } catch (error) {
            console.error('Error saving script:', error)
            return { success: false, error: String(error) }
        }
    })

    // Delete a script from database
    ipcMain.handle('scripts:delete', async (_event, scriptId: string) => {
        console.log('Deleting script from database:', scriptId)
        try {
            const db = getDatabase()
            await db.delete(automationScripts)
                .where(eq(automationScripts.scriptId, scriptId))
            return { success: true }
        } catch (error) {
            console.error('Error deleting script:', error)
            return { success: false, error: String(error) }
        }
    })

    // Run a script (simple, no account)
    ipcMain.handle('scripts:run', async (_event, script: AutomationScript, variables?: Record<string, any>) => {
        console.log('Running script:', script.name)
        try {
            const result = await scriptRunner.execute(script, variables || {})
            console.log('Script execution result:', result)
            return result
        } catch (error) {
            console.error('Script execution error:', error)
            return {
                success: false,
                startTime: new Date(),
                endTime: new Date(),
                totalActions: script.actions.length,
                completedActions: 0,
                failedActions: 1,
                errors: [{ actionId: 'system', actionName: 'System', error: String(error), timestamp: new Date() }],
                variables: {},
                screenshots: []
            }
        }
    })

    // Run script with selected accounts (multi-account execution)
    ipcMain.handle('scripts:runWithAccounts', async (_event, script: AutomationScript, accountIds: number[], variables?: Record<string, any>) => {
        console.log('Running script with accounts:', script.name, 'accounts:', accountIds)
        const results: any[] = []

        try {
            const db = getDatabase()
            const selectedAccounts = await db.select().from(accounts).where(inArray(accounts.id, accountIds))

            for (let i = 0; i < selectedAccounts.length; i++) {
                const account = selectedAccounts[i]
                console.log(`Running for account ${i + 1}/${selectedAccounts.length}: ${account.email}`)

                // Determine profile path
                const profilePath = account.profilePath || path.join(
                    app.getPath('userData'),
                    'browser-profiles',
                    `account-${account.id}`
                )

                try {
                    const result = await scriptRunner.execute(script, variables || {}, {
                        profilePath,
                        email: account.email,
                        name: account.email.split('@')[0]
                    })
                    results.push({ accountId: account.id, email: account.email, ...result })
                } catch (error) {
                    console.error(`Error running script for account ${account.email}:`, error)
                    results.push({
                        accountId: account.id,
                        email: account.email,
                        success: false,
                        error: String(error)
                    })
                }
            }
        } catch (error) {
            console.error('Error in runWithAccounts:', error)
            return { success: false, error: String(error), results }
        }

        const allSuccess = results.every(r => r.success)
        return { success: allSuccess, results }
    })

    // Stop running script
    ipcMain.handle('scripts:stop', async () => {
        console.log('Stopping script...')
        scriptRunner.stop()
        return { success: true }
    })
}
