import { loadSettings } from '../ipc/settings'
import { miniRagService } from './MiniRagService'
import { ollamaService } from './OllamaService'
import { McpAdapterHealth, McpHealthReport } from '../runtime/v2/types'

class McpHealthService {
    private now(): string {
        return new Date().toISOString()
    }

    async getHealth(): Promise<McpHealthReport> {
        const adapters: McpAdapterHealth[] = []

        const ragStartedAt = Date.now()
        try {
            miniRagService.getStats()
            adapters.push({
                name: 'mini-rag-control-plane',
                enabled: true,
                healthy: true,
                latencyMs: Date.now() - ragStartedAt,
                detail: 'Mini-RAG stats available',
                checkedAt: this.now(),
            })
        } catch (error: unknown) {
            adapters.push({
                name: 'mini-rag-control-plane',
                enabled: true,
                healthy: false,
                latencyMs: Date.now() - ragStartedAt,
                detail: error instanceof Error ? error.message : String(error),
                checkedAt: this.now(),
            })
        }

        const ollamaUrl = String(loadSettings().ollamaUrl || '').trim()
        const ollamaStartedAt = Date.now()
        if (!ollamaUrl) {
            adapters.push({
                name: 'ollama-enrichment',
                enabled: false,
                healthy: false,
                detail: 'Ollama URL is empty',
                checkedAt: this.now(),
            })
        } else {
            try {
                const result = await ollamaService.testConnection(ollamaUrl)
                adapters.push({
                    name: 'ollama-enrichment',
                    enabled: true,
                    healthy: result.success === true,
                    latencyMs: Date.now() - ollamaStartedAt,
                    detail: result.success
                        ? `Connected (${(result.models || []).length} model(s))`
                        : (result.error || 'Connection failed'),
                    checkedAt: this.now(),
                })
            } catch (error: unknown) {
                adapters.push({
                    name: 'ollama-enrichment',
                    enabled: true,
                    healthy: false,
                    latencyMs: Date.now() - ollamaStartedAt,
                    detail: error instanceof Error ? error.message : String(error),
                    checkedAt: this.now(),
                })
            }
        }

        return {
            healthy: adapters.every(adapter => !adapter.enabled || adapter.healthy),
            adapters,
            checkedAt: this.now(),
        }
    }
}

export const mcpHealthService = new McpHealthService()
