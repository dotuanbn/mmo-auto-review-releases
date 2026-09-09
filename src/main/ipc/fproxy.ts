/**
 * FProxy pool IPC. API keys and provider credentials never cross this boundary.
 */

import { BrowserWindow, ipcMain } from 'electron'
import { eq } from 'drizzle-orm'
import { getDatabase, schema } from '../database'
import { fproxyPoolService } from '../services/FProxyPoolService'
import { loadSettings } from './settings'
import {
    fproxyAddSlotSchema,
    fproxyPoolPolicySchema,
    fproxySetEnabledArgsSchema,
    fproxySlotIdSchema,
    fproxyTestAllInputSchema,
} from '../../shared/fproxy-pool-contracts'
import {
    fproxyApiKeySchema,
    fproxyTestApiInputSchema,
} from '../../shared/proxy-contracts'
import { parseIpcArgs, parseIpcPayload, withIpcValidation } from './validate'

const SNAPSHOT_EVENT = 'fproxy:poolSnapshot'
const LEGACY_MIGRATION_KEY = 'fproxy_pool_legacy_imported_v1'
let legacyImportPromise: Promise<void> | null = null
let snapshotBroadcastRegistered = false

export function registerFProxyHandlers() {
    registerSnapshotBroadcast()
    registerPoolHandlers()
    registerLegacyHandlers()
    void ensureLegacyImported().then(broadcastCurrentSnapshot).then(() => fproxyPoolService.startAutoRefresh()).catch(() => {
        // A later IPC request retries migration; never expose secret-related errors.
    })
}

function registerPoolHandlers(): void {
    ipcMain.handle('fproxy:getSnapshot', withIpcValidation('fproxy:getSnapshot', async () => {
        await ensureLegacyImported()
        return fproxyPoolService.getSnapshot()
    }))
    ipcMain.handle('fproxy:addSlot', withIpcValidation('fproxy:addSlot', async (_event, input: unknown) => {
        const payload = parseIpcPayload('fproxy:addSlot', fproxyAddSlotSchema, input)
        return fproxyPoolService.addSlot(payload)
    }))
    ipcMain.handle('fproxy:removeSlot', withIpcValidation('fproxy:removeSlot', async (_event, id: unknown) => {
        return fproxyPoolService.removeSlot(parseSlotId('fproxy:removeSlot', id))
    }))
    ipcMain.handle('fproxy:setEnabled', withIpcValidation(
        'fproxy:setEnabled',
        async (_event, id: unknown, enabled: unknown) => {
            const args = parseIpcArgs('fproxy:setEnabled', fproxySetEnabledArgsSchema, [id, enabled])
            return fproxyPoolService.setEnabled(args[0], args[1])
        },
    ))
    ipcMain.handle('fproxy:updatePolicy', withIpcValidation('fproxy:updatePolicy', async (_event, input: unknown) => {
        const policy = parseIpcPayload('fproxy:updatePolicy', fproxyPoolPolicySchema, input)
        return fproxyPoolService.updatePolicy(policy)
    }))
    ipcMain.handle('fproxy:testSlot', withIpcValidation('fproxy:testSlot', async (_event, id: unknown) => {
        return fproxyPoolService.testSlot(parseSlotId('fproxy:testSlot', id))
    }))
    ipcMain.handle('fproxy:testAll', withIpcValidation('fproxy:testAll', async (_event, input?: unknown) => {
        if (input !== undefined) {
            parseIpcPayload('fproxy:testAll', fproxyTestAllInputSchema, input)
        }
        return fproxyPoolService.testAll()
    }))
    ipcMain.handle('fproxy:refreshAll', withIpcValidation('fproxy:refreshAll', async () => {
        return fproxyPoolService.refreshAllSlots()
    }))
}

