import {
    FProxyApiError,
    type FProxyEndpoint,
    type FProxyRequestOptions,
} from '../../src/main/services/FProxyApiClient'

export type FakeFProxyMode = 'current' | 'new'

export interface FakeFProxyCall {
    mode: FakeFProxyMode
    apiKey: string
    signal?: AbortSignal
}

export interface Deferred<T> {
    promise: Promise<T>
    resolve(value: T): void
    reject(error: unknown): void
}

type ScriptedResult =
    | { kind: 'endpoint'; endpoint: FProxyEndpoint }
    | { kind: 'error'; error: Error }
    | { kind: 'deferred'; deferred: Deferred<FProxyEndpoint> }

export function createDeferred<T>(): Deferred<T> {
    let resolvePromise!: (value: T) => void
    let rejectPromise!: (error: unknown) => void
    const promise = new Promise<T>((resolve, reject) => {
        resolvePromise = resolve
        rejectPromise = reject
    })
    return {
        promise,
        resolve: resolvePromise,
        reject: rejectPromise,
    }
}

export function createFakeEndpoint(
    sequence: number,
    overrides: Partial<FProxyEndpoint> = {},
): FProxyEndpoint {
    const now = Date.now()
    const base: FProxyEndpoint = {
        proxySnapshot: {
            host: `198.51.100.${sequence}`,
            port: 20_000 + sequence,
            username: `fake-user-${sequence}`,
            password: `fake-pass-${sequence}`,
            type: 'http',
        },
        observedIp: `203.0.113.${sequence}`,
        endpointExpiresAt: now + 180_000,
        rotateAllowedAt: now - 1,
        location: `Fake Location ${sequence}`,
        receivedAt: now,
    }
    return {
        ...base,
        ...overrides,
        proxySnapshot: {
            ...base.proxySnapshot,
            ...overrides.proxySnapshot,
            type: 'http',
        },
    }
}

/**
 * Script-only FProxy client. Every call must be explicitly queued, so an
 * accidental provider/network access becomes a deterministic test failure.
 */
export class FakeFProxyProvider {
    readonly calls: FakeFProxyCall[] = []
    private readonly scripts = new Map<string, ScriptedResult[]>()

    enqueueEndpoint(
        apiKey: string,
        mode: FakeFProxyMode,
        endpoint: FProxyEndpoint,
    ): void {
        this.enqueue(apiKey, mode, { kind: 'endpoint', endpoint })
    }

    enqueueError(apiKey: string, mode: FakeFProxyMode, error: Error): void {
        this.enqueue(apiKey, mode, { kind: 'error', error })
    }

    enqueueDeferred(
        apiKey: string,
        mode: FakeFProxyMode,
        deferred: Deferred<FProxyEndpoint>,
    ): void {
        this.enqueue(apiKey, mode, { kind: 'deferred', deferred })
    }

    getCurrent(
        apiKey: string,
        options: FProxyRequestOptions = {},
    ): Promise<FProxyEndpoint> {
        return this.dispatch('current', apiKey, options)
    }

    getNew(
        apiKey: string,
        options: FProxyRequestOptions = {},
    ): Promise<FProxyEndpoint> {
        return this.dispatch('new', apiKey, options)
    }

    countCalls(apiKey: string, mode?: FakeFProxyMode): number {
        return this.calls.filter(call =>
            call.apiKey === apiKey && (mode === undefined || call.mode === mode)
        ).length
    }

    private enqueue(apiKey: string, mode: FakeFProxyMode, result: ScriptedResult): void {
        const key = this.scriptKey(apiKey, mode)
        const queue = this.scripts.get(key) ?? []
        queue.push(result)
        this.scripts.set(key, queue)
    }

    private async dispatch(
        mode: FakeFProxyMode,
        apiKey: string,
        options: FProxyRequestOptions,
    ): Promise<FProxyEndpoint> {
        this.calls.push({ mode, apiKey, signal: options.signal })
        if (options.signal?.aborted) {
            throw new FProxyApiError('aborted', true)
        }
        const key = this.scriptKey(apiKey, mode)
        const result = this.scripts.get(key)?.shift()
        if (!result) {
            throw new FProxyApiError('provider_response_invalid', false)
        }
        if (result.kind === 'error') {
            throw result.error
        }
        if (result.kind === 'endpoint') {
            return result.endpoint
        }
        return awaitWithAbort(result.deferred.promise, options.signal)
    }

    private scriptKey(apiKey: string, mode: FakeFProxyMode): string {
        return `${mode}\0${apiKey}`
    }
}

async function awaitWithAbort<T>(
    promise: Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    if (!signal) return promise
    if (signal.aborted) throw new FProxyApiError('aborted', true)
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new FProxyApiError('aborted', true))
        signal.addEventListener('abort', onAbort, { once: true })
        promise.then(
            value => {
                signal.removeEventListener('abort', onAbort)
                resolve(value)
            },
            error => {
                signal.removeEventListener('abort', onAbort)
                reject(error)
            },
        )
    })
}

