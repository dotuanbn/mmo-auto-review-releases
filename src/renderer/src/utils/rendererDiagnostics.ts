export type RendererEventLevel = 'info' | 'warn' | 'error'

function truncateMessage(message: string): string {
    return message.length > 1000 ? `${message.slice(0, 997)}...` : message
}

export function formatUnknownError(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`
    }
    return String(error)
}

export async function reportRendererEvent(message: string, level: RendererEventLevel = 'info'): Promise<void> {
    try {
        await window.electronAPI.reportRendererEvent({
            level,
            message: truncateMessage(message),
        })
    } catch {
        if (level === 'error') {
            console.error(message)
        }
    }
}