function registerLegacyHandlers(): void {
    ipcMain.handle('fproxy:setApiKey', withIpcValidation('fproxy:setApiKey', async (_event, input: unknown) => {
        const apiKey = parseIpcPayload('fproxy:setApiKey', fproxyApiKeySchema, input)
        const snapshot = await fproxyPoolService.upsertLegacyApiKey(apiKey)
        markLegacyMigrationComplete()
        return { success: true, snapshot }
    }))
    ipcMain.handle('fproxy:getNew', withIpcValidation('fproxy:getNew', async () => {
        await ensureLegacyImported()
        const id = requireDefaultSlot()
        return fproxyPoolService.rotateSlot(id)
    }))
    ipcMain.handle('fproxy:getInfo', withIpcValidation('fproxy:getInfo', async () => {
        await ensureLegacyImported()
        return getDefaultPublicSlot()
    }))
    ipcMain.handle('fproxy:test', withIpcValidation('fproxy:test', async () => {
        await ensureLegacyImported()
        return testDefaultSlotForLegacy()
    }))
    ipcMain.handle('fproxy:testApi', withIpcValidation(
        'fproxy:testApi',
        async (_event, input?: unknown) => {
            if (input !== undefined) {
                parseIpcPayload('fproxy:testApi', fproxyTestApiInputSchema, input)
            }
            await ensureLegacyImported()
            return testDefaultSlotForLegacy()
        },
    ))
}

async function ensureLegacyImported(): Promise<void> {
    if (legacyImportPromise) return legacyImportPromise
    legacyImportPromise = importLegacyIfNeeded().finally(() => {
        legacyImportPromise = null
    })
    return legacyImportPromise
}

async function importLegacyIfNeeded(): Promise<void> {
    if (isLegacyMigrationComplete()) return
    const snapshot = await fproxyPoolService.getSnapshot()
    if (snapshot.slots.length > 0) {
        markLegacyMigrationComplete()
        return
    }
    const settings = loadSettings() as Record<string, unknown>
    if (settings.useProxy !== true) return
    const apiKey = typeof settings.fproxyApiKey === 'string'
        ? settings.fproxyApiKey.trim()
        : ''
    if (apiKey) {
        await fproxyPoolService.upsertLegacyApiKey(apiKey)
        markLegacyMigrationComplete()
    }
}

function isLegacyMigrationComplete(): boolean {
    const row = getDatabase().select().from(schema.settings)
        .where(eq(schema.settings.key, LEGACY_MIGRATION_KEY)).get()
    return row?.value === 'true'
}

function markLegacyMigrationComplete(): void {
    getDatabase().insert(schema.settings).values({
        key: LEGACY_MIGRATION_KEY,
        value: 'true',
        updatedAt: new Date(),
    }).onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: 'true', updatedAt: new Date() },
    }).run()
}

async function testDefaultSlotForLegacy() {
    const result = await fproxyPoolService.testSlot(requireDefaultSlot())
    return {
        success: result.success,
        message: result.success ? 'fproxy_pool_test_ok' : result.error ?? 'provider_error',
        ip: result.currentEgress?.ip,
        latencyMs: result.latencyMs ?? undefined,
        location: result.currentEgress?.location ?? undefined,
    }
}

async function getDefaultPublicSlot() {
    const id = fproxyPoolService.getDefaultSlotId()
    if (id === null) return null
    const snapshot = await fproxyPoolService.getSnapshot()
    return snapshot.slots.find(slot => slot.id === id) ?? null
}

function requireDefaultSlot(): number {
    const id = fproxyPoolService.getDefaultSlotId()
    if (id === null) throw new Error('fproxy_slot_not_found')
    return id
}

function parseSlotId(channel: string, value: unknown): number {
    return parseIpcPayload(channel, fproxySlotIdSchema, value)
}

function registerSnapshotBroadcast(): void {
    if (snapshotBroadcastRegistered) return
    snapshotBroadcastRegistered = true
    fproxyPoolService.onSnapshot(snapshot => {
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.webContents.send(SNAPSHOT_EVENT, snapshot)
        }
    })
}

async function broadcastCurrentSnapshot(): Promise<void> {
    const snapshot = await fproxyPoolService.getSnapshot()
    for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(SNAPSHOT_EVENT, snapshot)
    }
}
