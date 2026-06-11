import { ipcMain } from 'electron'
import { proxyService } from '../services/ProxyService'

export function registerProxyHandlers() {
    // Get all proxies
    ipcMain.handle('proxies:getAll', async () => {
        return proxyService.getAll()
    })

    // Get active proxies
    ipcMain.handle('proxies:getActive', async () => {
        return proxyService.getActive()
    })

    ipcMain.handle('proxies:getActiveCount', async () => {
        return proxyService.getActiveCount()
    })

    // Add new proxy
    ipcMain.handle('proxies:add', async (_event, data: {
        host: string
        port: number
        username?: string
        password?: string
        type?: 'http' | 'https' | 'socks5'
        country?: string
        provider?: string
    }) => {
        return proxyService.create({
            host: data.host,
            port: data.port,
            username: data.username,
            password: data.password,
            type: data.type || 'http',
            country: data.country,
            provider: data.provider,
            status: 'active',
            createdAt: new Date(),
        })
    })

    // Update proxy
    ipcMain.handle('proxies:update', async (_event, id: number, data: any) => {
        return proxyService.update(id, data)
    })

    // Delete proxy
    ipcMain.handle('proxies:delete', async (_event, id: number) => {
        return proxyService.delete(id)
    })

    // Check single proxy
    ipcMain.handle('proxies:check', async (_event, id: number) => {
        return proxyService.checkProxy(id)
    })

    // Check all proxies
    ipcMain.handle('proxies:checkAll', async () => {
        await proxyService.checkAllProxies()
        return { success: true }
    })

    // Import from text
    ipcMain.handle('proxies:importText', async (_event, text: string, defaultProvider?: string) => {
        return proxyService.importFromText(text, defaultProvider)
    })

    // Delete dead proxies
    ipcMain.handle('proxies:deleteDead', async () => {
        return proxyService.deleteDeadProxies()
    })

    // Get statistics
    ipcMain.handle('proxies:getStats', async () => {
        return proxyService.getStats()
    })
}
