import { ipcMain } from 'electron'
import { ollamaService } from '../services/OllamaService'
import { loadSettings } from './settings'

export function registerOllamaHandlers() {
    // Test connection
    ipcMain.handle('ollama:testConnection', async (_event, url?: string) => {
        return await ollamaService.testConnection(url)
    })

    // Get active config
    ipcMain.handle('ollama:getConfig', () => {
        const settings = loadSettings()
        return {
            url: settings.ollamaUrl || 'http://localhost:11434',
            model: settings.ollamaModel || 'qwen2.5:latest'
        }
    })

    console.log('Ollama handlers registered')
}
