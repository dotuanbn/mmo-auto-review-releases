/**
 * AppShutdownService.test.ts
 *
 * Verifies AppShutdownService contract:
 * - Single-flight / concurrent & repeated calls run side effects exactly once
 * - Synchronously reentrant shutdown from first step does not duplicate cleanup
 * - Sequential execution in registration order (DB-last)
 * - Failure isolation: failing steps do not stop subsequent steps; clean=false with failed step names
 * - Step timeout marks step failed and unclean without throwing unhandled rejection
 * - Lifecycle router event routing: before-quit preventDefault, window-all-closed routing (expect 2 quits), quit exactly once on direct before-quit
 * - Protected logging and callback failure isolation (never strands final quit)
 */

import { describe, it, expect, vi } from 'vitest'
import {
    AppShutdownService,
    registerLifecycleRouter,
    type EventWithPreventDefault,
    type LifecyclePort,
    type ShutdownResult,
} from '../src/main/services/AppShutdownService'

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000, intervalMs = 10): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (await predicate()) return
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`)
}

describe('AppShutdownService', () => {
    it('executes steps in exact registered order and database last', async () => {
        const executionOrder: string[] = []
        const service = new AppShutdownService()

        const stepNames = [
            'renderer_recovery',
            'background_workers',
            'automation_engines',
            'browser_service',
            'hf_models',
            'proxy_bridges',
            'database',
        ]

        for (const name of stepNames) {
            service.registerStep({
                name,
                run: async () => {
                    await new Promise((r) => setTimeout(r, 5))
                    executionOrder.push(name)
                },
            })
        }

        const result = await service.shutdown()

        expect(result.clean).toBe(true)
        expect(result.failedSteps).toEqual([])
        expect(executionOrder).toEqual(stepNames)
        expect(executionOrder[executionOrder.length - 1]).toBe('database')
    })

    it('handles concurrent shutdown calls with a single flight (runs steps exactly once)', async () => {
        const stepMock = vi.fn().mockImplementation(async () => {
            await new Promise((r) => setTimeout(r, 20))
        })

        const service = new AppShutdownService()
        service.registerStep({ name: 'single_flight_step', run: stepMock })

        expect(service.isShuttingDown()).toBe(false)
        expect(service.isComplete()).toBe(false)

        const [r1, r2, r3] = await Promise.all([
            service.shutdown(),
            service.shutdown(),
            service.shutdown(),
        ])

        expect(stepMock).toHaveBeenCalledTimes(1)
        expect(r1.clean).toBe(true)
        expect(r2).toBe(r1)
        expect(r3).toBe(r1)
        expect(service.isShuttingDown()).toBe(false)
        expect(service.isComplete()).toBe(true)
        expect(service.isClean()).toBe(true)
        expect(service.getResult()).toEqual({ clean: true, failedSteps: [] })
    })

    it('returns the same cached result on repeated calls after completion without rerunning side effects', async () => {
        const stepMock = vi.fn()
        const service = new AppShutdownService()
        service.registerStep({ name: 'cached_step', run: stepMock })

        const firstResult = await service.shutdown()
        expect(stepMock).toHaveBeenCalledTimes(1)
        expect(firstResult.clean).toBe(true)

        const secondResult = await service.shutdown()
        expect(stepMock).toHaveBeenCalledTimes(1)
        expect(secondResult).toBe(firstResult)
    })

    it('handles synchronously reentrant shutdown call from within the first step without duplicate cleanup', async () => {
        const service = new AppShutdownService()
        const executionOrder: string[] = []
        let reentrantPromise: Promise<ShutdownResult> | null = null

        service.registerStep({
            name: 'reentrant_first_step',
            run: () => {
                executionOrder.push('step_1_start')
                // Synchronously call shutdown() again from inside step 1
                reentrantPromise = service.shutdown()
                executionOrder.push('step_1_end')
            },
        })

        service.registerStep({
            name: 'second_step',
            run: () => {
                executionOrder.push('step_2')
            },
        })

        const mainPromise = service.shutdown()
        await waitFor(() => reentrantPromise !== null)

        const [mainResult, reentrantResult] = await Promise.all([mainPromise, reentrantPromise!])

        expect(mainResult.clean).toBe(true)
        expect(reentrantResult).toBe(mainResult)
        expect(executionOrder).toEqual(['step_1_start', 'step_1_end', 'step_2'])
    })

    it('isolates failures so later steps still execute and marks clean=false with failed step names', async () => {
        const executedSteps: string[] = []
        const service = new AppShutdownService()

        service.registerStep({
            name: 'step_1',
            run: () => {
                executedSteps.push('step_1')
            },
        })

        service.registerStep({
            name: 'step_2_failing',
            run: () => {
                executedSteps.push('step_2_failing')
                throw new Error('Step 2 explosion')
            },
        })

        service.registerStep({
            name: 'step_3_failing_async',
            run: async () => {
                executedSteps.push('step_3_failing_async')
                throw new Error('Step 3 async rejection')
            },
        })

        service.registerStep({
            name: 'step_4_database',
            run: () => {
                executedSteps.push('step_4_database')
            },
        })

        const result = await service.shutdown()

        expect(executedSteps).toEqual([
            'step_1',
            'step_2_failing',
            'step_3_failing_async',
            'step_4_database',
        ])
        expect(result.clean).toBe(false)
        expect(result.failedSteps).toEqual(['step_2_failing', 'step_3_failing_async'])
        expect(service.isClean()).toBe(false)
    })

    it('marks step as failed and unclean when exceeding timeout without unhandled rejection', async () => {
        const executedSteps: string[] = []
        const service = new AppShutdownService()

        service.registerStep({
            name: 'hanging_step',
            timeoutMs: 30,
            run: async () => {
                executedSteps.push('hanging_step_started')
                await new Promise((r) => setTimeout(r, 200))
                executedSteps.push('hanging_step_finished')
            },
        })

        service.registerStep({
            name: 'subsequent_step',
            timeoutMs: 50,
            run: () => {
                executedSteps.push('subsequent_step')
            },
        })

        const result = await service.shutdown()

        expect(result.clean).toBe(false)
        expect(result.failedSteps).toEqual(['hanging_step'])
        expect(executedSteps).toContain('hanging_step_started')
        expect(executedSteps).toContain('subsequent_step')
    })
})

describe('registerLifecycleRouter', () => {
    class FakeLifecyclePort implements LifecyclePort {
        public readonly listeners: { [event: string]: Array<(...args: unknown[]) => void> } = {}
        public quitCalls = 0

        on(event: 'before-quit', listener: (event: EventWithPreventDefault) => void): void
        on(event: 'window-all-closed', listener: () => void): void
        on(event: 'will-quit', listener: (event: EventWithPreventDefault) => void): void
        on(event: string, listener: (...args: unknown[]) => void): void {
            if (!this.listeners[event]) {
                this.listeners[event] = []
            }
            this.listeners[event].push(listener)
        }

        quit(): void {
            this.quitCalls += 1
            // In Electron, calling app.quit() triggers before-quit if not prevented
            this.emit('before-quit', new FakeEvent())
        }

        emit(event: string, ...args: unknown[]): void {
            const handlers = this.listeners[event] || []
            for (const handler of handlers) {
                handler(...args)
            }
        }
    }

    class FakeEvent implements EventWithPreventDefault {
        public defaultPrevented = false
        preventDefault(): void {
            this.defaultPrevented = true
        }
    }

    it('intercepts before-quit, runs shutdown once, and calls quit when complete', async () => {
        const port = new FakeLifecyclePort()
        const shutdownService = new AppShutdownService()
        const stepOrder: string[] = []

        shutdownService.registerStep({
            name: 'cleanup_1',
            run: async () => {
                stepOrder.push('cleanup_1')
            },
        })

        let reportedResult: ShutdownResult | null = null
        registerLifecycleRouter({
            port,
            shutdownService,
            onShutdownComplete: (res) => {
                reportedResult = res
            },
        })

        const initialEvent = new FakeEvent()
        port.emit('before-quit', initialEvent)

        // Must synchronously prevent default on initial before-quit
        expect(initialEvent.defaultPrevented).toBe(true)
        expect(shutdownService.isShuttingDown()).toBe(true)

        // Wait for shutdown to complete and port.quit() to trigger second before-quit
        await waitFor(() => shutdownService.isComplete() && port.quitCalls === 1)

        expect(stepOrder).toEqual(['cleanup_1'])
        expect(reportedResult).toEqual({ clean: true, failedSteps: [] })
        expect(port.quitCalls).toBe(1)
        expect(shutdownService.isComplete()).toBe(true)

        // Verify that final before-quit event was allowed without preventDefault
        const finalEvent = new FakeEvent()
        port.emit('before-quit', finalEvent)
        expect(finalEvent.defaultPrevented).toBe(false)
    })

    it('routes window-all-closed to app.quit on non-Mac platforms', async () => {
        const port = new FakeLifecyclePort()
        const shutdownService = new AppShutdownService()
        const stepOrder: string[] = []

        shutdownService.registerStep({
            name: 'window_closed_cleanup',
            run: () => {
                stepOrder.push('done')
            },
        })

        let reportedClean: boolean | null = null
        registerLifecycleRouter({
            port,
            shutdownService,
            isMac: false,
            onShutdownComplete: (res) => {
                reportedClean = res.clean
            },
        })

        port.emit('window-all-closed')

        // window-all-closed routes through app.quit initially (quitCall 1), which emits before-quit,
        // runs single-flight cleanup, and triggers final app.quit (quitCall 2)
        await waitFor(() => shutdownService.isComplete() && port.quitCalls === 2)

        expect(stepOrder).toEqual(['done'])
        expect(reportedClean).toBe(true)
        expect(port.quitCalls).toBe(2)

        // Verify that final before-quit event (from the 2nd app.quit()) was allowed without preventDefault
        const finalEvent = new FakeEvent()
        port.emit('before-quit', finalEvent)
        expect(finalEvent.defaultPrevented).toBe(false)
    })

    it('does NOT route window-all-closed on macOS', () => {
        const port = new FakeLifecyclePort()
        const shutdownService = new AppShutdownService()

        registerLifecycleRouter({
            port,
            shutdownService,
            isMac: true,
        })

        port.emit('window-all-closed')
        expect(port.quitCalls).toBe(0)
        expect(shutdownService.isShuttingDown()).toBe(false)
    })

    it('reports clean=false to onShutdownComplete when a step fails, and still calls quit', async () => {
        const port = new FakeLifecyclePort()
        const shutdownService = new AppShutdownService()

        shutdownService.registerStep({
            name: 'failing_step',
            run: () => {
                throw new Error('Boom')
            },
        })

        let reportedResult: ShutdownResult | null = null
        registerLifecycleRouter({
            port,
            shutdownService,
            onShutdownComplete: (res) => {
                reportedResult = res
            },
        })

        const initialEvent = new FakeEvent()
        port.emit('before-quit', initialEvent)

        expect(initialEvent.defaultPrevented).toBe(true)

        await waitFor(() => shutdownService.isComplete() && port.quitCalls === 1)

        expect(reportedResult).toEqual({ clean: false, failedSteps: ['failing_step'] })
        expect(port.quitCalls).toBe(1)
    })

    it('triggers onWillQuit with clean=false if shutdown failed or was incomplete', () => {
        const port = new FakeLifecyclePort()
        const shutdownService = new AppShutdownService()

        let willQuitClean: boolean | null = null
        registerLifecycleRouter({
            port,
            shutdownService,
            onWillQuit: (isClean) => {
                willQuitClean = isClean
            },
        })

        port.emit('will-quit')
        expect(willQuitClean).toBe(false)
    })

    it('handles throwing logger when router catches hook error without crashing or unhandled rejection', async () => {
        const port = new FakeLifecyclePort()
        const shutdownService = new AppShutdownService()

        shutdownService.registerStep({
            name: 'normal_step',
            run: () => {},
        })

        const throwingLogger = vi.fn().mockImplementation(() => {
            throw new Error('Logger exploded')
        })

        const throwingCallback = vi.fn().mockImplementation(() => {
            throw new Error('Callback hook failed')
        })

        registerLifecycleRouter({
            port,
            shutdownService,
            onShutdownComplete: throwingCallback,
            logger: throwingLogger,
        })

        const initialEvent = new FakeEvent()
        port.emit('before-quit', initialEvent)

        await waitFor(() => shutdownService.isComplete() && port.quitCalls === 1)

        expect(shutdownService.isComplete()).toBe(true)
        expect(throwingCallback).toHaveBeenCalledTimes(1)
        expect(throwingLogger).toHaveBeenCalled()
        expect(port.quitCalls).toBe(1)
    })

    it('handles throwing onShutdownComplete without stranding final quit or throwing unhandled rejection', async () => {
        const port = new FakeLifecyclePort()
        const shutdownService = new AppShutdownService()

        shutdownService.registerStep({
            name: 'normal_step',
            run: () => {},
        })

        const throwingCallback = vi.fn().mockImplementation(() => {
            throw new Error('onShutdownComplete crashed')
        })

        registerLifecycleRouter({
            port,
            shutdownService,
            onShutdownComplete: throwingCallback,
        })

        const initialEvent = new FakeEvent()
        port.emit('before-quit', initialEvent)

        await waitFor(() => shutdownService.isComplete() && port.quitCalls === 1)

        expect(throwingCallback).toHaveBeenCalledTimes(1)
        expect(port.quitCalls).toBe(1)
        expect(shutdownService.isComplete()).toBe(true)
    })
})
