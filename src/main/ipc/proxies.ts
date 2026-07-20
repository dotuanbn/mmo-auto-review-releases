/**
 * Proxy IPC handlers — runtime Zod validation at the boundary.
 * Public responses never include password secrets (PublicProxy + hasPassword).
 */

import { ipcMain } from 'electron'
import { proxyService } from '../services/ProxyService'
import {
    omitUndefinedFields,
    proxyCreateSchema,
    proxyIdSchema,
    proxyImportArgsSchema,
    proxyUpdateArgsSchema,
    type ProxyUpdateInput,
} from '../../shared/proxy-contracts'
import { parseIpcArgs, parseIpcPayload, withIpcValidation } from './validate'

export function registerProxyHandlers() {
    // Get all proxies — public DTO only
    ipcMain.handle(
        'proxies:getAll',
        withIpcValidation('proxies:getAll', async () => {
            return proxyService.getAllPublic()
        }),
    )

    // Get active proxies — public DTO only
    ipcMain.handle(
        'proxies:getActive',
        withIpcValidation('proxies:getActive', async () => {
            return proxyService.getActivePublic()
        }),
    )

    ipcMain.handle(
        'proxies:getActiveCount',
        withIpcValidation('proxies:getActiveCount', async () => {
            return proxyService.getActiveCount()
        }),
    )

    // Add new proxy — returns public DTO (no password)
    ipcMain.handle(
        'proxies:add',
        withIpcValidation('proxies:add', async (_event, data: unknown) => {
            const payload = parseIpcPayload('proxies:add', proxyCreateSchema, data)
            const created = await proxyService.create({
                host: payload.host,
                port: payload.port,
                username: payload.username,
                password: payload.password,
                type: payload.type,
                country: payload.country,
                provider: payload.provider,
                status: 'active',
                createdAt: new Date(),
            })
            return proxyService.toPublicProxy(created)
        }),
    )

    // Update proxy — blank password keeps secret; null clears; public DTO out
    ipcMain.handle(
        'proxies:update',
        withIpcValidation('proxies:update', async (_event, id: unknown, data: unknown) => {
            const [proxyId, payload] = parseIpcArgs(
                'proxies:update',
                proxyUpdateArgsSchema,
                [id, data],
            )
            const update: Partial<ProxyUpdateInput> = omitUndefinedFields(payload)
            if (Object.keys(update).length === 0) {
                const existing = await proxyService.getById(proxyId)
                return existing ? proxyService.toPublicProxy(existing) : undefined
            }
            const updated = await proxyService.update(
                proxyId,
                update as Parameters<typeof proxyService.update>[1],
            )
            return updated ? proxyService.toPublicProxy(updated) : undefined
        }),
    )

    // Delete proxy
    ipcMain.handle(
        'proxies:delete',
        withIpcValidation('proxies:delete', async (_event, id: unknown) => {
            const proxyId = parseIpcPayload('proxies:delete', proxyIdSchema, id)
            return await proxyService.delete(proxyId)
        }),
    )

    // HTTP quick check (native http/net)
    ipcMain.handle(
        'proxies:check',
        withIpcValidation('proxies:check', async (_event, id: unknown) => {
            const proxyId = parseIpcPayload('proxies:check', proxyIdSchema, id)
            return await proxyService.checkProxy(proxyId)
        }),
    )

    /**
     * Runtime-parity preflight (ProxyBridge + Playwright ephemeral path).
     * Returns structured reasonCode, latencyMs, observedIp, bridgeMode.
     */
    ipcMain.handle(
        'proxies:checkRuntime',
        withIpcValidation('proxies:checkRuntime', async (_event, id: unknown) => {
            const proxyId = parseIpcPayload('proxies:checkRuntime', proxyIdSchema, id)
            return await proxyService.checkProxyRuntime(proxyId)
        }),
    )

    // Check all proxies (HTTP quick)
    ipcMain.handle(
        'proxies:checkAll',
        withIpcValidation('proxies:checkAll', async () => {
            await proxyService.checkAllProxies()
            return { success: true }
        }),
    )

    // Import from text (bounded size + optional provider)
    ipcMain.handle(
        'proxies:importText',
        withIpcValidation(
            'proxies:importText',
            async (_event, text: unknown, defaultProvider?: unknown) => {
                const [importText, provider] = parseIpcArgs(
                    'proxies:importText',
                    proxyImportArgsSchema,
                    [text, defaultProvider],
                )
                return await proxyService.importFromText(importText, provider)
            },
        ),
    )

    // Delete dead proxies
    ipcMain.handle(
        'proxies:deleteDead',
        withIpcValidation('proxies:deleteDead', async () => {
            return proxyService.deleteDeadProxies()
        }),
    )

    // Get statistics
    ipcMain.handle(
        'proxies:getStats',
        withIpcValidation('proxies:getStats', async () => {
            return proxyService.getStats()
        }),
    )
}
