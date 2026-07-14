/**
 * Ollama IPC handlers — connection test URLs are loopback-only (SSRF guard).
 * Remote / metadata / non-http targets are rejected at the boundary.
 */

import { ipcMain } from 'electron'
import { ollamaService } from '../services/OllamaService'
import { ollamaTestConnectionUrlSchema } from '../../shared/ai-contracts'
import { loadSettings } from './settings'
import { parseIpcPayload, withIpcValidation } from './validate'

export function registerOllamaHandlers() {
    // Test connection — optional URL must be localhost / 127.0.0.1 / ::1 http(s) only
    ipcMain.handle(
        'ollama:testConnection',
        withIpcValidation('ollama:testConnection', async (_event, url?: unknown) => {
            const safeUrl = parseIpcPayload(
                'ollama:testConnection',
                ollamaTestConnectionUrlSchema,
                url,
            )
            return await ollamaService.testConnection(safeUrl)
        }),
    )

    // Get active config (no untrusted input)
    ipcMain.handle(
        'ollama:getConfig',
        withIpcValidation('ollama:getConfig', () => {
            const settings = loadSettings()
            return {
                url: settings.ollamaUrl || 'http://localhost:11434',
                model: settings.ollamaModel || 'qwen2.5:latest',
            }
        }),
    )

    console.log('Ollama handlers registered')
}
