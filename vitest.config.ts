import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Unit-test baseline for pure main-process modules.
 * Tests live under tests/ only (not next to src) to keep ownership boundaries clean.
 * No browser/network environment — node only, deterministic.
 */
export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.{test,spec}.ts'],
        exclude: ['node_modules', 'dist', 'dist-electron', 'release', 'release-*', 'output'],
        // Deterministic: no file parallelism surprises on Windows CI
        fileParallelism: true,
        reporters: ['default'],
        passWithNoTests: false,
    },
    resolve: {
        alias: {
            '@main': path.resolve(__dirname, './src/main'),
            '@shared': path.resolve(__dirname, './src/shared'),
            '@': path.resolve(__dirname, './src/renderer/src'),
        },
    },
})
