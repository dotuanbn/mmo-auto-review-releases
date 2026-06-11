import { ZodError } from 'zod'

export function createIpcError(channel: string, error: unknown): Error {
    if (error instanceof ZodError) {
        const details = error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ')
        return new Error(`[${channel}] payload validation failed: ${details}`)
    }

    if (error instanceof Error) {
        return new Error(`[${channel}] ${error.message}`)
    }

    return new Error(`[${channel}] ${String(error)}`)
}
