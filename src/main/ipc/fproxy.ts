import { ipcMain } from 'electron'
import { fproxyService } from '../services/FProxyService'
import { browserService } from '../automation/BrowserService'

export function registerFProxyHandlers() {
    // Set API key
    ipcMain.handle('fproxy:setApiKey', async (_event, apiKey: string) => {
        fproxyService.setApiKey(apiKey)
        return { success: true }
    })

    // Rotate to get new proxy
    ipcMain.handle('fproxy:getNew', async () => {
        const data = await fproxyService.rotateProxy()
        return data
    })

    // Get proxy info for display
    ipcMain.handle('fproxy:getInfo', async () => {
        return fproxyService.getProxyInfo()
    })

    // Test proxy connection (runtime proxy via browser)
    ipcMain.handle('fproxy:test', async () => {
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
                await browserService.closeContext(contextId).catch(() => { /* ignore */ })
            }
        }
    })

    // Test proxy API config itself (Settings): call API endpoint, parse, + live connect test via returned proxy (~10s)
    ipcMain.handle('fproxy:testApi', async () => {
        return fproxyService.testApiConnection()
    })
}