export interface FakeFProxyKeyRow {
    id: number
    label: string
    apiKeyCiphertext: string
    enabled: boolean
    createdAt: Date
    updatedAt: Date
}

export interface FakeSettingRow {
    key: string
    value: string
    updatedAt: Date
}

type TestTableName = 'fproxyKeys' | 'settings'
type TestTable = { __table: TestTableName }
type TestCondition = { value: unknown }
type RecordValue = Record<string, unknown>

/**
 * Minimal synchronous Drizzle stand-in for FProxyPoolService tests.
 */
export class FakeFProxyDatabase {
    readonly fproxyRows: FakeFProxyKeyRow[] = []
    readonly settingRows: FakeSettingRow[] = []
    private nextId = 1

    readonly db = {
        select: () => ({
            from: (table: unknown) => this.selectFrom(table),
        }),
        insert: (table: unknown) => ({
            values: (values: RecordValue) => this.insertInto(table, values),
        }),
        update: (table: unknown) => ({
            set: (values: RecordValue) => ({
                where: (condition: unknown) => ({
                    run: () => this.updateWhere(table, values, condition),
                }),
            }),
        }),
        delete: (table: unknown) => ({
            where: (condition: unknown) => ({
                run: () => this.deleteWhere(table, condition),
            }),
        }),
    }

    private selectFrom(table: unknown) {
        const rows = this.rowsFor(table)
        return {
            all: () => rows.slice(),
            where: (condition: unknown) => ({
                get: () => this.findWhere(rows, condition),
            }),
        }
    }

    private insertInto(table: unknown, values: RecordValue) {
        const name = readTableName(table)
        const upsert = (nextValues: RecordValue = values) => {
            if (name !== 'settings') {
                throw new Error('upsert_not_supported')
            }
            const key = String(nextValues.key ?? values.key)
            const existing = this.settingRows.find(row => row.key === key)
            if (existing) {
                existing.value = String(nextValues.value ?? values.value)
                existing.updatedAt = readDate(nextValues.updatedAt ?? values.updatedAt)
            } else {
                this.settingRows.push({
                    key,
                    value: String(nextValues.value ?? values.value),
                    updatedAt: readDate(nextValues.updatedAt ?? values.updatedAt),
                })
            }
            return { changes: 1 }
        }
        return {
            returning: () => ({
                get: () => {
                    if (name !== 'fproxyKeys') {
                        throw new Error('returning_not_supported')
                    }
                    const row: FakeFProxyKeyRow = {
                        id: this.nextId++,
                        label: String(values.label),
                        apiKeyCiphertext: String(values.apiKeyCiphertext),
                        enabled: values.enabled !== false,
                        createdAt: readDate(values.createdAt),
                        updatedAt: readDate(values.updatedAt),
                    }
                    this.fproxyRows.push(row)
                    return row
                },
            }),
            onConflictDoUpdate: (opts?: { set?: RecordValue }) => ({
                run: () => upsert({ ...values, ...(opts?.set ?? {}) }),
            }),
        }
    }

    private updateWhere(
        table: unknown,
        values: RecordValue,
        condition: unknown,
    ): { changes: number } {
        const rows = this.rowsFor(table)
        const row = this.findWhere(rows, condition)
        if (!row) return { changes: 0 }
        Object.assign(row, values)
        return { changes: 1 }
    }

    private deleteWhere(table: unknown, condition: unknown): { changes: number } {
        const name = readTableName(table)
        const rows = this.rowsFor(table)
        const row = this.findWhere(rows, condition)
        if (!row) return { changes: 0 }
        const index = rows.indexOf(row)
        rows.splice(index, 1)
        if (name === 'fproxyKeys') {
            this.fproxyRows.splice(0, this.fproxyRows.length, ...rows as FakeFProxyKeyRow[])
        } else {
            this.settingRows.splice(0, this.settingRows.length, ...rows as FakeSettingRow[])
        }
        return { changes: 1 }
    }

    private rowsFor(table: unknown): Array<Record<string, unknown>> {
        return readTableName(table) === 'fproxyKeys'
            ? this.fproxyRows as unknown as Array<Record<string, unknown>>
            : this.settingRows as unknown as Array<Record<string, unknown>>
    }

    private findWhere(
        rows: Array<Record<string, unknown>>,
        condition: unknown,
    ): Record<string, unknown> | undefined {
        const value = readConditionValue(condition)
        return rows.find(row => row.id === value || row.key === value)
    }
}

function readTableName(table: unknown): TestTableName {
    if (typeof table !== 'object' || table === null || !('__table' in table)) {
        throw new Error('unknown_test_table')
    }
    const name = (table as TestTable).__table
    if (name !== 'fproxyKeys' && name !== 'settings') {
        throw new Error('unknown_test_table')
    }
    return name
}

function readConditionValue(condition: unknown): unknown {
    if (typeof condition !== 'object' || condition === null || !('value' in condition)) {
        throw new Error('unknown_test_condition')
    }
    return (condition as TestCondition).value
}

function readDate(value: unknown): Date {
    return value instanceof Date ? value : new Date()
}
