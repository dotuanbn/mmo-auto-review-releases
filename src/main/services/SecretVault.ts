import { safeStorage } from 'electron'

/**
 * Versioned secret storage for Electron main process.
 * Format: enc:v1:<base64(safeStorage.encryptString(plaintext))>
 * Legacy rows have no prefix (plaintext) and are migrated lazily on read.
 */
const PREFIX_V1 = 'enc:v1:'

export type SecretVaultStatus = {
    encryptionAvailable: boolean
    scheme: 'enc:v1'
}

export class SecretStorageUnavailableError extends Error {
    constructor(message = 'Secure OS credential storage is unavailable') {
        super(message)
        this.name = 'SecretStorageUnavailableError'
    }
}

export class SecretVault {
    getStatus(): SecretVaultStatus {
        return {
            encryptionAvailable: this.isAvailable(),
            scheme: 'enc:v1',
        }
    }

    isAvailable(): boolean {
        try {
            return safeStorage.isEncryptionAvailable()
        } catch {
            return false
        }
    }

    isEncrypted(value: string | null | undefined): boolean {
        return typeof value === 'string' && value.startsWith(PREFIX_V1)
    }

    /**
     * Encrypt plaintext for at-rest storage.
     * New writes fail closed when OS-backed encryption is unavailable.
     * Never double-encrypts an already-versioned value.
     */
    encrypt(plaintext: string): string {
        if (!plaintext) return plaintext
        if (this.isEncrypted(plaintext)) return plaintext
        if (!this.isAvailable()) {
            throw new SecretStorageUnavailableError()
        }

        try {
            const encrypted = safeStorage.encryptString(plaintext)
            return PREFIX_V1 + encrypted.toString('base64')
        } catch (error) {
            throw new SecretStorageUnavailableError(
                error instanceof Error ? error.message : 'Failed to encrypt secret'
            )
        }
    }

    /**
     * Decrypt a stored value. Legacy (no prefix) is returned as-is.
     * On decrypt failure (e.g. different machine/keychain), returns empty string.
     */
    decrypt(stored: string | null | undefined): string {
        if (stored == null || stored === '') return ''
        if (!this.isEncrypted(stored)) return stored

        if (!this.isAvailable()) {
            console.warn('[SecretVault] Encrypted secret present but safeStorage unavailable')
            return ''
        }

        try {
            const b64 = stored.slice(PREFIX_V1.length)
            const buf = Buffer.from(b64, 'base64')
            return safeStorage.decryptString(buf)
        } catch {
            console.warn('[SecretVault] Failed to decrypt secret (keychain mismatch or corrupt value)')
            return ''
        }
    }

    /** True when value is non-empty plaintext and encryption is available. */
    needsMigration(stored: string | null | undefined): boolean {
        if (stored == null || stored === '') return false
        if (this.isEncrypted(stored)) return false
        return this.isAvailable()
    }

    /**
     * Seal plaintext for write paths. Empty stays empty.
     */
    seal(plaintext: string | null | undefined): string {
        if (plaintext == null || plaintext === '') return ''
        return this.encrypt(plaintext)
    }

    /**
     * Lazy migration helper: decrypt → re-encrypt if still plaintext and encryption available.
     */
    migrateIfNeeded(stored: string | null | undefined): { value: string; migrated: boolean } {
        if (stored == null || stored === '') {
            return { value: '', migrated: false }
        }
        if (this.isEncrypted(stored)) {
            return { value: stored, migrated: false }
        }
        if (!this.isAvailable()) {
            return { value: stored, migrated: false }
        }
        const plain = this.decrypt(stored)
        if (!plain) {
            return { value: stored, migrated: false }
        }
        try {
            const sealed = this.encrypt(plain)
            return { value: sealed, migrated: sealed !== stored && this.isEncrypted(sealed) }
        } catch {
            return { value: stored, migrated: false }
        }
    }
}

export const secretVault = new SecretVault()
