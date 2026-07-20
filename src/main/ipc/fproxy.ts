/**
 * FProxy IPC handlers — API key input validated at the boundary.
 * Secrets are never logged or returned in responses.
 */

import { ipcMain } from 'electron'
import { fproxyService } from '../services/FProxyService'
import { browserService } from '../automation/BrowserService'
import {
    fproxyApiKeySchema,
    fproxyTestApiInputSchema,
} from '../../shared/proxy-contracts'
import { parseIpcPayload, withIpcValidation } from './validate'

export function registerFProxyHandlers() {
    // Set API key (empty string clears configuration in service)
    ipcMain.handle(
        'fproxy:setApiKey',
        withIpcValidation('fproxy:setApiKey', async (_event, apiKey: unknown) => {
            const key = parseIpcPayload('fproxy:setApiKey', fproxyApiKeySchema, apiKey)
            fproxyService.setApiKey(key)
            return { success: true }
        }),
    )

    // Rotate to get new proxy
    ipcMain.handle(
        'fproxy:getNew',
        withIpcValidation('fproxy:getNew', async () => {
            const data = await fproxyService.rotateProxy()
            return data
        }),
    )

    // Get proxy info for display
    ipcMain.handle(
        'fproxy:getInfo',
        withIpcValidation('fproxy:getInfo', async () => {
            return fproxyService.getProxyInfo()
        }),
    )

    // Test proxy connection (runtime proxy via browser)
    ipcMain.handle(
        'fproxy:test',
        withIpcValidation('fproxy:test', async () => {
            const proxy = await fproxyService.getProxyForBrowser()
            if (!proxy) return { success: false, message: 'No API key or proxy unavailable' }

            let contextId: number | null = null
            try {
                contextId = await browserService.createEphemeralContext({
                    headless: true,
                    proxy,
                })
                const page = browserService.getPage(contextId)
                if (!page) {
                    throw new Error('Cannot create browser page')
                }

                await page.goto('https://www.google.com/', {
                    timeout: 30_000,
                    waitUntil: 'domcontentloaded',
                })
                await page.goto('https://www.google.com/maps', {
                    timeout: 30_000,
                    waitUntil: 'domcontentloaded',
                })

                return {
                    success: true,
                    proxy: `${proxy.host}:${proxy.port}`,
                    username: proxy.username,
                    location: fproxyService.getProxyInfo()?.location || '',
                    message: 'Runtime ephemeral HTTPS + Google Maps OK',
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return {
                    success: false,
                    proxy: `${proxy.host}:${proxy.port}`,
                    location: fproxyService.getProxyInfo()?.location || '',
                    message: `Proxy cannot open HTTPS/Maps (${message.split('\n')[0]})`,
                }
            } finally {
                if (contextId !== null) {
                    await browserService.closeContext(contextId).catch(() => {
                        /* ignore */
                    })
                }
            }
        }),
    )

    // Test proxy API config itself (Settings): no payload — uses key already in main
    ipcMain.handle(
        'fproxy:testApi',
        withIpcValidation('fproxy:testApi', async (_event, input?: unknown) => {
            // Reject unexpected non-empty payloads; undefined/null/omitted is OK
            if (input !== undefined) {
                parseIpcPayload('fproxy:testApi', fproxyTestApiInputSchema, input)
            }
            return fproxyService.testApiConnection()
        }),
    )
}
