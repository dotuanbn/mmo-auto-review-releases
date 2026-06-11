import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'
import { build } from 'esbuild'

/**
 * Custom Vite plugin: Builds the HF inference worker as a standalone JS bundle.
 * Uses esbuild directly instead of vite-plugin-electron to avoid
 * Electron restart conflicts and renderer crashes.
 */
function buildHfWorkerPlugin(): Plugin {
    const workerEntry = 'src/main/workers/hf-inference.worker.ts'
    const workerOutDir = 'dist-electron/main/workers'

    async function buildWorker() {
        await build({
            entryPoints: [workerEntry],
            outfile: path.join(workerOutDir, 'hf-inference.worker.js'),
            bundle: true,
            platform: 'node',
            target: 'node18',
            format: 'cjs',
            external: [
                'electron',
                'better-sqlite3',
                'playwright',
                // Native ONNX bindings — must resolve from node_modules at runtime
                'onnxruntime-node',
                'onnxruntime-common',
                'onnxruntime-web',
                '@huggingface/transformers',
            ],
            logLevel: 'info',
        })
    }

    return {
        name: 'build-hf-worker',
        // Build worker when Vite starts
        async buildStart() {
            await buildWorker()
        },
        // Rebuild worker when its source file changes (dev mode)
        async watchChange(id) {
            if (id.includes('workers') && id.includes('hf-inference')) {
                await buildWorker()
            }
        },
    }
}

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        react(),
        electron({
            main: {
                entry: 'src/main/index.ts',
                vite: {
                    build: {
                        outDir: 'dist-electron/main',
                        rollupOptions: {
                            external: ['electron', 'better-sqlite3', 'playwright'],
                        },
                    },
                },
            },
            preload: {
                input: path.join(__dirname, 'src/preload/index.ts'),
                vite: {
                    build: {
                        outDir: 'dist-electron/preload',
                    },
                },
            },
            renderer: {},
        }),
        // Build HF worker separately — no Electron restart, no renderer crash
        buildHfWorkerPlugin(),
    ],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src/renderer/src'),
            '@main': path.resolve(__dirname, './src/main'),
            '@shared': path.resolve(__dirname, './src/shared'),
        },
    },
    server: {
        port: 5173,
    },
    build: {
        outDir: 'dist',
    },
})
