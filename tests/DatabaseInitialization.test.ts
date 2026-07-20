/**
 * Regression: database init must be fail-closed and production-sealed.
 * - Legacy migration errors must not be swallowed before versioned migrations
 * - Singleton is published only after full init succeeds
 * - Failed init closes the handle and clears cache so a later call can retry cleanly
 * - Re-entrancy does not open a second handle
 * - PRAGMA integrity_check fails closed before migrations
 * - Existing DB gets a bounded pre-migration snapshot; new empty DB does not
 *
 * Uses pure mocks (no better-sqlite3 native binding) so tests run under system Node
 * even when the package was rebuilt for Electron's ABI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const harness = vi.hoisted(() => ({
  userDataDir: '',
  failLegacyLocationsPragma: false,
  failVersioned: false,
  failIntegrity: false,
  integrityMessage: 'ok' as string,
  versionedCallCount: 0,
  openHandleCount: 0,
  closedHandleCount: 0,
  pragmaCalls: [] as string[],
  onOpen: null as null | (() => void),
}))

vi.mock('electron', () => ({
  app: {
    getPath: (_name: string): string => harness.userDataDir,
  },
}))

vi.mock('better-sqlite3', () => {
  interface MockStatement {
    all: () => ReadonlyArray<Record<string, unknown>>
    run: (..._params: unknown[]) => { changes: number }
  }

  class MockSqliteDatabase {
    readonly path: string
    private closed = false

    constructor(path: string) {
      this.path = path
      harness.openHandleCount += 1
      harness.onOpen?.()
    }

    exec(_sql: string): void {
      this.assertOpen()
    }

    pragma(source: string): string | number | Array<Record<string, unknown>> {
      this.assertOpen()
      harness.pragmaCalls.push(source)
      if (/journal_mode/i.test(source)) return 'wal'
      if (/busy_timeout/i.test(source)) return 5000
      if (/wal_checkpoint/i.test(source)) return [{ busy: 0, log: 0, checkpointed: 0 }]
      if (/integrity_check/i.test(source)) {
        if (harness.failIntegrity) {
          return [{ integrity_check: 'corruption detected' }]
        }
        return [{ integrity_check: harness.integrityMessage }]
      }
      return []
    }

    prepare(sql: string): MockStatement {
      this.assertOpen()
      if (/PRAGMA\s+integrity_check/i.test(sql)) {
        if (harness.failIntegrity) {
          return {
            all: () => [{ integrity_check: 'corruption detected' }],
            run: () => ({ changes: 0 }),
          }
        }
        return {
          all: () => [{ integrity_check: harness.integrityMessage }],
          run: () => ({ changes: 0 }),
        }
      }
      if (
        harness.failLegacyLocationsPragma &&
        /PRAGMA\s+table_info\(\s*locations\s*\)/i.test(sql)
      ) {
        throw new Error('simulated legacy migration failure')
      }
      return {
        all: () => [],
        run: () => ({ changes: 0 }),
      }
    }

    close(): void {
      if (!this.closed) {
        this.closed = true
        harness.closedHandleCount += 1
      }
    }

    private assertOpen(): void {
      if (this.closed) {
        throw new Error('database connection is closed')
      }
    }
  }

  return { default: MockSqliteDatabase }
})

vi.mock('drizzle-orm/better-sqlite3', () => ({
  drizzle: (_client: unknown, _config?: unknown) => ({
    __mock: 'drizzle' as const,
  }),
}))

vi.mock('../src/main/database/migrations', async () => {
  const actual = await vi.importActual<typeof import('../src/main/database/migrations')>(
    '../src/main/database/migrations'
  )

  return {
    ...actual,
    runVersionedMigrations: (_db: unknown): void => {
      harness.versionedCallCount += 1
      if (harness.failVersioned) {
        throw new Error('simulated versioned migration failure')
      }
    },
  }
})

async function loadDatabaseModule() {
  return import('../src/main/database')
}

function resetHarnessCounters(): void {
  harness.failLegacyLocationsPragma = false
  harness.failVersioned = false
  harness.failIntegrity = false
  harness.integrityMessage = 'ok'
  harness.versionedCallCount = 0
  harness.openHandleCount = 0
  harness.closedHandleCount = 0
  harness.pragmaCalls = []
  harness.onOpen = null
}

function dbFilePath(): string {
  return join(harness.userDataDir, 'data', 'mmo-review.db')
}

function backupsDirPath(): string {
  return join(harness.userDataDir, 'data', 'backups')
}

function seedExistingDbFile(contents = 'existing-sqlite-bytes'): string {
  const dataDir = join(harness.userDataDir, 'data')
  mkdirSync(dataDir, { recursive: true })
  const path = dbFilePath()
  writeFileSync(path, contents)
  return path
}

function listPreMigrateSnapshots(): string[] {
  const dir = backupsDirPath()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.startsWith('mmo-review.pre-migrate.') && name.endsWith('.db'))
    .sort()
}

describe('DatabaseInitialization fail-closed', () => {
  beforeEach(() => {
    harness.userDataDir = mkdtempSync(join(tmpdir(), 'mmo-db-init-'))
    resetHarnessCounters()
    vi.resetModules()
  })

  afterEach(async () => {
    try {
      const mod = await loadDatabaseModule()
      mod.closeDatabase()
    } catch {
      // module may not have been loaded
    }
    resetHarnessCounters()
    rmSync(harness.userDataDir, { recursive: true, force: true })
  })

  it('publishes singleton only after successful init and reuses it', async () => {
    const { initDatabase, getDatabase, closeDatabase } = await loadDatabaseModule()

    const first = initDatabase()
    const second = getDatabase()

    expect(first).toBe(second)
    expect(harness.versionedCallCount).toBe(1)
    expect(harness.openHandleCount).toBe(1)
    expect(harness.pragmaCalls.some((p) => /journal_mode\s*=\s*WAL/i.test(p))).toBe(true)
    expect(harness.pragmaCalls.some((p) => /busy_timeout\s*=\s*5000/i.test(p))).toBe(true)

    closeDatabase()
    expect(harness.closedHandleCount).toBe(1)
  })

  it('does not call versioned migrations when legacy runMigrations fails', async () => {
    harness.failLegacyLocationsPragma = true
    const { initDatabase, getDatabase } = await loadDatabaseModule()

    expect(() => initDatabase()).toThrow(/simulated legacy migration failure/)
    expect(harness.versionedCallCount).toBe(0)
    // Failed init must close the opened handle
    expect(harness.closedHandleCount).toBe(1)

    // Singleton must not be half-published — retry still attempts full init
    harness.failLegacyLocationsPragma = false
    const db = getDatabase()
    expect(db).toBeTruthy()
    expect(harness.versionedCallCount).toBe(1)
    expect(harness.openHandleCount).toBe(2)
  })

  it('resets singleton/cache on versioned migration failure so retry is clean', async () => {
    harness.failVersioned = true
    const { initDatabase, getDatabase, closeDatabase } = await loadDatabaseModule()

    expect(() => initDatabase()).toThrow(/simulated versioned migration failure/)
    expect(harness.versionedCallCount).toBe(1)
    expect(harness.closedHandleCount).toBe(1)

    // Still no published singleton — next call re-runs versioned path
    harness.failVersioned = false
    const recovered = getDatabase()
    expect(recovered).toBeTruthy()
    expect(harness.versionedCallCount).toBe(2)
    expect(harness.openHandleCount).toBe(2)

    closeDatabase()
    expect(harness.closedHandleCount).toBe(2)

    // After explicit close, another init is allowed
    const again = initDatabase()
    expect(again).toBeTruthy()
    expect(harness.versionedCallCount).toBe(3)
    expect(harness.openHandleCount).toBe(3)
  })

  it('blocks re-entrant init without opening a second handle', async () => {
    const mod = await loadDatabaseModule()
    let reentrantError: unknown

    harness.onOpen = () => {
      try {
        mod.initDatabase()
      } catch (error) {
        reentrantError = error
      }
    }

    const db = mod.initDatabase()
    expect(db).toBeTruthy()
    expect(reentrantError).toBeInstanceOf(Error)
    expect(String(reentrantError)).toMatch(/already in progress|re-entrancy/i)
    expect(harness.openHandleCount).toBe(1)
    expect(harness.versionedCallCount).toBe(1)
  })

  it('fails closed on integrity_check before migrations', async () => {
    harness.failIntegrity = true
    const { initDatabase } = await loadDatabaseModule()

    expect(() => initDatabase()).toThrow(/integrity_check failed/i)
    expect(harness.versionedCallCount).toBe(0)
    expect(harness.closedHandleCount).toBe(1)
    expect(listPreMigrateSnapshots()).toHaveLength(0)
  })

  it('does not snapshot a brand-new empty database', async () => {
    const { initDatabase } = await loadDatabaseModule()

    initDatabase()

    expect(listPreMigrateSnapshots()).toHaveLength(0)
    expect(existsSync(backupsDirPath())).toBe(false)
  })

  it('snapshots existing DB before migrations with unique name and retain max 3', async () => {
    seedExistingDbFile('seed-v1')
    const backupsDir = backupsDirPath()
    mkdirSync(backupsDir, { recursive: true })

    // Seed three older snapshots; init should add one and prune to max 3.
    for (let i = 0; i < 3; i += 1) {
      const older = join(backupsDir, `mmo-review.pre-migrate.100${i}-1.db`)
      writeFileSync(older, `old-${i}`)
      // Ensure deterministic mtime ordering (oldest first).
      const past = new Date(Date.now() - (3 - i) * 60_000)
      const { utimesSync } = await import('node:fs')
      utimesSync(older, past, past)
    }

    const { initDatabase } = await loadDatabaseModule()
    initDatabase()

    const snaps = listPreMigrateSnapshots()
    expect(snaps).toHaveLength(3)
    expect(snaps.some((name) => name.includes(`${process.pid}`))).toBe(true)
    // Newest retain set should not keep the oldest seed (1000).
    expect(snaps.some((name) => name.includes('pre-migrate.1000-'))).toBe(false)
    expect(harness.versionedCallCount).toBe(1)
  })

  it('fails closed when pre-migration snapshot cannot be written', async () => {
    seedExistingDbFile('seed-disk-full')
    // Block backups directory creation: place a file where the dir should be.
    writeFileSync(backupsDirPath(), 'not-a-directory')

    const { initDatabase } = await loadDatabaseModule()

    expect(() => initDatabase()).toThrow(/Pre-migration snapshot failed/i)
    expect(harness.versionedCallCount).toBe(0)
    expect(harness.closedHandleCount).toBe(1)
  })
})
