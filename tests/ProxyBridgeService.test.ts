import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type AnonymizeFn = (upstream: string) => Promise<string>
type CloseFn = (url: string, closeConnections?: boolean) => Promise<boolean>

const closedUrls = new Set<string>()
const liveUrls = new Set<string>()
let createSeq = 0
let createDelayMs = 40
let createCalls = 0
let closeCalls = 0

const anonymizeProxyMock: AnonymizeFn = async (_upstream: string) => {
    createCalls += 1
    const delay = createDelayMs
    if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
    }
    createSeq += 1
    const url = `http://127.0.0.1:${19000 + createSeq}`
    liveUrls.add(url)
    closedUrls.delete(url)
    return url
}

const closeAnonymizedProxyMock: CloseFn = async (url: string) => {
    closeCalls += 1
    liveUrls.delete(url)
    closedUrls.add(url)
    return true
}

vi.mock('proxy-chain', () => ({
    anonymizeProxy: (upstream: string) => anonymizeProxyMock(upstream),
    closeAnonymizedProxy: (url: string, closeConnections?: boolean) =>
        closeAnonymizedProxyMock(url, closeConnections),
}))

// Import after mock so ProxyBridgeService binds to mocked proxy-chain.
import { ProxyBridgeService } from '../src/main/services/ProxyBridgeService'
import type { ProxyBridgeInput } from '../src/main/services/ProxyBridgeService'

const authInput: ProxyBridgeInput = {
    host: 'proxy.example.com',
    port: 8000,
    username: 'user',
    password: 'secret',
    type: 'http',
}

function resetMockState(): void {
    closedUrls.clear()
    liveUrls.clear()
    createSeq = 0
    createDelayMs = 40
    createCalls = 0
    closeCalls = 0
}

describe('ProxyBridgeService concurrency', () => {
    let svc: ProxyBridgeService

    beforeEach(() => {
        resetMockState()
        svc = new ProxyBridgeService()
    })

    afterEach(async () => {
        await svc.closeAll()
    })

    it('predictBridgeMode: anonymized for http+auth, direct for socks5/no-auth', () => {
        expect(svc.predictBridgeMode(authInput)).toBe('anonymized')
        expect(
            svc.predictBridgeMode({ host: 'h', port: 1, type: 'socks5', username: 'u', password: 'p' })
        ).toBe('direct')
        expect(svc.predictBridgeMode({ host: 'h', port: 1, type: 'http' })).toBe('direct')
    })

    it('direct mode returns upstream server without proxy-chain', async () => {
        const resolved = await svc.acquire({
            host: '1.2.3.4',
            port: 1080,
            type: 'socks5',
            username: 'u',
            password: 'p',
        })
        expect(resolved.bridgeMode).toBe('direct')
        expect(resolved.server).toBe('socks5://1.2.3.4:1080')
        expect(resolved.bridgeKey).toBeUndefined()
        expect(createCalls).toBe(0)
    })

    it('concurrent acquire same key: single anonymize, shared URL, refs keep bridge open', async () => {
        createDelayMs = 60
        const results = await Promise.all([
            svc.acquire(authInput),
            svc.acquire(authInput),
            svc.acquire(authInput),
        ])

        expect(createCalls).toBe(1)
        expect(new Set(results.map((r) => r.server)).size).toBe(1)
        expect(results.every((r) => r.bridgeMode === 'anonymized')).toBe(true)
        expect(results.every((r) => r.bridgeKey === results[0].bridgeKey)).toBe(true)
        expect(closedUrls.has(results[0].server)).toBe(false)
        expect(liveUrls.has(results[0].server)).toBe(true)

        await svc.release(results[0].bridgeKey)
        await svc.release(results[1].bridgeKey)
        expect(closedUrls.has(results[0].server)).toBe(false)

        await svc.release(results[2].bridgeKey)
        expect(closedUrls.has(results[0].server)).toBe(true)
        expect(closeCalls).toBe(1)
    })

    it('pending share + early release: peer never receives a closed bridge URL', async () => {
        createDelayMs = 80
        const aPromise = svc.acquire(authInput)
        // Yield so A installs createPromise before B joins.
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        const bPromise = svc.acquire(authInput)

        const a = await aPromise
        // First holder releases while B may still be finishing acquire.
        await svc.release(a.bridgeKey)

        const b = await bPromise
        expect(b.server).toBe(a.server)
        expect(b.bridgeMode).toBe('anonymized')
        expect(closedUrls.has(b.server)).toBe(false)
        expect(liveUrls.has(b.server)).toBe(true)
        expect(createCalls).toBe(1)

        await svc.release(b.bridgeKey)
        expect(closedUrls.has(b.server)).toBe(true)
        expect(closeCalls).toBe(1)
    })

    it('simultaneous acquire then immediate first release still leaves peer open', async () => {
        createDelayMs = 50
        const aPromise = svc.acquire(authInput)
        const bPromise = svc.acquire(authInput)

        const a = await aPromise
        const releaseA = svc.release(a.bridgeKey)
        const b = await bPromise
        await releaseA

        expect(closedUrls.has(b.server)).toBe(false)
        expect(b.server).toBe(a.server)

        await svc.release(b.bridgeKey)
        expect(closedUrls.has(b.server)).toBe(true)
    })

    it('release is idempotent: extra release does not double-close', async () => {
        createDelayMs = 0
        const a = await svc.acquire(authInput)
        const key = a.bridgeKey
        expect(key).toBeTruthy()

        await svc.release(key)
        expect(closeCalls).toBe(1)
        expect(closedUrls.has(a.server)).toBe(true)

        await svc.release(key)
        await svc.release(key)
        await svc.release(undefined)
        await svc.release('missing-key')
        expect(closeCalls).toBe(1)
    })

    it('re-acquire after full release creates a fresh bridge', async () => {
        createDelayMs = 0
        const first = await svc.acquire(authInput)
        await svc.release(first.bridgeKey)
        expect(closedUrls.has(first.server)).toBe(true)

        const second = await svc.acquire(authInput)
        expect(createCalls).toBe(2)
        expect(second.server).not.toBe(first.server)
        expect(closedUrls.has(second.server)).toBe(false)

        await svc.release(second.bridgeKey)
    })

    it('closeAll closes live bridges once and does not leak', async () => {
        createDelayMs = 0
        const [a, b] = await Promise.all([svc.acquire(authInput), svc.acquire(authInput)])
        expect(a.server).toBe(b.server)

        await svc.closeAll()
        expect(closedUrls.has(a.server)).toBe(true)
        expect(liveUrls.size).toBe(0)
        expect(closeCalls).toBe(1)

        // Idempotent second closeAll
        await svc.closeAll()
        expect(closeCalls).toBe(1)

        // release after closeAll is a no-op
        await svc.release(a.bridgeKey)
        expect(closeCalls).toBe(1)
    })

    it('many concurrent acquires share one create; last release closes once', async () => {
        createDelayMs = 30
        const N = 24
        const results = await Promise.all(
            Array.from({ length: N }, () => svc.acquire(authInput))
        )

        expect(createCalls).toBe(1)
        const server = results[0].server
        expect(results.every((r) => r.server === server)).toBe(true)
        expect(closedUrls.has(server)).toBe(false)

        await Promise.all(results.slice(0, N - 1).map((r) => svc.release(r.bridgeKey)))
        expect(closedUrls.has(server)).toBe(false)

        await svc.release(results[N - 1].bridgeKey)
        expect(closedUrls.has(server)).toBe(true)
        expect(closeCalls).toBe(1)
    })
})
