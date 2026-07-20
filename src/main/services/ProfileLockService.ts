/**
 * ProfileLockService — in-process exclusive ownership for persistent Chrome profiles.
 *
 * Prevents two concurrent owners from calling launchPersistentContext on the same
 * normalized profilePath (manual login + auto login + ScriptRunner + BrowserService).
 *
 * Scope notes:
 * - Does NOT manage Chrome filesystem SingletonLock/LOCK files (BrowserService still does).
 * - Ephemeral (in-memory) contexts must NOT use this lock.
 * - Second owner is rejected immediately with a friendly error (no wait queue).
 */

import { resolve } from 'path'

export type ProfileLockOwnerKind =
    | 'browser_service'
    | 'script_runner'
    | 'account_manual'
    | 'account_auto'
    | 'other'

export interface ProfileLockOwner {
    /** Stable token used for release matching (e.g. browser:12, script:abc). */
    ownerToken: string
    kind: ProfileLockOwnerKind
    /** Playwright context id when owned via BrowserService. */
    contextId?: number
    accountId?: number
    /** Short human label for error messages (email, script name, etc.). */
    label?: string
    acquiredAt: number
}

export type ProfileLockAcquireRequest = Omit<ProfileLockOwner, 'acquiredAt'>

export class ProfileLockBusyError extends Error {
    readonly code = 'PROFILE_LOCK_BUSY' as const
    readonly profilePath: string
    readonly currentOwner: ProfileLockOwner

    constructor(profilePath: string, currentOwner: ProfileLockOwner) {
        const who =
            currentOwner.label ||
            (typeof currentOwner.contextId === 'number'
                ? `context #${currentOwner.contextId}`
                : currentOwner.ownerToken) ||
            currentOwner.kind
        super(
            `Profile đang được dùng bởi phiên khác (${who}). Đóng phiên đó rồi thử lại.`
        )
        this.name = 'ProfileLockBusyError'
        this.profilePath = profilePath
        this.currentOwner = currentOwner
    }
}

export function isProfileLockBusyError(err: unknown): err is ProfileLockBusyError {
    if (err instanceof ProfileLockBusyError) return true
    if (typeof err !== 'object' || err === null) return false
    const maybe = err as { code?: unknown; name?: unknown }
    return maybe.code === 'PROFILE_LOCK_BUSY' || maybe.name === 'ProfileLockBusyError'
}

export class ProfileLockService {
    private readonly locks = new Map<string, ProfileLockOwner>()
    /** Serializes concurrent acquire attempts per path so only one decision wins. */
    private readonly acquireChains = new Map<string, Promise<void>>()

    /**
     * Canonical profile path key (SSOT for BrowserService + all lock owners).
     * Absolute path; case-folded on Windows so lock identity matches across callers.
     */
    normalizePath(profilePath: string): string {
        const resolved = resolve(profilePath)
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved
    }

    getOwner(profilePath: string): ProfileLockOwner | undefined {
        return this.locks.get(this.normalizePath(profilePath))
    }

    isHeld(profilePath: string): boolean {
        return this.locks.has(this.normalizePath(profilePath))
    }

