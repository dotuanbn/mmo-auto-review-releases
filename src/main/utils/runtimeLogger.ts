import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { RuntimeLogLevel } from '../runtime/v2/types'

export interface RuntimeLogger {
    level: RuntimeLogLevel
    child(bindings?: Record<string, unknown>): RuntimeLogger
    debug(...args: unknown[]): void
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
}

const levelOrder: Record<RuntimeLogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
}

let currentLevel: RuntimeLogLevel = 'info'
let baseBindings: Record<string, unknown> = {}

function safeSerialize(input: unknown): string {
    const seen = new WeakSet<object>()
    return JSON.stringify(input, (_key, value) => {
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value as object)) {
                return '[Circular]'
            }
            seen.add(value as object)
        }
        if (value instanceof Error) {
            return {
                name: value.name,
                message: value.message,
                stack: value.stack,
            }
        }
        return value
    })
}

function normalizeLogLevel(level: unknown): RuntimeLogLevel {
    const value = typeof level === 'string' ? level.toLowerCase().trim() : 'info'
    if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
        return value
    }
    return 'info'
}

function getLogFilePath(): string {
    try {
        const root = app.getPath('userData')
        const logsDir = join(root, 'logs')
        if (!existsSync(logsDir)) {
            mkdirSync(logsDir, { recursive: true })
        }
        return join(logsDir, 'runtime.ndjson')
    } catch {
        return join(process.cwd(), 'runtime.ndjson')
    }
}

function shouldWrite(level: RuntimeLogLevel): boolean {
    return levelOrder[level] >= levelOrder[currentLevel]
}

function writeLine(level: RuntimeLogLevel, bindings: Record<string, unknown>, args: unknown[]): void {
    if (!shouldWrite(level)) {
        return
    }

    const payload = {
        time: new Date().toISOString(),
        level,
        ...bindings,
        msg: args
            .map((item) => (typeof item === 'string' ? item : safeSerialize(item)))
            .join(' '),
    }

    const line = `${safeSerialize(payload)}\n`
    try {
        appendFileSync(getLogFilePath(), line)
    } catch {
        // Keep runtime resilient when filesystem is unavailable.
    }
}

function createLogger(bindings: Record<string, unknown> = {}): RuntimeLogger {
    return {
        get level() {
            return currentLevel
        },
        set level(value: RuntimeLogLevel) {
            currentLevel = normalizeLogLevel(value)
        },
        child(childBindings?: Record<string, unknown>) {
            return createLogger({
                ...bindings,
                ...(childBindings || {}),
            })
        },
        debug(...args: unknown[]) {
            writeLine('debug', bindings, args)
        },
        info(...args: unknown[]) {
            writeLine('info', bindings, args)
        },
        warn(...args: unknown[]) {
            writeLine('warn', bindings, args)
        },
        error(...args: unknown[]) {
            writeLine('error', bindings, args)
        },
    }
}

export function getRuntimeLogger(bindings?: Record<string, unknown>): RuntimeLogger {
    if (bindings) {
        return createLogger({
            ...baseBindings,
            ...bindings,
        })
    }
    return createLogger(baseBindings)
}

export function setRuntimeLogLevel(level: unknown): RuntimeLogLevel {
    const resolved = normalizeLogLevel(level)
    currentLevel = resolved
    return resolved
}

baseBindings = { name: 'mmo-runtime' }
