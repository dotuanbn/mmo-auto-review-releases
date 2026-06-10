import { loadSettings, saveSettings } from '../ipc/settings'
import { writeAgenticLog } from '../utils/agenticLog'
import { aiService } from './AIService'

export interface OllamaResponse {
    model: string
    created_at: string
    response: string
    done: boolean
}

export interface OllamaChatResponse {
    model: string
    created_at: string
    message: {
        role: string
        content: string
    }
    done: boolean
}

class OllamaService {
    private CHAT_TIMEOUT_MS = 45000

    private normalizeBaseUrl(url: string): string {
        if (url.endsWith('/')) {
            url = url.slice(0, -1)
        }

        return url.replace('localhost', '127.0.0.1')
    }

    private getBaseUrl(): string {
        const settings = loadSettings()
        return this.normalizeBaseUrl(settings.ollamaUrl || 'http://localhost:11434')
    }

    private getModel(settings = loadSettings()): string {
        return settings.ollamaModel || 'qwen2.5:latest'
    }

    private async fetchAvailableModels(url: string): Promise<string[]> {
        const response = await fetch(`${url}/api/tags`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000)
        })

        if (!response.ok) {
            throw new Error(`Invalid response: ${response.statusText}`)
        }

        const data = await response.json()
        return data.models?.map((model: any) => model.name).filter(Boolean) || []
    }

    private getModelFamily(model: string): string {
        return model.split(':')[0].replace(/-coder$/i, '')
    }

    private pickAvailableModel(preferredModel: string, availableModels: string[]): string | undefined {
        if (availableModels.includes(preferredModel)) {
            return preferredModel
        }

        const preferredFamily = this.getModelFamily(preferredModel)
        const familyMatch = availableModels.find(model => this.getModelFamily(model) === preferredFamily)
        if (familyMatch) {
            return familyMatch
        }

        if (preferredFamily.includes('qwen')) {
            const qwenMatch = availableModels.find(model => this.getModelFamily(model).startsWith('qwen'))
            if (qwenMatch) {
                return qwenMatch
            }
        }

        return availableModels[0]
    }

    private async resolveModel(url: string): Promise<{ model: string; fallbackFrom?: string; availableModels: string[] }> {
        const settings = loadSettings()
        const preferredModel = this.getModel(settings)
        const availableModels = await this.fetchAvailableModels(url)

        if (availableModels.length === 0) {
            return { model: preferredModel, availableModels }
        }

        const resolvedModel = this.pickAvailableModel(preferredModel, availableModels) || preferredModel
        if (resolvedModel !== preferredModel) {
            console.warn(`[OllamaService] Model "${preferredModel}" not found. Falling back to "${resolvedModel}".`)
            settings.ollamaModel = resolvedModel
            saveSettings(settings)
            return { model: resolvedModel, fallbackFrom: preferredModel, availableModels }
        }

        return { model: resolvedModel, availableModels }
    }

    /**
     * Test connection to Ollama API
     */
    async testConnection(testUrl?: string): Promise<{ success: boolean; error?: string; models?: string[] }> {
        try {
            const url = this.normalizeBaseUrl(testUrl || this.getBaseUrl())
            const models = await this.fetchAvailableModels(url)

            if (models.length === 0) {
                return { success: false, error: 'No Ollama models installed', models: [] }
            }
            
            return { success: true, models }
        } catch (error: any) {
            return { success: false, error: error.message || 'Connection failed' }
        }
    }

    /**
     * Chat with AI for agent reasoning (supports JSON format).
     * Priority: Groq API (70B model, smarter) → Ollama local (fallback when offline/quota exceeded)
     */
    async chat(
        prompt: string,
        systemPrompt?: string,
        jsonFormat: boolean = false,
        timeoutMs: number = this.CHAT_TIMEOUT_MS
    ): Promise<{ success: boolean; response?: string; error?: string }> {
        // 1. Try Groq first (cloud, 70B model = much smarter planner)
        try {
            const groqResult = await aiService.chat(prompt, systemPrompt, jsonFormat)
            if (groqResult.success) {
                writeAgenticLog('OllamaService', `Groq primary success.`)
                return groqResult
            }
            writeAgenticLog('OllamaService', `Groq primary failed: ${groqResult.error}. Falling back to Ollama local.`)
        } catch (groqErr: any) {
            writeAgenticLog('OllamaService', `Groq primary error: ${groqErr.message}. Falling back to Ollama local.`)
        }

        // 2. Fallback to Ollama local
        try {
            const url = this.getBaseUrl()
            const { model, fallbackFrom } = await this.resolveModel(url)
            const startedAt = Date.now()

            const messages = []
            if (systemPrompt) {
                messages.push({ role: 'system', content: systemPrompt })
            }
            messages.push({ role: 'user', content: prompt })

            const requestBody: any = {
                model: model,
                messages: messages,
                stream: false,
                options: {
                    temperature: 0.1,
                    top_p: 0.9,
                }
            }

            if (jsonFormat) {
                requestBody.format = 'json'
            }

            const response = await fetch(`${url}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                signal: AbortSignal.timeout(timeoutMs)
            })

            if (!response.ok) {
                const errorText = await response.text()
                writeAgenticLog('OllamaService', `Ollama fallback failed for model=${model} in ${Date.now() - startedAt}ms with HTTP ${response.status}: ${errorText}`)
                throw new Error(`Ollama API Error: ${errorText}`)
            }

            const data: OllamaChatResponse = await response.json()
            
            if (data && data.message && data.message.content) {
                if (fallbackFrom) {
                    console.log(`[OllamaService] Auto-switched model from "${fallbackFrom}" to "${model}".`)
                }
                writeAgenticLog('OllamaService', `Ollama fallback success for model=${model} in ${Date.now() - startedAt}ms`)
                return { success: true, response: data.message.content }
            }

            writeAgenticLog('OllamaService', `Ollama fallback returned empty response for model=${model} in ${Date.now() - startedAt}ms`)
            throw new Error('Empty response from Ollama')
        } catch (error: any) {
            writeAgenticLog('OllamaService', `Both Groq AND Ollama failed. Last error: ${error.message}`)
            return { success: false, error: `Both Groq and Ollama failed. Ollama error: ${error.message}` }
        }
    }
}

export const ollamaService = new OllamaService()