    /**
     * Acquire exclusive ownership for a profile path.
     * Rejects with ProfileLockBusyError if another ownerToken holds the path.
     * Same ownerToken may refresh metadata (idempotent re-acquire).
     */
    async acquire(
        profilePath: string,
        owner: ProfileLockAcquireRequest
    ): Promise<ProfileLockOwner> {
        const key = this.normalizePath(profilePath)
        if (!owner.ownerToken || typeof owner.ownerToken !== 'string') {
            throw new Error('ProfileLockService.acquire: ownerToken is required')
        }

        const previous = this.acquireChains.get(key) ?? Promise.resolve()
        let releaseChain: () => void = () => { }
        const gate = new Promise<void>((resolveGate) => {
            releaseChain = resolveGate
        })
        this.acquireChains.set(
            key,
            previous.then(() => gate).catch(() => gate)
        )

        await previous
        try {
            const existing = this.locks.get(key)
            if (existing && existing.ownerToken !== owner.ownerToken) {
                throw new ProfileLockBusyError(key, existing)
            }

            const full: ProfileLockOwner = {
                ownerToken: owner.ownerToken,
                kind: owner.kind,
                contextId: owner.contextId,
                accountId: owner.accountId,
                label: owner.label,
                acquiredAt: Date.now(),
            }
            this.locks.set(key, full)
            return full
        } finally {
            releaseChain()
            if (this.acquireChains.get(key) !== undefined) {
                // Keep chain map lean when idle (best-effort; races are harmless).
                const tail = this.acquireChains.get(key)
                void tail?.then(() => {
                    if (this.acquireChains.get(key) === tail) {
                        this.acquireChains.delete(key)
                    }
                }).catch(() => {
                    if (this.acquireChains.get(key) === tail) {
                        this.acquireChains.delete(key)
                    }
                })
            }
        }
    }

    /**
     * Release lock when ownerToken matches (or force when ownerToken omitted).
     * Idempotent: returns false when already released or token mismatch.
     * Returns true if a lock entry was removed.
     */
    release(profilePath: string, ownerToken?: string): boolean {
        const key = this.normalizePath(profilePath)
        const existing = this.locks.get(key)
        if (!existing) return false
        if (ownerToken !== undefined && existing.ownerToken !== ownerToken) {
            return false
        }
        this.locks.delete(key)
        return true
    }

    /**
     * Release any lock owned by the given context id.
     * Idempotent: second call returns null.
     */
    releaseByContextId(contextId: number): string | null {
        const entries = Array.from(this.locks.entries())
        for (let i = 0; i < entries.length; i++) {
            const [key, owner] = entries[i]
            if (owner.contextId === contextId) {
                this.locks.delete(key)
                return key
            }
        }
        return null
    }

    /** Release all locks for a given ownerToken. Returns count removed. */
    releaseByOwnerToken(ownerToken: string): number {
        let removed = 0
        const entries = Array.from(this.locks.entries())
        for (let i = 0; i < entries.length; i++) {
            const [key, owner] = entries[i]
            if (owner.ownerToken === ownerToken) {
                this.locks.delete(key)
                removed += 1
            }
        }
        return removed
    }

    /**
     * Drop stale in-process locks:
     * - Entries with contextId where isContextAlive returns false
     * - Entries WITHOUT contextId older than maxAgeMs (script_runner safety net)
     * Never age-outs context-tracked locks without isContextAlive (BrowserService owns those).
     */
    cleanupStale(options: {
        isContextAlive?: (contextId: number) => boolean
        maxAgeMs?: number
        now?: number
    } = {}): number {
        const now = options.now ?? Date.now()
        let removed = 0
        const entries = Array.from(this.locks.entries())

        for (let i = 0; i < entries.length; i++) {
            const [key, owner] = entries[i]
            let stale = false

            if (typeof owner.contextId === 'number') {
                if (options.isContextAlive && !options.isContextAlive(owner.contextId)) {
                    stale = true
                }
            } else if (
                options.maxAgeMs !== undefined &&
                now - owner.acquiredAt > options.maxAgeMs
            ) {
                stale = true
            }

            if (stale) {
                this.locks.delete(key)
                removed += 1
            }
        }

        return removed
    }

    /** Release every held lock (browser shutdown / hard reset). */
    releaseAll(): number {
        const n = this.locks.size
        this.locks.clear()
        return n
    }

    listHeld(): Array<{ profilePath: string; owner: ProfileLockOwner }> {
        return Array.from(this.locks.entries()).map(([profilePath, owner]) => ({
            profilePath,
            owner,
        }))
    }
}

export const profileLockService = new ProfileLockService()
