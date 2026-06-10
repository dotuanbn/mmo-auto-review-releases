import * as crypto from 'crypto'

/**
 * FingerprintService - Generate unique browser fingerprints for anti-detection
 * Each account gets a consistent fingerprint to avoid detection patterns
 */

// Common screen resolutions
const SCREEN_RESOLUTIONS = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 2560, height: 1440 },
    { width: 1600, height: 900 },
]

// Common desktop user agents (Chrome on Windows/Mac)
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
]

// WebGL renderers (common GPU combinations)
const WEBGL_CONFIGS = [
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel Iris Plus Graphics 640 Direct3D11 vs_5_0 ps_5_0)' },
]

// Timezone offsets (minutes from UTC)
const TIMEZONES = [
    { name: 'Asia/Ho_Chi_Minh', offset: 420 }, // UTC+7
    { name: 'Asia/Bangkok', offset: 420 },
    { name: 'Asia/Singapore', offset: 480 }, // UTC+8
    { name: 'Asia/Tokyo', offset: 540 }, // UTC+9
    { name: 'America/Los_Angeles', offset: -480 }, // UTC-8
    { name: 'America/New_York', offset: -300 }, // UTC-5
    { name: 'Europe/London', offset: 0 },
]

// Languages
const LANGUAGES = [
    ['vi-VN', 'vi', 'en-US', 'en'],
    ['en-US', 'en'],
    ['en-GB', 'en'],
]

export interface BrowserFingerprint {
    id: string
    userAgent: string
    screenResolution: { width: number; height: number }
    colorDepth: number
    devicePixelRatio: number
    webgl: { vendor: string; renderer: string }
    timezone: { name: string; offset: number }
    languages: string[]
    platform: string
    hardwareConcurrency: number
    deviceMemory: number
    canvasNoise: number // Seed for canvas noise
    audioNoise: number // Seed for audio noise
    createdAt: Date
}

export class FingerprintService {
    private fingerprints: Map<string, BrowserFingerprint> = new Map()

    // Generate a unique ID
    private generateId(): string {
        return crypto.randomBytes(16).toString('hex')
    }

    // Get random item from array
    private getRandomItem<T>(array: T[]): T {
        return array[Math.floor(Math.random() * array.length)]
    }

    // Get random number in range
    private getRandomInRange(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1)) + min
    }

    // Generate a new fingerprint
    generate(): BrowserFingerprint {
        const userAgent = this.getRandomItem(USER_AGENTS)
        const isWindows = userAgent.includes('Windows')

        const fingerprint: BrowserFingerprint = {
            id: this.generateId(),
            userAgent,
            screenResolution: this.getRandomItem(SCREEN_RESOLUTIONS),
            colorDepth: this.getRandomItem([24, 32]),
            devicePixelRatio: this.getRandomItem([1, 1.25, 1.5, 2]),
            webgl: this.getRandomItem(WEBGL_CONFIGS),
            timezone: this.getRandomItem(TIMEZONES),
            languages: this.getRandomItem(LANGUAGES),
            platform: isWindows ? 'Win32' : 'MacIntel',
            hardwareConcurrency: this.getRandomItem([4, 6, 8, 12, 16]),
            deviceMemory: this.getRandomItem([4, 8, 16, 32]),
            canvasNoise: Math.random(),
            audioNoise: Math.random(),
            createdAt: new Date(),
        }

        this.fingerprints.set(fingerprint.id, fingerprint)
        return fingerprint
    }

    // Get fingerprint by ID
    getById(id: string): BrowserFingerprint | undefined {
        return this.fingerprints.get(id)
    }

    // Store fingerprint (for persistence)
    store(fingerprint: BrowserFingerprint): void {
        this.fingerprints.set(fingerprint.id, fingerprint)
    }

    // Generate Playwright browser launch args for fingerprint
    getBrowserArgs(fingerprint: BrowserFingerprint): string[] {
        return [
            `--user-agent=${fingerprint.userAgent}`,
            `--window-size=${fingerprint.screenResolution.width},${fingerprint.screenResolution.height}`,
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-site-isolation-trials',
        ]
    }

    // Get anti-detection script to inject into page
    getAntiDetectionScript(fingerprint: BrowserFingerprint): string {
        return `
            // Override navigator properties
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(fingerprint.languages)} });
            Object.defineProperty(navigator, 'platform', { get: () => '${fingerprint.platform}' });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${fingerprint.hardwareConcurrency} });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => ${fingerprint.deviceMemory} });
            
            // Override screen properties
            Object.defineProperty(screen, 'width', { get: () => ${fingerprint.screenResolution.width} });
            Object.defineProperty(screen, 'height', { get: () => ${fingerprint.screenResolution.height} });
            Object.defineProperty(screen, 'availWidth', { get: () => ${fingerprint.screenResolution.width} });
            Object.defineProperty(screen, 'availHeight', { get: () => ${fingerprint.screenResolution.height - 40} });
            Object.defineProperty(screen, 'colorDepth', { get: () => ${fingerprint.colorDepth} });
            Object.defineProperty(window, 'devicePixelRatio', { get: () => ${fingerprint.devicePixelRatio} });

            // Override WebGL
            const getParameterOrig = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function(parameter) {
                if (parameter === 37445) return '${fingerprint.webgl.vendor}';
                if (parameter === 37446) return '${fingerprint.webgl.renderer}';
                return getParameterOrig.call(this, parameter);
            };

            // Override timezone
            const originalDateTimeFormat = Intl.DateTimeFormat;
            Intl.DateTimeFormat = function(locales, options) {
                if (options && options.timeZone === undefined) {
                    options = { ...options, timeZone: '${fingerprint.timezone.name}' };
                }
                return new originalDateTimeFormat(locales, options);
            };
            Intl.DateTimeFormat.prototype = originalDateTimeFormat.prototype;

            // Add canvas noise
            const canvasNoise = ${fingerprint.canvasNoise};
            const toDataURLOrig = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function(type) {
                const ctx = this.getContext('2d');
                if (ctx) {
                    const imageData = ctx.getImageData(0, 0, this.width, this.height);
                    for (let i = 0; i < imageData.data.length; i += 4) {
                        if (Math.random() < 0.01) {
                            imageData.data[i] = imageData.data[i] + Math.floor((canvasNoise - 0.5) * 2);
                        }
                    }
                    ctx.putImageData(imageData, 0, 0);
                }
                return toDataURLOrig.apply(this, arguments);
            };

            // Hide automation indicators
            delete navigator.__proto__.webdriver;
            delete window.callPhantom;
            delete window._phantom;
            delete window.phantom;
            delete window.domAutomation;
            delete window.domAutomationController;
        `
    }

    // Serialize fingerprint for storage
    serialize(fingerprint: BrowserFingerprint): string {
        return JSON.stringify(fingerprint)
    }

    // Deserialize fingerprint from storage
    deserialize(data: string): BrowserFingerprint | null {
        try {
            const parsed = JSON.parse(data)
            parsed.createdAt = new Date(parsed.createdAt)
            return parsed
        } catch {
            return null
        }
    }
}

export const fingerprintService = new FingerprintService()
