import { appendFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

function getLogPath(): string {
    return join(app.getPath('userData'), 'agentic-debug.log')
}

export function writeAgenticLog(scope: string, message: string): void {
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] [${scope}] ${message}\n`

    try {
        appendFileSync(getLogPath(), line)
    } catch {
        // Avoid crashing automation because file logging failed.
    }
}
