import { describe, expect, it, beforeEach } from 'vitest'
import {
    fingerprintService,
    FingerprintService,
    type BrowserFingerprint,
} from '../src/main/services/FingerprintService'

describe('FingerprintService retention & caching', () => {
    beforeEach(() => {
        fingerprintService.clearCache()
    })

    it('defaults to caching for generate() when options are omitted', () => {
        const fp = fingerprintService.generate()
        expect(fp.id).toBeDefined()
        expect(fingerprintService.getById(fp.id)).toBe(fp)
        expect(fingerprintService.getCacheSize()).toBe(1)
    })

    it('defaults to caching for generateForUserAgent() when options are omitted', () => {
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'
        const fp = fingerprintService.generateForUserAgent(ua)
        expect(fp.userAgent).toBe(ua)
        expect(fingerprintService.getById(fp.id)).toBe(fp)
        expect(fingerprintService.getCacheSize()).toBe(1)
    })

    it('retains fingerprints when options have { cache: true } or empty {}', () => {
        const fp1 = fingerprintService.generate({ cache: true })
        const fp2 = fingerprintService.generate({})
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
        const fp3 = fingerprintService.generateForUserAgent(ua, { cache: true })
        const fp4 = fingerprintService.generateForUserAgent(ua, {})

        expect(fingerprintService.getById(fp1.id)).toBe(fp1)
        expect(fingerprintService.getById(fp2.id)).toBe(fp2)
        expect(fingerprintService.getById(fp3.id)).toBe(fp3)
        expect(fingerprintService.getById(fp4.id)).toBe(fp4)
        expect(fingerprintService.getCacheSize()).toBe(4)
    })

    it('does not retain transient fingerprints when { cache: false } is passed', () => {
        const fp1 = fingerprintService.generate({ cache: false })
        expect(fp1.id).toBeDefined()
        expect(fp1.userAgent).toBeDefined()
        expect(fp1.clientHints).toBeDefined()
        expect(fp1.webgl).toBeDefined()
        expect(fp1.screenResolution).toBeDefined()

        // Must NOT be retained in singleton cache
        expect(fingerprintService.getById(fp1.id)).toBeUndefined()
        expect(fingerprintService.getCacheSize()).toBe(0)

        const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
        const fp2 = fingerprintService.generateForUserAgent(ua, { cache: false })
        expect(fp2.id).toBeDefined()
        expect(fp2.userAgent).toBe(ua)
        expect(fp2.platform).toBe('MacIntel')
        expect(fp2.clientHints?.secChUaPlatform).toBe('"macOS"')

        // Must NOT be retained in singleton cache
        expect(fingerprintService.getById(fp2.id)).toBeUndefined()
        expect(fingerprintService.getCacheSize()).toBe(0)
    })

    it('preserves store() and getById() for account persistence', () => {
        const customFp: BrowserFingerprint = {
            id: 'account-persistent-fp-1',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0.0.0 Safari/537.36',
            screenResolution: { width: 1920, height: 1080 },
            colorDepth: 24,
            devicePixelRatio: 1,
            webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA)' },
            timezone: { name: 'Asia/Ho_Chi_Minh', offset: 420 },
            languages: ['vi-VN', 'vi', 'en-US'],
            platform: 'Win32',
            hardwareConcurrency: 8,
            deviceMemory: 16,
            canvasNoise: 0.42,
            audioNoise: 0.42,
            createdAt: new Date('2026-11-20T10:00:00Z'),
        }

        fingerprintService.store(customFp)
        expect(fingerprintService.getById('account-persistent-fp-1')).toBe(customFp)
        expect(fingerprintService.getCacheSize()).toBe(1)
    })

    it('preserves serialization and deserialization roundtrip with store()', () => {
        const fp = fingerprintService.generate({ cache: false })
        const serialized = fingerprintService.serialize(fp)
        const deserialized = fingerprintService.deserialize(serialized)

        expect(deserialized).not.toBeNull()
        expect(deserialized?.id).toBe(fp.id)
        expect(deserialized?.userAgent).toBe(fp.userAgent)
        expect(deserialized?.createdAt).toBeInstanceOf(Date)

        // Store deserialized account fingerprint
        fingerprintService.store(deserialized!)
        expect(fingerprintService.getById(fp.id)).toEqual(deserialized)
    })

    it('retains account fingerprints while thousands of transient generations do not accumulate', () => {
        // 1. Store 10 persistent account fingerprints in the cache
        const accountIds: string[] = []
        for (let i = 0; i < 10; i++) {
            const accountFp = fingerprintService.generate() // default cache: true
            accountIds.push(accountFp.id)
        }
        expect(fingerprintService.getCacheSize()).toBe(10)

        // 2. Generate 5,000 transient fingerprints with { cache: false }
        const transientIds: string[] = []
        const TRANSIENT_COUNT = 5_000

        for (let i = 0; i < TRANSIENT_COUNT; i++) {
            const isUaPath = i % 2 === 0
            const fp = isUaPath
                ? fingerprintService.generateForUserAgent(
                      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36',
                      { cache: false }
                  )
                : fingerprintService.generate({ cache: false })

            transientIds.push(fp.id)
        }

        // 3. Verify cache size is still exactly 10 (no transient leakage)
        expect(fingerprintService.getCacheSize()).toBe(10)

        // 4. Verify all 10 account fingerprints remain retrievable
        for (const accountId of accountIds) {
            const found = fingerprintService.getById(accountId)
            expect(found).toBeDefined()
            expect(found?.id).toBe(accountId)
        }

        // 5. Verify sample of transient fingerprints are NOT retrievable
        for (let i = 0; i < 100; i++) {
            const sampleId = transientIds[i * 50]
            expect(fingerprintService.getById(sampleId)).toBeUndefined()
        }
    })

    it('isolated instance behaves identically', () => {
        const localSvc = new FingerprintService()
        expect(localSvc.getCacheSize()).toBe(0)

        const transient = localSvc.generate({ cache: false })
        expect(localSvc.getById(transient.id)).toBeUndefined()
        expect(localSvc.getCacheSize()).toBe(0)

        const cached = localSvc.generate({ cache: true })
        expect(localSvc.getById(cached.id)).toBe(cached)
        expect(localSvc.getCacheSize()).toBe(1)
    })
})
